/**
 * Our Free Model — plugin entry (Host half).
 *
 * LOCAL-FIRST FORK — what changed, and why.
 *
 * The upstream plugin shipped a small distribution channel of its own on top of
 * the model lane: a remote announcement feed the repository owner published by
 * pushing a JSON document, an in-app self-updater that downloaded and replaced
 * the running code from that same repository, and a self hot-reload that swapped
 * the live plugin for whatever bytes were on disk. All three were authorised by
 * nothing but HTTPS to the owner's account, and the integrity check covered only
 * transport damage, never who published. Anyone who could reach that repository
 * — or its CDN, or the TLS path to it — could therefore ship code that this
 * machine would verify, install and execute.
 *
 * This fork removes that relationship. The plugin now has exactly two kinds of
 * outbound traffic, both to destinations you chose by installing it:
 *
 *   1. model requests to the gateway (`https://opencode.ai`), which is the
 *      plugin's entire reason to exist;
 *   2. nothing else. No update check, no manifest, no announcement poll, no IP
 *      echo service.
 *
 * Concretely removed: the self-updater, the hot reload and its file watcher, the
 * remote feed and its cache, the `feedUrl` override (a single setting that could
 * redirect both the feed and the update manifest at any host), the periodic
 * catalog and egress refresh loops, and the `/update/*`, `/reload`, and
 * `/refresh`-driven network paths.
 *
 * What is left is a plugin that serves models, measures them, and stays put.
 * The model roster is compiled in ({@link STATIC_MODEL_IDS}); announcements are
 * read from a local file you own; everything it writes is under the plugin's own
 * data directory.
 *
 * Wiring: one adapter instance, two provider routes (usable now / region-limited
 * on this egress), the availability-probe loop behind them, the browser-facing
 * JSON API the settings page reads, and the OpenAI-compatible forward listener.
 *
 * Every harness facility is reached through `ctx`, and only the one the plugin
 * cannot exist without is declared in `inject`, so a composition that omits the
 * rest degrades a feature rather than failing the plugin. See `inject` below.
 *
 * @module index.js
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FreeModelAdapter, ROUTE_LABELS, ROUTE_MAIN, ROUTE_REGION } from './src/adapter.js'
import { JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, DATA_DIR_NAME, MIN_DECODE_MS, decodeWindow, migrateStats, pruneDays, recordUsage, resolveDshHome } from './src/store.js'
import { STATIC_MODEL_IDS, buildCatalog } from './src/catalog.js'
import { STATE, probeCatalog } from './src/probe.js'
import { generateKey, startForwardServer, toOpenAiUsage } from './src/forward.js'
import { CODE, UpstreamError } from './src/http.js'
import { DEFAULT_LEVEL, budgetLadder } from './src/effort.js'
import { toToolDefs } from './src/messages.js'
import { windowTokens } from './src/stream.js'
import { AnnouncementFeed } from './src/feed.js'
import { createPushHub } from './src/push.js'
import { rejectionFor, isLoopbackHost } from './src/trust.js'
import { resolveAttributionUserAgent } from './adapter/kernel.js'

export const name = 'our-free-model'

/** The installed package directory. Read-only in this fork — nothing rewrites it. */
const PKG_URL = new URL('./', import.meta.url)
const PKG_DIR = fileURLToPath(PKG_URL)

/** Published version of the installed package, read once at load. */
function readPackageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

/**
 * `llm` is what the plugin exists for, so it is the only hard requirement of the
 * plugin itself.
 *
 * Cordis withholds from a context any service its fiber does not name in
 * `inject`, and keeps that fiber PENDING while a named one is absent — which is
 * how v1.2.1 stayed permanently inactive on a composition with no HTTP server,
 * the surface issue #4 reported. So nothing else may be named here: a headless
 * composition would rather serve models without a settings page than serve
 * nothing.
 *
 * What that costs and what still works:
 * - `webServer` — the in-app dashboard and the SSE push channel. Reached through
 *   a nested `ctx.inject` fiber (see the browser-facing API section), which pends
 *   on its own and never blocks the lane above.
 * - `timer` (`ctx.interval`) — nothing. The background loops are plain unref'd
 *   timers (see `every`), because reading a mixin off an undeclared service
 *   throws rather than answering `undefined`.
 * - `connection`, `attachments` — one feature each: the fence falls back to its
 *   structural replica, image blocks to the text projection. Both are read with
 *   `ctx.get()`, which is the opportunistic lookup that answers `undefined`.
 */
export const inject = ['llm']

/**
 * The model roster, compiled in.
 *
 * This is the ONLY source of catalog entries in this fork — there is no listing
 * fetch and no cached-remote-list store to fall back to. An entry is a menu item,
 * not a promise: the gateway still has to accept the id at request time.
 */
const STATIC_CATALOG = buildCatalog(STATIC_MODEL_IDS)

/** Where the plugin's own announcement copy lives; bump it to re-announce. */
export const ANNOUNCEMENT_VERSION = '2026-09-25.1'

/**
 * The distribution channel this fork used to have is gone.
 *
 * Upstream kept a `self` / `managed` split so that a distribution pack could
 * stop the plugin from rewriting its own installed bytes. Nothing rewrites them
 * any more, so the distinction has no work left to do: there is no updater to
 * stand down, no announcement channel that publishes, and no hot reload. The
 * value is still reported to the settings page (as the constant `local`) so the
 * UI keeps a truthful label for where its bytes came from.
 */
const DISTRIBUTION = 'local'

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.join(home, DATA_DIR_NAME)
  fs.mkdirSync(dataDir, { recursive: true })
  const packageVersion = readPackageVersion()

  const settings = new JsonStore(path.join(dataDir, 'settings.json'), SETTINGS_INITIAL)
  const stats = new JsonStore(path.join(dataDir, 'stats.json'), STATS_INITIAL)
  const availability = new JsonStore(path.join(dataDir, 'availability.json'), { version: 1, at: 0, egress: null, results: {} })

  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)

  /** The catalog is a constant; there is no store behind it and no refresh. */
  const catalog = STATIC_CATALOG

  /** `local` is reported so the page can say where the bytes came from. */
  const distribution = DISTRIBUTION

  let attributionUserAgent = 'deepseek-harness'
  let forward = null
  let forwardError = ''

  // ── push channel ────────────────────────────────────────────────────────────
  const push = createPushHub({ logger })

  /** Set of announcement ids the user has acknowledged. */
  const ackedIds = () => new Set(Array.isArray(settings.get().announcementsAcked) ? settings.get().announcementsAcked : [])

  /**
   * Announcements come from a local file the user owns.
   *
   * The upstream feed cached remote bytes in `feed.json`; there is no remote
   * copy to cache any more, so the reader points straight at
   * `announcements.json` in the plugin's own data directory. The installer seeds
   * it; the user may edit or delete it freely.
   */
  const ANNOUNCEMENTS_FILE = path.join(dataDir, 'announcements.json')

  const feed = new AnnouncementFeed({
    file: ANNOUNCEMENTS_FILE,
    onArrival: items => { push.emit('announcements', { items, unread: feedView().unread }) },
    log: message => logger.info?.(message),
  })
  feed.load()

  /** The announcement view the settings page reads. */
  function feedView() {
    return feed.view({ ackedIds: ackedIds() })
  }

  /** Set when this generation is disposed; late async callbacks must stand down. */
  let disposed = false

  /** The immutable snapshot every adapter call binds to. */
  const state = () => ({
    catalog,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
  })

  /** A turn refused for geography means the egress moved; re-classify promptly. */
  let reprobeTimer
  function scheduleReprobe() {
    if (reprobeTimer !== undefined) return
    reprobeTimer = setTimeout(() => {
      reprobeTimer = undefined
      void refreshAvailability().catch(() => {})
    }, 4000)
    reprobeTimer.unref?.()
  }

  const adapter = new FreeModelAdapter({
    state,
    resolveImage: imageResolver(ctx, logger),
    recordUsage: record => {
      recordUsage(stats, record)
      stats.edit(state => pruneDays(state, 120))
    },
    warn: message => logger.warn?.(message) ?? logger.log?.(message),
    onRegionBlocked: () => scheduleReprobe(),
  })

  // ── registration ────────────────────────────────────────────────────────────
  const routes = () => Object.keys(computeMembership(catalog, availability.get(), settings.get()))
  const registration = ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: ROUTE_MAIN, displayName: ROUTE_LABELS[ROUTE_MAIN], settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [] },
  ])

  // Advertise a probe endpoint for the in-app "detect models" button. It offers
  // what the picker itself advertises — a model the gateway refuses to route at
  // all must not be addable to a profile just because it still appears in the
  // upstream listing.
  ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => {
    await refreshCatalog({ probe: true })
    const advertised = new Set(Object.values(state().membership).flat())
    return catalog
      .filter(entry => advertised.has(entry.id))
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxOutput,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
  })

  ctx.on?.('loader/volatile-update', () => {
    registration.replace(routes())
  })

  // ── catalog + availability ──────────────────────────────────────────────────
  /**
   * "Refresh" now means one thing only: re-probe availability.
   *
   * The upstream version began by fetching `/zen/v1/models` and rebuilding the
   * roster from whatever came back. There is no such fetch here — the roster is
   * compiled in — so this function keeps its name for the settings button and
   * the API routes, and does the half that was ever locally verifiable.
   */
  async function refreshCatalog({ probe = true } = {}) {
    if (probe) await refreshAvailability()
    emitTopology()
    return catalog
  }

  async function runProbeRound() {
    const results = await probeCatalog(catalog, { attributionUserAgent }, (id, result) => {
      availability.edit(state => ({ ...state, results: { ...state.results, [id]: { state: result.state, ...result.detail === undefined ? {} : { detail: result.detail }, ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs }, latencyMs: result.latencyMs, at: Date.now() } } }))
    }, 2)
    availability.update({ at: Date.now() })
    availability.flush()
    // Say it out loud when a round refuses everything: `computeMembership` keeps
    // the roster advertised in that case, and without this line the log would
    // read as a healthy probe while the gateway was turning every model down.
    const verdicts = Object.values(results)
    if (verdicts.length > 0 && verdicts.every(row => row.state === STATE.unavailable)) {
      logger.warn?.(`our-free-model: the gateway refused all ${verdicts.length} models this round (${verdicts[0].detail ?? 'no detail'}); keeping them advertised`)
    }
    emitTopology()
    return results
  }

  /**
   * One probe round at a time, for every caller.
   *
   * Three things start a round: the periodic loop, a mid-turn `RegionError`, and
   * the settings page's buttons. Each awaited a fresh `probeCatalog`, so a slow
   * round and a trigger arriving during it ran whole rosters side by side —
   * against a lane whose 429 carries a growing `retry-after`, that is the user's
   * own quota spent on the same question. A caller that arrives mid-round joins
   * the round in flight instead of starting another.
   */
  let probeRound = null
  async function refreshAvailability() {
    if (probeRound !== null) return probeRound
    const round = runProbeRound()
    probeRound = round
    try {
      return await round
    } finally {
      if (probeRound === round) probeRound = null
    }
  }


  // Egress watching was removed in this fork: it called third-party IP-echo
  // services every two minutes to learn this machine's public address. The
  // "re-probe availability" button covers the case it existed for, without
  // telling three strangers where you are.

  // ── forward listener ────────────────────────────────────────────────────────
  async function syncForward() {
    const desired = settings.get().forward ?? {}
    const wanted = desired.enabled === true
    // A listener already bound where the settings want it is left alone. Two
    // callers reconcile the same state — the boot refresh and every settings
    // POST — and the second one used to close and re-bind the port anyway,
    // resetting whatever request was in flight on the old socket.
    if (forward !== null && wanted
      && forward.host === (desired.host || '127.0.0.1')
      && forward.port === (Number.isFinite(Number(desired.port)) ? Number(desired.port) : 0)) return
    if (forward === null && !wanted) return
    if (forward !== null) {
      const closing = forward
      forward = null
      await closing.close().catch(() => {})
    }
    if (!wanted) {
      forwardError = ''
      return
    }
    // Checked again here, not only where the settings page posts: a headless
    // composition has no page to click, and `settings.json` is the way in. A
    // routable bind would spend this machine's free lane on the whole subnet.
    if (!isLoopbackHost(desired.host || '127.0.0.1')) {
      forwardError = 'the forward listener binds a loopback address only'
      logger.warn?.(`our-free-model: forward listener not started (${forwardError})`)
      return
    }
    try {
      forward = await startForwardServer({
        config: () => {
          const current = settings.get().forward ?? {}
          return { host: current.host || '127.0.0.1', port: current.port ?? 0, enabled: current.enabled === true, key: forwardKey() }
        },
        complete: (request, onChunk) => runForwarded(request, onChunk),
        modelRows: () => publicModelRows(),
        log: message => logger.warn?.(`our-free-model forward: ${message}`),
      })
      forwardError = ''
      settings.update({ forward: { ...desired, port: forward.port, host: desired.host || '127.0.0.1' } })
      settings.flush()
    } catch (error) {
      forwardError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: forward listener could not start (${forwardError})`)
    }
  }

  function forwardKey() {
    const current = settings.get()
    if (typeof current.forwardKey === 'string' && current.forwardKey !== '') return current.forwardKey
    const minted = generateKey()
    settings.update({ forwardKey: minted })
    settings.flush()
    return minted
  }

  /**
   * Run one forwarded OpenAI request through the adapter.
   *
   * The caller's spelling is translated into harness messages, and the resulting
   * chunk stream is handed straight back to the caller's callback while an
   * outcome summary accumulates for the non-streaming path.
   */
  async function runForwarded(request, onChunk) {
    const entry = catalog.find(candidate => candidate.id === request.model)
    if (entry === undefined) throw new UpstreamError(`unknown model "${request.model}"`, CODE.server)
    const openAi = request.openAi ?? {}
    const messages = fromOpenAiMessages(openAi, request.responses === true)
    const tools = toToolDefs((openAi.tools ?? []).map(normalizeTool).filter(Boolean), request.responses === true ? 'flat' : 'chat')
    const handler = typeof onChunk === 'function' ? onChunk : () => {}
    const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }

    const options = {
      provider: ROUTE_MAIN,
      model: entry.id,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      ...typeof openAi.temperature === 'number' ? { temperature: openAi.temperature } : {},
      ...typeof openAi.max_tokens === 'number' ? { maxTokens: openAi.max_tokens } : {},
      ...typeof openAi.reasoning_effort === 'string' ? { reasoningEffort: openAi.reasoning_effort } : {},
      sessionId: `forward:${String(openAi.user ?? openAi.conversation ?? 'shared')}`,
    }

    for await (const chunk of adapter.stream(options, entry, state())) {
      handler(chunk)
      foldForwardOutcome(outcome, chunk)
    }
    // A max-tokens finish means the adapter judged a tool call unexecutable
    // (arguments cut mid-JSON); keep the OpenAI answer consistent with its
    // finish_reason by not reporting the broken call alongside `length`.
    if (outcome.truncated === true) {
      outcome.toolCalls = outcome.toolCalls.filter(call => {
        try { JSON.parse(call.arguments === '' ? '{}' : call.arguments); return true } catch { return false }
      })
    }
    return outcome
  }

  function publicModelRows() {
    const membership = new Set(state().membership[ROUTE_MAIN] ?? [])
    if (settings.get().exposeRegionModels !== false) for (const id of state().membership[ROUTE_REGION] ?? []) membership.add(id)
    return catalog
      .filter(entry => membership.has(entry.id))
      .map(entry => ({
        id: entry.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'our-free-model',
        ...entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow },
      }))
  }

  // ── self-modification: removed ──────────────────────────────────────────────
  //
  // The upstream plugin could replace its own installed code and swap itself into
  // the running process, either on demand (`/reload`, `/update/apply`) or by
  // watching its own directory. Both paths are gone in this fork, along with the
  // updater that fed them. The consequence worth stating plainly: **this plugin
  // never writes to its own package directory.** Upgrading it means replacing the
  // folder yourself, which is the point — the code that runs is the code you
  // installed.

  // ── browser-facing API ──────────────────────────────────────────────────────
  /**
   * Read a service the composition may or may not mount.
   *
   * `ctx.get` is cordis' opportunistic lookup: it answers `undefined` instead of
   * throwing when the service is absent — and also while it is merely not
   * provided yet, which matters because plugins load before the browser half has
   * published anything. So a service read this way is a snapshot: `connection` is
   * therefore resolved per request below, and `webServer` gets its own fiber (see
   * the `ctx.inject` at the end of this section).
   */
  const optional = service => (typeof ctx.get === 'function' ? ctx.get(service) : undefined)
  /**
   * The trust fence's view of the connection service, looked up per request.
   *
   * The browser half publishes `connection` after plugins have loaded, so reading
   * it once here would freeze in "absent" and leave every request on the replica
   * fence for the life of the process. The getter answers `undefined` — not a
   * no-op function — while the service is missing, which is what makes the fence
   * fall through to its own structural check instead of reading as "admitted".
   */
  const fenceConnection = {
    get admit() {
      const current = optional('connection')
      return current === undefined ? undefined : (req => current.admit(req))
    },
  }
  const api = createApiRoutes({
    settings, stats, availability, catalog: () => catalog, state,
    refreshCatalog, refreshAvailability, syncForward,
    forwardInfo: () => ({ running: forward !== null, port: forward?.port ?? 0, error: forwardError, egress: null }),
    rotateKey: () => {
      const minted = generateKey()
      settings.update({ forwardKey: minted })
      settings.flush()
      return minted
    },
    testModel: async (id, effort) => {
      const entry = catalog.find(candidate => candidate.id === id)
      if (entry === undefined) throw new UpstreamError(`unknown model "${id}"`, CODE.server)
      const started = Date.now()
      let firstFrame
      let sawReasoning = false
      let text = ''
      let usage
      for await (const chunk of adapter.stream({
        provider: ROUTE_MAIN,
        model: entry.id,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoningEffort: effort === undefined || effort === '' ? DEFAULT_LEVEL : effort,
        sessionId: `bench:${entry.id}:${effort ?? DEFAULT_LEVEL}`,
      }, entry, state())) {
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
          if (firstFrame === undefined) firstFrame = Date.now()
          if (chunk.type === 'reasoning-delta') sawReasoning = true
          if (chunk.type === 'text-delta') text += chunk.text
        }
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'tool-calls') {
          throw new UpstreamError(chunk.reason.failure?.message ?? chunk.reason.kind, chunk.reason.failure?.code ?? CODE.server)
        }
      }
      const ms = Date.now() - started
      // Same rule as the recorded calls: the rate divides only by a window that
      // actually covers the tokens in its numerator.
      const measured = decodeWindow(firstFrame === undefined ? 0 : ms - firstFrame, windowTokens(usage, sawReasoning), true)
      return {
        model: entry.id, effort: effort ?? DEFAULT_LEVEL, ok: true,
        totalMs: ms,
        ttftMs: firstFrame === undefined ? ms : firstFrame - started,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        tokensPerSecond: measured.tps,
        sample: text.slice(0, 60),
      }
    },
    meta: () => ({
      version: packageVersion,
      distribution,
      dataDir,
      announcementsFile: ANNOUNCEMENTS_FILE,
      staticCatalog: true,
    }),
    announcements: {
      view: feedView,
      /** Persist the complete acked set the caller assembled (full-replace
       *  semantics: the caller decides additions *and* clearings). */
      ack: ids => {
        settings.update({ announcementsAcked: [...ids] })
        settings.flush()
        return feedView()
      },
      /** Re-read the LOCAL file. No network call exists behind this. */
      refresh: () => feed.poll(),
    },
    push,
    connection: fenceConnection,
    logger,
  })

  // The dashboard half runs in its own fiber so that a composition without an
  // HTTP server cannot take the model lane down with it.
  //
  // `ctx.inject(deps, callback)` is cordis' "run this once these services exist":
  // the callback pends while `webServer` is absent *or merely not provided yet*,
  // and is re-run if the service is replaced. That pending is the whole point —
  // reading `ctx.get('webServer')` once at apply time answered `undefined` in the
  // real web composition (plugins load before the browser half publishes it), the
  // routes never registered, and the settings page had no data source while a web
  // server was busy serving it.
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/our-free-model', handler: api }), 'our-free-model: api routes')
    // The events stream is an exact route: exact dispatch outranks the prefix, so
    // the hub's handler owns the socket while every other path still lands on the
    // JSON API.
    scoped.effect(() => server.register({ kind: 'exact', path: '/api/our-free-model/events', handler: eventsRoute }), 'our-free-model: events stream')
    logger.info?.('our-free-model: settings API mounted at /api/our-free-model')
  })

  /** Adopt one request as a live push stream, after the trust fence. */
  function eventsRoute(req, res) {
    const rejection = rejectionFor(req, fenceConnection)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    push.attach(req, res, helloPayload())
  }

  function helloPayload() {
    return {
      version: packageVersion,
      announcements: { unread: feedView().unread, fetchedAt: feedView().fetchedAt },
      distribution,
    }
  }

  // ── boot + background loop ──────────────────────────────────────────────────
  ctx.effect(() => () => {
    settings.dispose(); stats.dispose(); availability.dispose()
  }, 'our-free-model: stores')

  ctx.effect(() => () => {
    void forward?.close().catch(() => {})
  }, 'our-free-model: forward listener')

  ctx.effect(() => () => { registration() }, 'our-free-model: adapter routes')

  ctx.effect(() => () => {
    disposed = true
    push.dispose()
  }, 'our-free-model: push')

  ctx.effect(() => {
    void (async () => {
      attributionUserAgent = await resolveAttributionUserAgent(logger)
      // Read the local announcements file once, then probe availability. No
      // listing fetch happens here: the roster is compiled in.
      await feed.poll()
      await refreshCatalog({ probe: true })
      await syncForward()
      emitTopology()
      push.emit('hello', helloPayload())
    })().catch(error => logger.warn?.(`our-free-model: startup refresh failed (${error?.message ?? error})`))
  }, 'our-free-model: boot refresh')

  /**
   * Run one task every `ms` for as long as this generation lives.
   *
   * A plain unref'd timer chain, on purpose. `ctx.interval` is a mixin over the
   * `timer` service, and reading it from a fiber that did not name `timer` in
   * `inject` throws inside the real cordis proxy (`cannot get property "timer"
   * without inject`) instead of answering `undefined` — that one read is what
   * stopped the whole plugin from activating. `timer` is not worth declaring on a
   * headless composition, and the mixin adds nothing here beyond `setTimeout` plus
   * a disposer: it must not hold the process open, and `disposed` ends it when the
   * fiber goes away. Without this loop the availability probe would run once at
   * boot, so a model that throttled, recovered, or moved behind the region gate
   * would keep the picker position it was first given.
   */
  function every(task, ms) {
    let handle = setTimeout(function tick() {
      if (disposed) return
      task()
      handle = setTimeout(tick, ms)
      handle.unref?.()
    }, ms)
    handle.unref?.()
    ctx.effect(() => () => clearTimeout(handle), 'our-free-model: interval')
  }

  // The one remaining background loop: re-probe availability against the
  // gateway. The upstream plugin also had a feed-poll loop and an update-check
  // loop on this timer; both were network calls to the owner and both are gone.
  //
  // The period is in minutes, and one minute is the floor — a value of 0 or a
  // negative one would otherwise spin.
  every(() => {
    void refreshCatalog({ probe: true })
      .catch(error => logger.warn?.(`our-free-model: periodic probe failed (${error?.message ?? error})`))
  }, positiveOr(settings.get().probeIntervalMinutes, 15, 1) * 60_000)

  function emitTopology() {
    try { ctx.emit?.('llm/adapters-updated') } catch { /* no listener surface */ }
    registration.replace(routes())
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * A period that cannot become a hot loop.
 *
 * `setTimeout(fn, NaN)` is `setTimeout(fn, 1)` in Node, and a settings file the
 * user edits by hand (the only way in on a headless composition) can carry
 * anything. The probe timer takes its period from a stored number, so the guard
 * belongs here rather than in each caller.
 */
function positiveOr(value, fallback, floor = 1) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(floor, Math.trunc(number))
}

/**
 * Coerce the settings a timer or the wire reads.
 *
 * The settings page's own cleared input field posts `0`: on the output ceiling
 * that read as `min(model capacity, 0)` and every turn came back capped at the
 * 512-token floor, and on a period it asked for a probe round a minute. A value
 * that is not a positive number is "the user did not set one", so it falls back
 * to what ships rather than being clamped into an extreme.
 */
function sanitizeSettings(patch, current) {
  const next = { ...patch }
  const positive = (key, fallback) => {
    if (next[key] === undefined) return
    const value = Number(next[key])
    next[key] = Number.isFinite(value) && value > 0 ? Math.trunc(value) : (Number(current[key]) || fallback)
  }
  positive('probeIntervalMinutes', 15)
  positive('defaultMaxTokens', 32768)
  return next
}

/**
 * Which route advertises which model, given the last probe.
 *
 * Region-gated models move to their dedicated route, and only while the user
 * wants them shown. Everything else sits on the main route, including models a
 * probe could not reach this round — a call that never got an answer is not a
 * verdict, and a flaky network must not empty the picker.
 *
 * A model the gateway named in its listing but refused to route at all is the
 * exception: it cannot answer any prompt, so advertising it trades the user's
 * turn for a guaranteed failure. Those come out of both routes until a later
 * probe reverses the verdict, which the periodic re-probe does by itself if the
 * lane brings the id back.
 *
 * A catalog entry with no verdict at all is normal, not an edge case: a fresh
 * install has no probe history until the boot round lands (one ping per model,
 * two at a time, each with a 45 second budget), and a model the listing just
 * added has none until the next one does. Such an entry is advertised — not
 * knowing is not the same as knowing it is refused.
 *
 * The one thing that may never happen is an empty result. Every model failing
 * the same way means the lane or the client fingerprint is broken, not that the
 * whole roster went away, and a picker with no models at all is worse than one
 * with a stale entry — so a round that refused everything is ignored, geography
 * grouping and all.
 */
function computeMembership(catalog, availabilitySnapshot, settings) {
  const results = availabilitySnapshot?.results ?? {}
  const expose = settings?.exposeRegionModels !== false
  const verdictOf = entry => results[entry.id]?.state
  let usable = catalog.filter(entry => verdictOf(entry) !== STATE.unavailable)
  if (catalog.length > 0 && usable.length === 0) usable = catalog
  const main = []
  const region = []
  for (const entry of usable) {
    const verdict = verdictOf(entry)
    if (verdict !== STATE.regionBlocked) main.push(entry.id)
    else if (expose) region.push(entry.id)
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}

/**
 * Resolve an image attachment into a data URL the provider can accept.
 *
 * The attachment service exposes a host path, not bytes; reading it here keeps the
 * plugin free of a second credential path. An unresolvable image is reported as a
 * warning and dropped — the runtime has already text-projected files, and a
 * text-only model never sees an image block in the first place.
 */
function imageResolver(ctx, logger) {
  if (typeof ctx.get !== 'function') return undefined
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return ref => {
    // Looked up per call, not once at apply time: this is the third instance of
    // the same cordis trap the release note describes for `webServer` and
    // `connection` — a service that plugins load before is not provided yet, so a
    // one-shot read silently cost the whole feature (here: image attachments,
    // with nothing in the log to say so).
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) { logger.warn?.(`our-free-model: image ${id} is ${size} bytes, above the ${MAX_IMAGE_BYTES} send limit`); return undefined }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`our-free-model: could not read image ${id} (${error?.message ?? error})`)
      return undefined
    }
  }
}

/** OpenAI request messages -> harness messages, for the forward listener. */
function fromOpenAiMessages(body, isResponses) {
  const out = []
  const rows = isResponses
    ? normaliseResponsesInput(body.input)
    : (Array.isArray(body.messages) ? body.messages : [])
  for (const row of rows) {
    const role = row.role ?? 'user'
    const content = []
    if (typeof row.content === 'string') {
      if (row.content !== '') content.push({ type: 'text', text: row.content })
    } else if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (typeof part === 'string') { if (part !== '') content.push({ type: 'text', text: part }); continue }
        const text = part?.text ?? part?.input_text ?? part?.output_text
        if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
        const image = part?.image_url?.url ?? part?.image_url
        if (typeof image === 'string' && image !== '') {
          content.push({ type: 'image', attachment: { attachmentId: `url:${image.slice(0, 64)}`, mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: image } })
        }
      }
    }
    if (role === 'tool') {
      out.push({ role: 'tool', content: [{ type: 'text', text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '') }], toolCallId: row.tool_call_id ?? '', source: { kind: 'tool', callId: row.tool_call_id ?? '' } })
      continue
    }
    if (role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        content.push({ type: 'tool-call', id: call.id ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' })
      }
    }
    if (content.length === 0) continue
    out.push({
      role: role === 'developer' ? 'developer' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
      content,
      ...role === 'assistant' ? { source: { kind: 'model' } } : {},
    })
  }
  return out
}

function normaliseResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  return input.map(row => {
    if (typeof row === 'string') return { role: 'user', content: row }
    if (row.type === 'function_call') return { role: 'assistant', content: [], tool_calls: [{ id: row.call_id, function: { name: row.name, arguments: row.arguments } }] }
    if (row.type === 'function_call_output') return { role: 'tool', content: String(row.output ?? ''), tool_call_id: row.call_id }
    return row
  })
}

function normalizeTool(tool) {
  const name = tool?.name ?? tool?.function?.name
  if (typeof name !== 'string' || name.trim() === '') return null
  const parameters = tool?.parameters ?? tool?.function?.parameters ?? { type: 'object', properties: {} }
  return { name, description: String(tool?.description ?? tool?.function?.description ?? ''), parameters }
}

function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) { call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }; outcome.toolCalls.push(call) }
      else call.arguments += chunk.argumentsDelta ?? ''
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        const existing = outcome.toolCalls.find(candidate => candidate.id === chunk.block.id)
        if (existing === undefined) outcome.toolCalls.push({ slot: chunk.index, id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
      }
      break
    case 'usage': outcome.usage = toOpenAiUsage(chunk.usage); break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      // An aborted turn carries the same in-body nothing as an errored one; both
      // are the caller's failure to report, not an empty completion.
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') outcome.error = chunk.reason.failure?.message
      break
    default: break
  }
  return outcome
}

/**
 * The settings page's HTTP surface.
 *
 * Every route runs the trust fence first: the connection service's own
 * admission when the composition mounts it (the same check the kernel applies
 * to `/api`), otherwise the structural replica in src/trust.js. The plugin's
 * prefix outranks `/api` in webServer's longest-prefix dispatch, so without
 * this fence these routes would answer callers the app itself would refuse.
 */
function createApiRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/our-free-model/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const rejection = rejectionFor(req, deps.connection)
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    try {
      if (method === 'GET' && routePath === '/summary') {
        return send(200, buildSummary(deps))
      }
      if (method === 'GET' && routePath === '/stats') {
        return send(200, buildStats(deps.stats.get(), deps.catalog()))
      }
      if (method === 'GET' && routePath === '/meta') {
        const view = deps.announcements.view()
        return send(200, { ...deps.meta(), announcements: { fetchedAt: view.fetchedAt, source: view.source, error: view.error } })
      }
      if (method === 'GET' && routePath === '/announcement') {
        // A managed install also stands down the owner's onboarding copy: the
        // pack, not the plugin, speaks for what is new.
        const acknowledged = deps.managedDistribution === true || deps.settings.get().announcementAck === ANNOUNCEMENT_VERSION
        return send(200, { version: ANNOUNCEMENT_VERSION, acknowledged })
      }
      if (method === 'POST' && routePath === '/announcement/ack') {
        deps.settings.update({ announcementAck: String(url.searchParams.get('version') ?? ANNOUNCEMENT_VERSION) })
        deps.settings.flush()
        return send(200, { ok: true })
      }
      if (method === 'GET' && routePath === '/announcements') {
        const view = deps.announcements.view()
        return send(200, { ...view, acked: [...ackedSet(deps)], notifyOs: deps.settings.get().notifyOs === true })
      }
      if (method === 'POST' && routePath === '/announcements/ack') {
        const body = await readJson(req)
        const acked = ackedSet(deps)
        if (body.all === true) {
          // "mark all read": every announcement currently in the feed.
          for (const item of deps.announcements.view().items) acked.add(item.id)
        }
        if (typeof body.id === 'string' && body.id !== '') acked.add(body.id)
        deps.announcements.ack(acked)
        return send(200, { ok: true, view: deps.announcements.view() })
      }
      if (method === 'POST' && routePath === '/announcements/refresh') {
        // Re-read the LOCAL announcements file. There is no network call behind
        // this route in this fork, so it needs no managed-install guard.
        await deps.announcements.refresh()
        return send(200, { ok: true, view: deps.announcements.view() })
      }
      // The /update/* and /reload routes were removed in this fork along with
      // the updater and the hot reload they drove. They answer 404 through the
      // catch-all below, like any other path this plugin does not serve.
      if (method === 'POST' && routePath === '/settings') {
        const patch = await readJson(req)
        const current = deps.settings.get()
        const next = sanitizeSettings({ ...current, ...pick(patch, ['enabled', 'exposeRegionModels', 'probeIntervalMinutes', 'defaultMaxTokens', 'announcementAck', 'feedPollMinutes', 'notifyOs']) }, current)
        if (patch.forward !== undefined) {
          const forward = { ...(current.forward ?? {}), ...pick(patch.forward, ['enabled', 'host', 'port']) }
          // The listener spends this machine's lane, and a routable bind address
          // would let the whole subnet spend it too. Refused here so the settings
          // page says why, and again in `syncForward` for a hand-edited file.
          if (forward.enabled === true && !isLoopbackHost(forward.host ?? '127.0.0.1')) {
            return send(400, { error: 'the forward listener binds a loopback address only' })
          }
          if (forward.port !== undefined) {
            const port = Number(forward.port)
            forward.port = Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.trunc(port) : (current.forward?.port ?? 0)
          }
          next.forward = forward
        }
        deps.settings.update(next)
        deps.settings.flush()
        await deps.syncForward()
        if (patch.probeIntervalMinutes !== undefined) {
          // The probe period lives in a fiber effect; the next load picks a
          // change up, so surface that rather than pretending it hot-applied.
          deps.logger.info?.('our-free-model: probe interval change applies on the next load')
        }
        return send(200, { ok: true, settings: publicSettings(deps.settings.get(), deps.forwardInfo()) })
      }
      if (method === 'POST' && routePath === '/refresh') {
        await deps.refreshCatalog({ probe: true })
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'POST' && routePath === '/reprobe') {
        await deps.refreshAvailability()
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'GET' && routePath === '/forward/key') {
        return send(200, { key: deps.settings.get().forwardKey ?? '' })
      }
      if (method === 'POST' && routePath === '/forward/rotate') {
        return send(200, { key: deps.rotateKey() })
      }
      if (method === 'POST' && routePath === '/bench') {
        const body = await readJson(req)
        const result = await deps.testModel(String(body.model ?? ''), body.effort === undefined ? undefined : String(body.effort))
        return send(200, result)
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      const status = Number(error?.statusCode)
      return send(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, { error: String(error?.message ?? error) })
    }
  }
}

function ackedSet(deps) {
  const value = deps.settings.get().announcementsAcked
  return new Set(Array.isArray(value) ? value : [])
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key]
  return out
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

function publicSettings(settings, forwardInfo) {
  return {
    enabled: settings.enabled !== false,
    exposeRegionModels: settings.exposeRegionModels !== false,
    probeIntervalMinutes: settings.probeIntervalMinutes ?? 15,
    defaultMaxTokens: settings.defaultMaxTokens ?? 32768,
    announcementAck: settings.announcementAck ?? '',
    notifyOs: settings.notifyOs === true,
    forward: { ...(settings.forward ?? {}), running: forwardInfo.running, actualPort: forwardInfo.port, error: forwardInfo.error },
  }
}

function buildSummary(deps) {
  const state = deps.state()
  const snapshot = deps.availability.get()
  const forwardInfo = deps.forwardInfo()
  const feedView = deps.announcements.view()
  const defaultMaxTokens = deps.settings.get().defaultMaxTokens
  return {
    catalog: state.catalog.map(entry => ({
      ...entry,
      availability: snapshot.results?.[entry.id]?.state ?? STATE.unknown,
      detail: snapshot.results?.[entry.id]?.detail ?? '',
      probedAt: snapshot.results?.[entry.id]?.at ?? 0,
      ttftMs: snapshot.results?.[entry.id]?.ttftMs,
      latencyMs: snapshot.results?.[entry.id]?.latencyMs,
      // What each rung of the effort menu will really put on the wire for this
      // model, so the page never shows a 32K "output ceiling" beside a call that
      // was cut off at 8K. A model with no effort menu has no ladder to show.
      ...(entry.reasoning === true ? { budgets: budgetLadder(entry, undefined, defaultMaxTokens) } : {}),
      // `null` here is what the picker does not advertise; the roster still lists
      // those models, because "the probe refused it" is the user's only evidence.
      route: (state.membership[ROUTE_MAIN] ?? []).includes(entry.id) ? ROUTE_MAIN
        : (state.membership[ROUTE_REGION] ?? []).includes(entry.id) ? ROUTE_REGION : null,
    })),
    settings: publicSettings(deps.settings.get(), forwardInfo),
    probedAt: snapshot.at ?? 0,
    announcementVersion: ANNOUNCEMENT_VERSION,
    version: deps.meta().version,
    distribution: deps.meta().distribution,
    meta: deps.meta(),
    announcements: { unread: feedView.unread, fetchedAt: feedView.fetchedAt },
  }
}

export function buildStats(stats, catalog) {
  const days = stats.days ?? {}
  const series = Object.keys(days).sort().map(day => ({
    day,
    total: days[day].total ?? 0,
    models: Object.entries(days[day].models ?? {}).map(([model, value]) => ({ model, ...value })),
  }))
  const totals = {}
  for (const entry of series) for (const row of entry.models) {
    const previous = totals[row.model] ?? {
      model: row.model, input: 0, output: 0, reasoning: 0, calls: 0, failed: 0,
      ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
    }
    totals[row.model] = {
      ...previous,
      input: previous.input + row.input,
      output: previous.output + row.output,
      reasoning: previous.reasoning + row.reasoning,
      calls: previous.calls + row.calls,
      failed: previous.failed + row.failed,
      ttftMs: previous.ttftMs + (row.ttftMs ?? 0),
      ttftSamples: previous.ttftSamples + (row.ttftSamples ?? 0),
      decodeMs: previous.decodeMs + (row.decodeMs ?? 0),
      decodeTokens: previous.decodeTokens + (row.decodeTokens ?? 0),
    }
  }
  const named = Object.values(totals).map(row => ({
    ...row,
    name: catalog.find(entry => entry.id === row.model)?.name ?? row.model,
    // A rate over too few measurable calls is a rounding error with a unit on it.
    tps: row.decodeMs >= MIN_DECODE_MS ? Math.round(row.decodeTokens / (row.decodeMs / 1000)) : null,
    avgTtftMs: row.ttftSamples > 0 ? Math.round(row.ttftMs / row.ttftSamples) : null,
  }))
  return {
    requests: stats.requests ?? 0,
    days: series,
    models: named,
    samples: (stats.samples ?? []).slice(-200),
    grand: {
      input: named.reduce((sum, row) => sum + row.input, 0),
      output: named.reduce((sum, row) => sum + row.output, 0),
      reasoning: named.reduce((sum, row) => sum + row.reasoning, 0),
      calls: named.reduce((sum, row) => sum + row.calls, 0),
      failed: named.reduce((sum, row) => sum + row.failed, 0),
    },
  }
}
