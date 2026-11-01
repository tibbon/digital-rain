import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

// ─── DECODE ──────────────────────────────────────────────────────────────
// Text in the conversation arrives as flickering katakana and resolves,
// glyph by glyph, into what it really says. The engine still draws every
// row its own way: the hooks only hand it a scrambled copy of the text
// while a row is mid-decode, then step aside.

const frame = atom({ plugin: 'digital-rain', key: 'frame' } as const, 0)

const TICK_MS = 80
const SETTLE_MIN = 250 // ms before the first glyph of a new run can resolve
const SETTLE_SPREAD = 700 // ...and the latest one
const TOOL_SETTLE = 900
const GLITCH_EVERY_MS = 14000
const LOAD_GRACE_MS = 2500 // rows drawn as the mod loads are old: no decode

const KATA_A = 0xff66
const KATA_SPAN = 0xff9d - KATA_A + 1

let enabled = true
let loadedAt = 0
let busyUntil = 0 // the ticker runs while any row decodes
let spinnerOn = false

type Run = { upTo: number; at: number }
type Glitch = { from: number; to: number; at: number }
type Rec = { runs: Run[]; len: number; glitch?: Glitch; seenAt: number }
const records = new Map<string, Rec>()
let lastReply: string | undefined

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}
const settleOf = (i: number) => SETTLE_MIN + (hash(i) % SETTLE_SPREAD)
const scrambles = (ch: string) => /[\p{L}\p{N}]/u.test(ch)
const glyphFor = (i: number, f: number) => String.fromCharCode(KATA_A + (hash(i * 31 + f) % KATA_SPAN))

function recordFor(key: string, len: number, now: number): Rec {
  let r = records.get(key)
  if (!r) {
    // rows already there when the mod loads (or reloads) are left as they are
    const isOld = now - loadedAt < LOAD_GRACE_MS
    r = { runs: [{ upTo: len, at: isOld ? 0 : now }], len, seenAt: now }
    records.set(key, r)
    if (records.size > 600) records.delete(records.keys().next().value!)
    return r
  }
  if (len > r.len) r.runs.push({ upTo: len, at: now })
  if (len < r.len) r.runs = [{ upTo: len, at: 0 }] // rewound or replaced: show as is
  r.len = len
  return r
}

// the scrambled copy of `text`, or undefined once every glyph has resolved
function scramble(text: string, r: Rec, now: number, f: number): string | undefined {
  const chars = Array.from(text)
  const latest = SETTLE_MIN + SETTLE_SPREAD
  // everything before the first run still settling is plain
  let start = chars.length
  let runFrom = 0
  for (const run of r.runs) {
    if (now - run.at < latest) {
      start = runFrom
      break
    }
    runFrom = run.upTo
  }
  const g = r.glitch && now - r.glitch.at < latest ? r.glitch : undefined
  if (start >= chars.length && !g) return undefined

  let changed = false
  let runIdx = 0
  let runStart = 0
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (!scrambles(ch)) continue
    let at = -Infinity
    if (i >= start) {
      while (runIdx < r.runs.length && r.runs[runIdx]!.upTo <= i) runStart = r.runs[runIdx++]!.upTo
      at = r.runs[runIdx]?.at ?? -Infinity
      // a run decodes as a wave: its later glyphs resolve a little later
      at += Math.min(400, (i - runStart) * 4)
    }
    if (g && i >= g.from && i < g.to) at = Math.max(at, g.at)
    if (now - at < settleOf(i)) {
      chars[i] = glyphFor(i, f)
      changed = true
    }
  }
  if (!changed) return undefined
  busyUntil = Math.max(busyUntil, now + 200)
  return chars.join('')
}

// scramble every string inside a tool's input or output, keys kept
const KEEP_KEYS = new Set(['type', 'kind', 'status', 'tool', 'id', 'tool_use_id', 'mode'])
function scrambleDeep(v: unknown, mix: number, f: number, depth = 0): unknown {
  if (typeof v === 'string') {
    let n = 0
    return Array.from(v)
      .map(ch => {
        n++
        return scrambles(ch) && hash(n * 7 + mix) % 100 < 85 ? glyphFor(n + mix, f) : ch
      })
      .join('')
  }
  if (depth > 6 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(x => scrambleDeep(x, mix, f, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>))
    out[k] = KEEP_KEYS.has(k) ? x : scrambleDeep(x, mix + k.length, f, depth + 1)
  return out
}

const SPINNER_WORDS: Record<string, string> = {
  requesting: 'Jacking in',
  thinking: 'Decoding',
  'tool-input': 'Compiling',
  'tool-use': 'Bending',
  responding: 'Transmitting',
}

export function setDecode(value: boolean) {
  enabled = value
  records.clear()
}
export function isDecoding() {
  return enabled
}

export function startDecode($: EngineInterface) {
  loadedAt = Date.now()
  $.clock.every(TICK_MS, () => {
    const now = Date.now()
    if (!enabled || (now > busyUntil && !spinnerOn)) return
    void update($, frame, n => (n + 1) % 1_000_000)
  })
  // now and then a recent reply glitches: a word flips back into code
  $.clock.every(GLITCH_EVERY_MS, () => {
    if (!enabled || !lastReply) return
    if (Math.random() < 0.4) return
    const r = records.get(lastReply)
    if (!r || r.len < 8) return
    const from = Math.floor(Math.random() * Math.max(1, r.len - 12))
    r.glitch = { from, to: from + 4 + Math.floor(Math.random() * 10), at: Date.now() }
    busyUntil = Date.now() + 1200
    $.ui.invalidate('ui.render')
  })
}

export function endDecodeTurn() {
  spinnerOn = false
}

export function installDecode(on: On) {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!enabled) return next(e)
    const now = Date.now()
    const key = `a:${e.requestId}`
    const r = recordFor(key, Array.from(e.props.text).length, now)
    if (r.seenAt > loadedAt + LOAD_GRACE_MS) lastReply = key
    const f = isLive(r, now) ? await read($, frame) : 0
    const text = scramble(e.props.text, r, now, f)
    return text === undefined ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!enabled) return next(e)
    const now = Date.now()
    const r = recordFor(`u:${e.requestId}`, Array.from(e.props.text).length, now)
    const f = isLive(r, now) ? await read($, frame) : 0
    const text = scramble(e.props.text, r, now, f)
    return text === undefined ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!enabled) return next(e)
    const now = Date.now()
    const r = recordFor(`t:${e.requestId}`, 1, now)
    const age = now - (r.runs[0]?.at ?? 0)
    if (age >= TOOL_SETTLE) return next(e)
    busyUntil = Math.max(busyUntil, now + 200)
    const f = await read($, frame)
    return next({ ...e, props: { ...e.props, input: scrambleDeep(e.props.input, hash(age), f) } })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!enabled) return next(e)
    const now = Date.now()
    const r = recordFor(`r:${e.requestId}`, 1, now)
    const age = now - (r.runs[0]?.at ?? 0)
    if (age >= TOOL_SETTLE) return next(e)
    busyUntil = Math.max(busyUntil, now + 200)
    const f = await read($, frame)
    return next({ ...e, props: { ...e.props, output: scrambleDeep(e.props.output, hash(age), f) } })
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!enabled) return next(e)
    spinnerOn = true
    const f = await read($, frame)
    const word = SPINNER_WORDS[e.props.mode] ?? e.props.word
    // the word keeps flipping: a few of its letters are always in code
    const chars = Array.from(word).map((ch, i) =>
      scrambles(ch) && hash(i * 13 + Math.floor(f / 2)) % 100 < 28 ? glyphFor(i, f) : ch,
    )
    return next({ ...e, props: { ...e.props, word: chars.join('') } })
  })
}

// read the frame only while a row decodes, so settled rows never redraw
function isLive(r: Rec, now: number) {
  const latest = SETTLE_MIN + SETTLE_SPREAD + 400
  const last = r.runs[r.runs.length - 1]
  return Boolean((last && now - last.at < latest) || (r.glitch && now - r.glitch.at < latest))
}
