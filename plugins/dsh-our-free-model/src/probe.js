/**
 * Availability probing.
 *
 * The gateway does not disclose which models this egress may use: the model
 * listing is a flat id list, and exclusion only appears when a request is
 * refused with a `RegionError`. Availability is therefore established by asking,
 * with the smallest request that can produce a verdict.
 *
 * LOCAL-FIRST FORK: the upstream plugin also watched the machine's public egress
 * address by calling third-party IP-echo services every two minutes, to
 * auto-reclassify region-gated models when the user switched networks. That was
 * three extra third parties told this machine's public IP, for a convenience the
 * user can get by pressing the "re-probe availability" button. This fork removes
 * it: there is no egress detection and no outbound call beyond the gateway this
 * plugin exists to talk to. (The removed echo hosts are deliberately not named
 * here — `scripts/local-first-test.mjs` fails the build if any of them reappears
 * anywhere in the shipped source, comments included.)
 *
 * The availability probe itself stays, because it only ever talks to that same
 * gateway.
 *
 * @module src/probe.js
 */

import { applyFingerprint, endpointFor, mintRequestId, sessionForConversation, wireFor } from './upstream.js'
import { CODE, postStreamed } from './http.js'

/** Verdicts the probe can return, and how each maps to picker membership. */
export const STATE = {
  available: 'available',
  regionBlocked: 'region-blocked',
  unavailable: 'unavailable',
  throttled: 'throttled',
  unknown: 'unknown',
}

const PING_PROMPT = 'ping'

/**
 * Ask the gateway for one model, once.
 *
 * @param {object} model - catalog entry
 * @param {object} options
 * @param {string} [options.attributionUserAgent]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{state:string, detail?:string, latencyMs:number, ttftMs?:number}>}
 */
export async function probeModel(model, { attributionUserAgent, signal, timeoutMs = 45000 } = {}) {
  const started = Date.now()
  const session = sessionForConversation('probe:our-free-model')
  const wire = wireFor(model.id)
  const body = buildPing(model.id, wire)
  applyFingerprint(body, wire === 'responses')

  let firstDelta
  try {
    await postStreamed({
      path: endpointFor(model.id),
      body,
      session,
      requestId: mintRequestId(),
      attributionUserAgent,
      signal,
      timeoutMs,
      onData: payload => {
        if (firstDelta !== undefined) return
        if (/"(delta|content|text|output_item)"|response\.(output_item|output_text|function_call)/.test(payload)) firstDelta = Date.now()
      },
    })
    return { state: STATE.available, latencyMs: Date.now() - started, ttftMs: firstDelta === undefined ? undefined : firstDelta - started }
  } catch (error) {
    return {
      state: stateOf(error),
      detail: typeof error?.message === 'string' ? error.message.slice(0, 200) : String(error),
      latencyMs: Date.now() - started,
    }
  }
}

function buildPing(modelId, wire) {
  if (wire === 'responses') {
    return {
      model: modelId,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PING_PROMPT }] }],
      stream: true,
      store: false,
      max_output_tokens: 16,
    }
  }
  if (wire === 'messages') {
    return {
      model: modelId,
      messages: [{ role: 'user', content: PING_PROMPT }],
      stream: true,
      max_tokens: 16,
    }
  }
  return { model: modelId, messages: [{ role: 'user', content: PING_PROMPT }], stream: true, max_tokens: 16 }
}

/**
 * Map one probe failure onto a verdict.
 *
 * The line that matters is whether the gateway *named this model as something it
 * will not route*. Only those readings come from the answer itself: a refusal
 * whose message is about the model (`Model is unavailable`, `not supported`,
 * `no such model`), or a status whose whole meaning is the identifier in the body
 * we sent — 400 for a model it rejects, 404 for one it no longer has, 422 for a
 * route that refuses the pair. Those read as unavailable and the picker drops the
 * model.
 *
 * Everything else says nothing about the model and must not move it:
 * - 5xx, including 503, is the gateway's own trouble. It is the single most
 *   common thing an overloaded pooled account says, and this lane's own history
 *   has it returning 5xx for reasons that had nothing to do with the model
 *   (`src/effort.js` records an upstream 503 from an unknown request field).
 *   Its *words* must not be read as a verdict either: a reverse proxy answers a
 *   503 with the reason phrase "Service Unavailable", and matching that text
 *   took a working model out of the picker.
 * - 401/403/407 is the pooled credential, and 408/425/429 is capacity or
 *   transport — the next window can answer.
 * - no status at all (transport, abort, timeout, a stream that died before any
 *   header) means no answer was received.
 *
 * The asymmetry is deliberate: a stale entry in the picker costs the user one
 * failed turn they can retry, while a model that vanished on a hiccup costs the
 * `reprobe`-then-wait cycle the user has no visibility into.
 */
const ROUTING_REFUSAL_STATUS = new Set([400, 404, 422])

function stateOf(error) {
  switch (error?.code) {
    case CODE.region: return STATE.regionBlocked
    case CODE.quota: return STATE.throttled
    default: break
  }
  const message = String(error?.message ?? '')
  // The message match is a fallback for a refusal the classifier did not name
  // ("no such model", "unknown model"), so it may only speak when the status did
  // not already answer on the gateway's behalf: 503 is spelled "Service
  // Unavailable" by every reverse proxy, and reading that reason phrase as the
  // gateway naming this model dropped a working model until the next round.
  const gatewayTrouble = Number.isInteger(error?.status) && error.status >= 500
  const named = error?.unavailable === true
    || (!gatewayTrouble && /unavailable|not supported|no such model|unknown model|invalid model/i.test(message))
  if (named) return STATE.unavailable
  if (Number.isInteger(error?.status) && ROUTING_REFUSAL_STATUS.has(error.status)) return STATE.unavailable
  return STATE.unknown
}

/**
 * Egress detection was removed in this fork.
 *
 * Retained as an explicit, documented no-op rather than deleted outright so the
 * callers' structure stays readable and so anyone reading the source sees the
 * decision rather than an absence. It never touches the network, and it answers
 * `undefined`, which every caller treats as "no egress signal" — exactly the
 * fail-open path the upstream code already had for a network failure.
 *
 * @returns {Promise<undefined>}
 */
export async function detectEgress() {
  return undefined
}

/**
 * Probe a whole catalog with a bounded fan-out.
 *
 * Concurrency stays low on purpose: this lane accounts quota per session and
 * answers 429 with growing retry-after, so a wide burst would throttle the very
 * user whose availability we are establishing.
 */
export async function probeCatalog(models, options = {}, onResult = () => {}, concurrency = 2) {
  const results = {}
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, models.length)) }, async () => {
    while (cursor < models.length) {
      const index = cursor++
      const model = models[index]
      const result = await probeModel(model, options)
      results[model.id] = result
      onResult(model.id, result)
    }
  })
  await Promise.all(workers)
  return results
}
