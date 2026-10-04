/**
 * Local-only announcement feed.
 *
 * LOCAL-FIRST FORK: the upstream plugin published announcements by polling a
 * JSON document in the repository owner's GitHub account. That made the owner —
 * and anyone who could reach their account, their CDN, or the TLS path between
 * here and there — the author of content that renders inside the settings page.
 * This fork removes that trust relationship entirely: announcements are read
 * from a **local file on this machine** and from nowhere else. There is no
 * fetch, no URL, no cache of remote bytes, and no override field that can point
 * the reader at a network location.
 *
 * The file is `<dsh home>/our-free-model/announcements.json`, i.e. the plugin's
 * own data directory. It ships seeded with the announcement copy that was
 * current at fork time (`feed/announcements.json`, copied in by the installer),
 * and the user can edit it freely — it is their file, on their disk.
 *
 * The parser is kept byte-for-byte compatible with the upstream one so the
 * existing sanitizer tests, the browser half's allowlist renderer, and the
 * acknowledgement bookkeeping all keep working unchanged.
 *
 * @module src/feed.js
 */

import fs from 'node:fs'

export const LEVELS = new Set(['info', 'update', 'warn', 'urgent'])
const MAX_FEED_BYTES = 512 * 1024
const MAX_HTML_BYTES = 96 * 1024
const MAX_ITEMS = 100

/**
 * Validate one raw feed document into the shape the rest of the plugin consumes.
 *
 * @param {unknown} payload - the parsed JSON document
 * @param {number} [now]
 * @returns {{announcements: Array<object>}}
 * @throws {Error} when the document is not a feed at all
 */
export function parseFeed(payload, now = Date.now()) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('feed document must be a JSON object')
  }
  const rows = payload.announcements
  if (!Array.isArray(rows)) throw new Error('feed document must carry an announcements array')
  const seen = new Set()
  const announcements = []
  for (const row of rows.slice(0, MAX_ITEMS)) {
    const item = parseItem(row, now)
    if (item === undefined) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    announcements.push(item)
  }
  return { announcements: sortItems(announcements) }
}

/** Validated, normalised single announcement; `undefined` for rows that fail. */
function parseItem(row, now) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id === '' || id.length > 128) return undefined
  const title = typeof row.title === 'string' ? row.title.trim().slice(0, 200) : ''
  if (title === '') return undefined
  const html = typeof row.html === 'string' ? row.html : ''
  if (html.length > MAX_HTML_BYTES) return undefined
  const createdAt = timestamp(row.createdAt) ?? 0
  const expiresAt = timestamp(row.expiresAt)
  if (expiresAt !== undefined && expiresAt <= now) return undefined
  const level = LEVELS.has(row.level) ? row.level : 'info'
  let link
  if (row.link !== null && typeof row.link === 'object' && typeof row.link.url === 'string'
    && /^https?:\/\//i.test(row.link.url)) {
    link = { url: row.link.url, label: typeof row.link.label === 'string' ? row.link.label.slice(0, 100) : '' }
  }
  return {
    id,
    title,
    level,
    html,
    createdAt,
    ...expiresAt === undefined ? {} : { expiresAt },
    ...row.pinned === true ? { pinned: true } : {},
    ...link === undefined ? {} : { link },
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Pinned first, then newest first; a stable order keeps the UI calm between reads. */
export function sortItems(items) {
  const stamp = item => (typeof item.createdAt === 'number' ? item.createdAt : Date.parse(item.createdAt) || 0)
  return [...items].sort((a, b) => {
    if ((b.pinned === true ? 1 : 0) !== (a.pinned === true ? 1 : 0)) return (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0)
    return stamp(b) - stamp(a)
  })
}

/**
 * Read and validate one local announcements document.
 *
 * Deliberately takes no URL and has no `fetchImpl` seam: there is no code path
 * in this fork that can turn a string into a network request for announcements.
 * A missing or malformed file is a normal, quiet state (an empty feed).
 *
 * @param {string} file - absolute path to the local announcements JSON
 * @returns {{feed: {announcements: Array<object>}, error: string}}
 */
export function readFeedFile(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    // Absent is the normal state on a fresh install before the seed lands.
    return { feed: { announcements: [] }, error: '' }
  }
  if (raw.length > MAX_FEED_BYTES) {
    return { feed: { announcements: [] }, error: `local announcements file is larger than ${MAX_FEED_BYTES} bytes` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { feed: { announcements: [] }, error: `local announcements file is not valid JSON (${error?.message ?? error})` }
  }
  try {
    return { feed: parseFeed(parsed), error: '' }
  } catch (error) {
    return { feed: { announcements: [] }, error: `local announcements file is not a feed (${error?.message ?? error})` }
  }
}

/**
 * The reader's state: the local file's contents, when they were last read, and
 * the ids already known so a newly added announcement can be announced.
 *
 * `poll()` keeps its name and signature for the callers' sake, but it performs
 * a local file read. It never touches the network.
 */
export class AnnouncementFeed {
  /**
   * @param {object} deps
   * @param {string} deps.file - absolute path to the local announcements JSON
   * @param {(items: Array<object>) => void} [deps.onArrival] - items first seen in this read
   * @param {(message: string) => void} [deps.log]
   */
  constructor({ file, onArrival, log = () => {} }) {
    this.deps = { file, onArrival, log }
    this.cache = { at: 0, source: 'local', announcements: [] }
    this.error = ''
    this.polling = null
    this.knownIds = new Set()
  }

  /** Read the local file once; a fresh install starts empty and stays silent. */
  load() {
    const { feed, error } = readFeedFile(this.deps.file)
    this.error = error
    this.cache = { at: feed.announcements.length > 0 ? Date.now() : 0, source: 'local', announcements: feed.announcements }
    this.knownIds = new Set(feed.announcements.map(item => item.id))
    return this.cache
  }

  /** True when no local announcement has ever been read. */
  get neverFetched() { return this.cache.at === 0 }

  /**
   * One read of the local file. Concurrent calls share a single in-flight read.
   *
   * The in-flight marker is cleared in a `then` *after* the promise is stored,
   * not inside the async body's `finally`: the body of a local file read runs
   * synchronously to completion, so a `finally` there clears `this.polling`
   * before the assignment below stores it — leaving a settled promise in place
   * forever and making every later read return the first one's answer.
   *
   * @returns {Promise<{arrived: Array<object>, total: number, source: string}>}
   */
  poll() {
    if (this.polling !== null) return this.polling
    const run = (async () => {
      try {
        const { feed, error } = readFeedFile(this.deps.file)
        this.error = error
        const hadCache = this.knownIds.size > 0
        const previousIds = new Set(this.knownIds)
        this.cache = { at: Date.now(), source: 'local', announcements: feed.announcements }
        this.knownIds = new Set(feed.announcements.map(item => item.id))
        if (error !== '') {
          this.deps.log?.(`our-free-model: local announcements not readable (${error})`)
          return { arrived: [], total: feed.announcements.length, source: 'local' }
        }
        const arrived = hadCache
          ? feed.announcements.filter(item => !previousIds.has(item.id))
          : []
        for (const item of arrived) this.deps.log?.(`our-free-model: announcement arrived "${item.title}"`)
        if (arrived.length > 0) this.deps.onArrival?.(arrived)
        return { arrived, total: feed.announcements.length, source: 'local' }
      } catch (error) {
        this.error = String(error?.message ?? error)
        this.deps.log?.(`our-free-model: local announcements read failed (${this.error})`)
        return { arrived: [], total: this.cache.announcements.length, source: 'local' }
      }
    })()
    this.polling = run
    void run.then(
      () => { if (this.polling === run) this.polling = null },
      () => { if (this.polling === run) this.polling = null },
    )
    return run
  }

  /** Snapshot for the API layer and the first `hello` push. */
  view({ ackedIds = [] } = {}) {
    const acked = ackedIds instanceof Set ? ackedIds : new Set(ackedIds)
    // Annotate each item with its ack state so the client renders unread
    // markers from data instead of guessing.
    const items = this.cache.announcements.map(item => ({ ...item, acked: acked.has(item.id) }))
    return {
      items,
      unread: items.filter(item => !item.acked).length,
      fetchedAt: this.cache.at,
      source: this.cache.source,
      error: this.error,
      lastError: this.error,
    }
  }
}
