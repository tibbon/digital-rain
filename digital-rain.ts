#!/usr/bin/env node
// DIGITAL RAIN: full-screen digital rain driven by a live Claude Code session.
//
//   ↓ falling  = output tokens (Claude → you): reply text, tool-call arguments,
//                and thinking (encrypted in the log: unreadable glyphs, sized
//                to the real thinking-token count)
//   ↑ rising   = input tokens (→ Claude): your prompts and tool results, plus
//                a faint surge sized to the context each request re-sends
//
// It tails the session transcript Claude Code writes to ~/.claude/projects,
// following whichever session is most recently active. No dependencies.
//
//   node digital-rain.ts [--session <file.jsonl | id>] [--project <name part>]
//   keys: q quit · p pause · c console · + / - speed

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ─── options ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = (name: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`digital-rain: full-screen Matrix rain of a live Claude Code session

  node digital-rain.ts [--session <file.jsonl | session id>] [--project <substring>]

  ↓ falling = output tokens   ↑ rising = input tokens
  keys: q quit · p pause · c console · + / - speed`)
  process.exit(0)
}
const ROOT = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
  : path.join(os.homedir(), '.claude', 'projects')
const PIN_SESSION = opt('--session')
const PIN_PROJECT = opt('--project')
let FRAME_MS = 50

// ─── palette ─────────────────────────────────────────────────────────────
type RGB = [number, number, number]
type Kind = 'ambient' | 'out' | 'tool' | 'file' | 'think' | 'in' | 'prompt' | 'result' | 'err' | 'cache' | 'agent'
// two tones per kind: alternate tokens swap between them
const TONES: Record<Kind, [RGB, RGB]> = {
  ambient: [[0, 255, 70], [0, 255, 70]],
  out: [[40, 255, 90], [0, 175, 60]],
  tool: [[190, 255, 70], [120, 200, 40]],
  file: [[255, 225, 100], [210, 170, 50]],
  think: [[30, 170, 150], [30, 170, 150]],
  in: [[110, 235, 215], [60, 170, 160]],
  prompt: [[235, 255, 240], [170, 220, 190]],
  result: [[110, 235, 215], [60, 170, 160]],
  err: [[255, 80, 80], [190, 40, 40]],
  cache: [[40, 120, 110], [40, 120, 110]],
  agent: [[120, 190, 255], [70, 130, 210]],
}
const FADE: Record<Kind, number> = {
  ambient: 0.07, out: 0.016, tool: 0.014, file: 0.014, think: 0.06,
  in: 0.018, prompt: 0.01, result: 0.02, err: 0.01, cache: 0.09, agent: 0.018,
}
const KINDS = Object.keys(TONES) as Kind[]
const KIND_INDEX = new Map(KINDS.map((k, i) => [k, i]))
const isAnon = (k: Kind) => k === 'ambient' || k === 'think' || k === 'cache'

const KATA_A = 0xff66
const KATA_B = 0xff9d
const EXTRA = '0123456789:.=*+-<>|Z'
// The background rain is made of recent tokens: each character that passes
// through is kept, and ambient glyphs are drawn from that memory, mapped
// onto katakana (digits and some symbols stay as themselves).
const memory = new Uint16Array(4096)
let memLen = 0
let memAt = 0
function remember(text: string) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c <= 32) continue
    memory[memAt] = c
    memAt = (memAt + 1) % memory.length
    if (memLen < memory.length) memLen++
  }
}
function glyph(): number {
  if (memLen === 0) {
    if (Math.random() < 0.15) return EXTRA.charCodeAt((Math.random() * EXTRA.length) | 0)
    return KATA_A + ((Math.random() * (KATA_B - KATA_A + 1)) | 0)
  }
  const c = memory[(Math.random() * memLen) | 0]!
  if (EXTRA.includes(String.fromCharCode(c))) return c
  return KATA_A + ((c * 2654435761) >>> 0) % (KATA_B - KATA_A + 1)
}
function cellCode(ch: string): number {
  const c = ch.codePointAt(0) ?? 32
  if (c < 0x20 || c === 0x7f) return 0x20
  if (c <= 0x7e) return c
  if (c >= 0xa1 && c <= 0x24f) return c
  if ((c >= 0x2190 && c <= 0x21ff) || (c >= 0x2500 && c <= 0x259f) || (c >= KATA_A && c <= KATA_B)) return c
  return glyph() // wide or exotic: replaced so the grid stays one cell per glyph
}

// ─── tokens ──────────────────────────────────────────────────────────────
// A rough BPE-like split: a leading space joins the word, long words break.
const TOKEN_RE = /\s?[A-Za-z]+|\s?\d{1,3}|\s?[^\sA-Za-z\d]{1,2}|\s+/g
function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.replace(/\s+/g, ' ').matchAll(TOKEN_RE)) {
    let t = m[0]
    while (t.length > 7) {
      out.push(t.slice(0, 5))
      t = t.slice(5)
    }
    if (t) out.push(t)
  }
  return out
}

// ─── the world ───────────────────────────────────────────────────────────
type Cell = { code: number; tone: 0 | 1 }
type Drop = {
  x: number
  y: number
  row: number
  dir: 1 | -1
  speed: number
  kind: Kind
  cells?: Cell[]
  i: number
  left: number // anonymous drops: glyphs still to write
}
type Pending = { cells: Cell[]; kind: Kind; dir: 1 | -1 }
type LogLine = { text: string; kind: Kind }

let W = 0
let H = 0
let glyphs = new Uint32Array(0)
let bright = new Float32Array(0)
let kinds = new Uint8Array(0)
let tones = new Uint8Array(0)
let drops: Drop[] = []
const queue: Pending[] = []
let anonDown = 0 // thinking glyphs owed
let anonUp = 0 // context surge glyphs owed
const log: LogLine[] = []
let showConsole = true
let paused = false
let frame = 0
let activity = 0.2
let lastEventAt = 0
let mode: 'idle' | 'thinking' | 'writing' | 'tools' = 'idle'
let banner: { text: string; at: number; until: number } | undefined
const pendingTools = new Map<string, { name: string; at: number; detail: string }>()
const stats = { out: 0, think: 0, input: 0, cacheRead: 0, cacheWrite: 0, tools: 0, errors: 0, turns: 0 }
let title = ''
let sessionFile = ''

const consoleRows = () => (showConsole && H >= 16 ? 6 : 0)
const rainTop = () => 1
const rainBottom = () => (consoleRows() ? H - consoleRows() - 1 : H) // exclusive

function resize() {
  const cols = Math.max(10, process.stdout.columns || 80)
  const rows = Math.max(6, process.stdout.rows || 24)
  W = cols
  H = rows
  glyphs = new Uint32Array(W * H)
  bright = new Float32Array(W * H)
  kinds = new Uint8Array(W * H)
  tones = new Uint8Array(W * H)
  drops = []
  prev = undefined
}

function say(text: string, kind: Kind) {
  remember(text)
  log.push({ text: text.replace(/\s+/g, ' ').trim(), kind })
  if (log.length > 100) log.splice(0, log.length - 100)
}
function flash(text: string, ms = 3500) {
  banner = { text, at: Date.now(), until: Date.now() + ms }
}
function bump(n: number) {
  activity = Math.min(1, activity + n)
  lastEventAt = Date.now()
}

// queue a text as token streams; long texts are sampled so the rain keeps up
function emit(text: string, kind: Kind, dir: 1 | -1, budget = 160) {
  remember(text.length > 4000 ? text.slice(0, 2000) + text.slice(-2000) : text)
  let toks = tokenize(text)
  if (toks.length === 0) return
  if (toks.length > budget) {
    // keep the head and tail, the parts people read
    toks = [...toks.slice(0, Math.ceil(budget * 0.7)), ' …', ...toks.slice(-Math.floor(budget * 0.3))]
  }
  const span = Math.max(8, rainBottom() - rainTop() - 2)
  let cells: Cell[] = []
  let tone: 0 | 1 = 0
  for (const t of toks) {
    const tc = Array.from(t).map(ch => ({ code: cellCode(ch === '…' ? '~' : ch), tone }))
    if (cells.length + tc.length > span && cells.length > 0) {
      queue.push({ cells, kind, dir })
      cells = []
    }
    cells.push(...tc)
    tone = tone === 0 ? 1 : 0
  }
  if (cells.length) queue.push({ cells, kind, dir })
  if (queue.length > 400) queue.splice(0, queue.length - 400)
}

// ─── simulation ──────────────────────────────────────────────────────────
function freeColumn(dir: 1 | -1): number | undefined {
  const busy = new Set<number>()
  for (const d of drops) if (d.cells && d.dir === dir) busy.add(d.x)
  for (let tries = 0; tries < 16; tries++) {
    const x = (Math.random() * W) | 0
    if (!busy.has(x) && !busy.has(x - 1) && !busy.has(x + 1)) return x
  }
  return undefined
}

function spawnAnon(kind: Kind, dir: 1 | -1, speedBase: number) {
  const top = rainTop()
  const bottom = rainBottom()
  drops.push({
    x: (Math.random() * W) | 0,
    y: dir === 1 ? top : bottom - 1,
    row: dir === 1 ? top - 1 : bottom,
    dir,
    speed: speedBase + Math.random() * 0.6,
    kind,
    i: 0,
    left: 4 + ((Math.random() * (bottom - top) * 0.7) | 0),
  })
}

function step() {
  frame++
  const top = rainTop()
  const bottom = rainBottom()

  for (let i = 0; i < bright.length; i++) {
    const b = bright[i]!
    if (b <= 0) continue
    const k = KINDS[kinds[i]!]!
    bright[i] = Math.max(0, b - FADE[k])
    if (isAnon(k) && Math.random() < 0.02) glyphs[i] = glyph()
  }

  // readable token streams: release a few per frame, faster when backed up
  const release = Math.min(6, 1 + Math.floor(queue.length / 25))
  for (let n = 0; n < release && queue.length; n++) {
    const p = queue[0]!
    const x = freeColumn(p.dir)
    if (x === undefined) break
    queue.shift()
    drops.push({
      x,
      y: p.dir === 1 ? top - Math.random() * 2 : bottom - 1 + Math.random() * 2,
      row: p.dir === 1 ? top - 3 : bottom + 2,
      dir: p.dir,
      speed: 0.4 + Math.random() * 0.25 + Math.min(0.5, queue.length / 200),
      kind: p.kind,
      cells: p.cells,
      i: 0,
      left: 0,
    })
  }

  // anonymous tokens owed: thinking falls, context surges rise
  const downNow = Math.min(anonDown, Math.max(1, Math.ceil(anonDown / 40)), W / 4)
  for (let n = 0; n < downNow; n++) spawnAnon('think', 1, 0.6)
  anonDown -= downNow
  const upNow = Math.min(anonUp, Math.max(1, Math.ceil(anonUp / 30)), W / 3)
  for (let n = 0; n < upNow; n++) spawnAnon('cache', -1, 0.8)
  anonUp -= upNow

  // ambient rain, denser when busy
  const idle = Date.now() - lastEventAt > 20000
  activity = Math.max(idle ? 0.05 : 0.25, activity * 0.99)
  for (let s = W * (0.004 + 0.04 * activity); s > 0; s--) {
    if (Math.random() > s) break
    spawnAnon('ambient', 1, 0.3 + activity * 0.6)
  }

  const kept: Drop[] = []
  for (const d of drops) {
    d.y += d.speed * d.dir
    let alive = true
    for (;;) {
      const target = d.dir === 1 ? Math.floor(d.y) : Math.ceil(d.y)
      if (d.dir === 1 ? d.row >= target : d.row <= target) break
      d.row += d.dir
      if (d.row < top || d.row >= bottom) {
        if ((d.dir === 1 && d.row >= bottom) || (d.dir === -1 && d.row < top)) {
          alive = false
          break
        }
        continue
      }
      let code: number
      let tone: 0 | 1 = 0
      if (d.cells) {
        const c = d.cells[d.i++]
        if (!c) {
          alive = false
          break
        }
        code = c.code
        tone = c.tone
      } else {
        if (d.left-- <= 0) {
          alive = false
          break
        }
        code = glyph()
      }
      const at = d.row * W + d.x
      if (isAnon(d.kind) && !isAnon(KINDS[kinds[at]!]!) && bright[at]! > 0.25) continue
      if (code === 32 && d.cells) {
        bright[at] = 0 // spaces punch a gap so words read apart
        continue
      }
      glyphs[at] = code
      bright[at] = 1
      kinds[at] = KIND_INDEX.get(d.kind)!
      tones[at] = tone
    }
    if (alive) kept.push(d)
  }
  drops = kept
}

// ─── drawing (ANSI, only changed cells) ──────────────────────────────────
let curGlyph = new Uint32Array(0)
let curFg = new Uint32Array(0)
let curBg = new Uint32Array(0)
let prev: { g: Uint32Array; f: Uint32Array; b: Uint32Array } | undefined
const CONSOLE_BG = 0x000c04
const rgb = (c: RGB, s: number) => {
  const f = Math.max(0, Math.min(1, s))
  return (((c[0] * f) | 0) << 16) | (((c[1] * f) | 0) << 8) | ((c[2] * f) | 0)
}

function compose() {
  const n = W * H
  if (curGlyph.length !== n) {
    curGlyph = new Uint32Array(n)
    curFg = new Uint32Array(n)
    curBg = new Uint32Array(n)
  }
  const put = (x: number, y: number, code: number, fg: number, bg: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = y * W + x
    curGlyph[i] = code
    curFg[i] = fg
    curBg[i] = bg
  }
  const write = (x: number, y: number, s: string, fg: number, bg: number, max = W) => {
    let i = 0
    for (const ch of s) {
      if (i >= max) break
      put(x + i++, y, cellCode(ch), fg, bg)
    }
    return i
  }

  const heads = new Set<number>()
  for (const d of drops) heads.add(d.row * W + d.x)
  for (let i = 0; i < n; i++) {
    const b = bright[i]!
    curBg[i] = 0
    if (b <= 0.02) {
      curGlyph[i] = 32
      curFg[i] = 0
      continue
    }
    const k = KINDS[kinds[i]!]!
    curGlyph[i] = glyphs[i]!
    if (heads.has(i) && b > 0.9) {
      curFg[i] = k === 'err' ? 0xffd0d0 : k === 'cache' ? 0x80c8c0 : 0xeaffea
    } else {
      const curve = isAnon(k) ? b * b : Math.sqrt(b)
      curFg[i] = rgb(TONES[k][tones[i] as 0 | 1], 0.15 + 0.85 * curve)
    }
  }

  // status bar
  for (let x = 0; x < W; x++) put(x, 0, 32, 0, CONSOLE_BG)
  const spin = '|/-\\'[frame % 4]
  const live = [...pendingTools.values()].pop()
  const state = live
    ? `${spin} ${live.name} ${((Date.now() - live.at) / 1000).toFixed(1)}s`
    : mode === 'idle'
      ? 'idle'
      : `${spin} ${mode}`
  const k = (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(v))
  const left = ` DIGITAL RAIN  ${title ? title + '  ' : ''}${state}`
  const ctx = stats.input + stats.cacheRead + stats.cacheWrite
  const hit = ctx ? Math.round((stats.cacheRead / ctx) * 100) : 0
  const right = `↓ out ${k(stats.out)} (think ${k(stats.think)})   ↑ in ${k(ctx)} (cache ${hit}%)   tools ${stats.tools}  err ${stats.errors} `
  const used = write(0, 0, left, mode === 'idle' && !live ? 0x2f8f4f : 0xb8ffb8, CONSOLE_BG)
  if (used + right.length + 2 <= W) {
    const rx = W - right.length
    write(rx, 0, right, 0x5fcf7f, CONSOLE_BG)
  }

  // console
  const c = consoleRows()
  if (c) {
    const sep = H - c - 1
    for (let x = 0; x < W; x++) put(x, sep, 0x2500, 0x0f5f2a, 0)
    write(2, sep, ' ↓ out = Claude → you   ↑ in = → Claude ', 0x2f8f4f, 0)
    const lines = log.slice(-c)
    for (let r = 0; r < c; r++) {
      const y = H - c + r
      for (let x = 0; x < W; x++) put(x, y, 32, 0, CONSOLE_BG)
      const line = lines[r - (c - lines.length)]
      if (!line) continue
      const age = r === c - 1 ? 1 : 0.45 + 0.4 * (r / c)
      const text = line.text.length > W - 2 ? line.text.slice(0, W - 3) + '~' : line.text
      write(1, y, text, rgb(TONES[line.kind][0], age), CONSOLE_BG)
    }
  }

  if (paused) write(W - 10, 1, ' PAUSED ', 0x000000, 0x5fcf7f)

  // banner, typed out
  if (banner && Date.now() < banner.until) {
    const shown = Math.min(banner.text.length, Math.floor((Date.now() - banner.at) / 45))
    const text = banner.text.slice(0, shown) + (frame % 10 < 5 ? '_' : ' ')
    const width = Math.min(W - 2, banner.text.length + 5)
    const x0 = Math.max(0, ((W - width) / 2) | 0)
    const y0 = ((rainBottom() - rainTop()) / 2 + rainTop()) | 0
    for (let x = x0; x < x0 + width; x++) put(x, y0, 32, 0, 0)
    write(x0 + 2, y0, text, 0xd8ffd8, 0, width - 2)
  } else banner = undefined
}

function paint() {
  compose()
  const n = W * H
  const full = !prev || prev.g.length !== n
  let out = full ? '\x1b[H' : ''
  let fgNow = -1
  let bgNow = -1
  let lastI = -2
  for (let i = 0; i < n; i++) {
    const g = curGlyph[i]!
    const f = curFg[i]!
    const b = curBg[i]!
    if (!full && prev!.g[i] === g && (g === 32 || prev!.f[i] === f) && prev!.b[i] === b) continue
    if (i !== lastI + 1 || (i % W === 0 && !full)) out += `\x1b[${((i / W) | 0) + 1};${(i % W) + 1}H`
    if (b !== bgNow) {
      out += `\x1b[48;2;${b >> 16};${(b >> 8) & 255};${b & 255}m`
      bgNow = b
    }
    if (g !== 32 && f !== fgNow) {
      out += `\x1b[38;2;${f >> 16};${(f >> 8) & 255};${f & 255}m`
      fgNow = f
    }
    out += String.fromCodePoint(g)
    lastI = i
  }
  if (out) process.stdout.write(out)
  prev = { g: curGlyph.slice(), f: curFg.slice(), b: curBg.slice() }
}

// ─── reading the session ─────────────────────────────────────────────────
type Rec = Record<string, any>
const seenUsage = new Map<string, { out: number; think: number }>()

function short(s: string, n = 90) {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '~' : one
}
function toolDetail(name: string, input: Rec): { detail: string; isFile: boolean } {
  const file = input?.file_path ?? input?.notebook_path
  if (typeof file === 'string') return { detail: file, isFile: true }
  for (const key of ['command', 'pattern', 'url', 'query', 'description', 'skill', 'prompt', 'path']) {
    if (typeof input?.[key] === 'string') return { detail: input[key], isFile: false }
  }
  return { detail: JSON.stringify(input ?? {}), isFile: false }
}
const toolName = (n: string) => n.replace(/^mcp__(.+?)__/, '$1:')
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(b => (typeof b?.text === 'string' ? b.text : '')).join(' ')
  return ''
}
function stripTags(s: string) {
  return s.replace(/<[^>]{1,40}>/g, ' ')
}

// live = true: rain it; false: backfill (stats and console only)
function ingest(r: Rec, live: boolean, isAgentFile: boolean) {
  const agent = isAgentFile || r.isSidechain === true
  const ts = Date.parse(r.timestamp ?? '') || Date.now()
  switch (r.type) {
    case 'ai-title':
      if (typeof r.aiTitle === 'string' && !agent) title = r.aiTitle
      return
    case 'system':
      if (r.subtype === 'turn_duration' && !agent) {
        stats.turns++
        mode = 'idle'
        pendingTools.clear()
        const secs = Math.round((r.durationMs ?? 0) / 1000)
        say(`-- turn ${stats.turns} done in ${secs}s`, 'prompt')
        if (live && secs >= 30) flash(`${secs}s in the construct. done.`, 3000)
      } else if (r.subtype === 'local_command' && typeof r.content === 'string') {
        const cmd = /<command-name>(.*?)<\/command-name>[\s\S]*?<command-args>(.*?)<\/command-args>/.exec(r.content)
        if (cmd) {
          say(`↑ ${cmd[1]} ${cmd[2]}`.trim(), 'prompt')
          if (live) emit(`${cmd[1]} ${cmd[2]}`, 'prompt', -1)
        }
      }
      return
    case 'user': {
      const content = r.message?.content
      if (typeof content === 'string') {
        if (r.isMeta || r.isCompactSummary) return
        const text = stripTags(content).trim()
        if (!text) return
        say(`↑ you  ${short(text)}`, agent ? 'agent' : 'prompt')
        if (live) {
          emit(text, agent ? 'agent' : 'prompt', -1, 240)
          mode = 'thinking'
          bump(0.6)
        }
        return
      }
      if (!Array.isArray(content)) return
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const pend = pendingTools.get(b.tool_use_id)
          pendingTools.delete(b.tool_use_id)
          const text = resultText(b.content)
          const secs = pend ? ((ts - pend.at) / 1000).toFixed(1) + 's' : ''
          const name = pend?.name ?? 'tool'
          if (b.is_error) {
            stats.errors++
            say(`↑ x ${name} ${secs}  ${short(text)}`, 'err')
            if (live) {
              emit(text, 'err', -1, 80)
              bump(0.5)
            }
          } else {
            say(`↑ ${name} ${secs}  ${short(text.split('\n')[0] ?? '', 70)}  (${text.length} chars)`, agent ? 'agent' : 'result')
            if (live) emit(text, agent ? 'agent' : 'result', -1, 60)
          }
          if (pendingTools.size === 0 && mode === 'tools') mode = 'thinking'
        } else if (b?.type === 'text' && !r.isMeta && live && !agent) {
          // skill bodies, attachments: input the model reads
          emit(b.text ?? '', 'in', -1, 50)
        }
      }
      return
    }
    case 'assistant': {
      const m = r.message ?? {}
      const content = Array.isArray(m.content) ? m.content : []
      // usage repeats on each block's record: count deltas per message id
      const u = m.usage
      if (u && m.id && !agent) {
        const was = seenUsage.get(m.id)
        const outNow = u.output_tokens ?? 0
        const thinkNow = u.output_tokens_details?.thinking_tokens ?? 0
        if (!was) {
          const input = u.input_tokens ?? 0
          const cr = u.cache_read_input_tokens ?? 0
          const cw = u.cache_creation_input_tokens ?? 0
          stats.input += input
          stats.cacheRead += cr
          stats.cacheWrite += cw
          if (live) {
            anonUp += Math.min(W * 2, Math.round(Math.log2(1 + input + cr + cw) * 6))
            say(`↑ context  ${(input + cr + cw).toLocaleString()} tokens sent (${cr.toLocaleString()} from cache)`, 'cache')
          }
        }
        const dOut = outNow - (was?.out ?? 0)
        const dThink = thinkNow - (was?.think ?? 0)
        if (dOut > 0) stats.out += dOut
        if (dThink > 0) {
          stats.think += dThink
          if (live) anonDown += Math.min(W * 3, Math.ceil(dThink / 4))
        }
        seenUsage.set(m.id, { out: Math.max(outNow, was?.out ?? 0), think: Math.max(thinkNow, was?.think ?? 0) })
        if (seenUsage.size > 2000) seenUsage.delete(seenUsage.keys().next().value!)
      }
      for (const b of content) {
        if (b?.type === 'text' && b.text) {
          say(`↓ claude  ${short(b.text)}`, agent ? 'agent' : 'out')
          if (live) {
            emit(b.text, agent ? 'agent' : 'out', 1, 400)
            mode = 'writing'
            bump(0.3)
          }
        } else if (b?.type === 'thinking') {
          if (live) {
            mode = 'thinking'
            bump(0.2)
            if (b.thinking) emit(b.thinking, 'think', 1, 120)
            else anonDown += 12
          }
        } else if (b?.type === 'tool_use') {
          stats.tools++
          const { detail, isFile } = toolDetail(b.name, b.input)
          const name = toolName(b.name)
          pendingTools.set(b.id, { name, at: ts, detail })
          say(`↓ ${agent ? 'agent ' : ''}${name}  ${short(isFile ? detail.replace(os.homedir(), '~') : detail)}`, agent ? 'agent' : isFile ? 'file' : 'tool')
          if (live) {
            emit(`${name} ${isFile ? path.basename(detail) : ''}`, isFile ? 'file' : 'tool', 1, 20)
            emit(JSON.stringify(b.input ?? {}), agent ? 'agent' : 'tool', 1, 80)
            mode = 'tools'
            bump(0.35)
          }
        }
      }
      return
    }
  }
}

// ─── tailing ─────────────────────────────────────────────────────────────
type Tail = { file: string; offset: number; rest: string; isAgent: boolean }
const tails = new Map<string, Tail>()

function readNew(t: Tail, live: boolean) {
  let st: fs.Stats
  try {
    st = fs.statSync(t.file)
  } catch {
    return
  }
  if (st.size < t.offset) {
    t.offset = 0
    t.rest = ''
  }
  if (st.size === t.offset) return
  const fd = fs.openSync(t.file, 'r')
  try {
    const len = Math.min(st.size - t.offset, 8 * 1024 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, t.offset)
    t.offset += len
    const text = t.rest + buf.toString('utf8')
    const lines = text.split('\n')
    t.rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        ingest(JSON.parse(line), live, t.isAgent)
      } catch {
        // a line we can't read: skip it
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

function newestSession(): string | undefined {
  if (PIN_SESSION) {
    if (fs.existsSync(PIN_SESSION)) return path.resolve(PIN_SESSION)
  }
  let best: { file: string; mtime: number } | undefined
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(ROOT)
  } catch {
    return undefined
  }
  for (const d of dirs) {
    if (PIN_PROJECT && !d.includes(PIN_PROJECT)) continue
    const dir = path.join(ROOT, d)
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      if (PIN_SESSION && !f.startsWith(PIN_SESSION)) continue
      try {
        const m = fs.statSync(path.join(dir, f)).mtimeMs
        if (!best || m > best.mtime) best = { file: path.join(dir, f), mtime: m }
      } catch {}
    }
  }
  return best?.file
}

function agentFiles(session: string): string[] {
  const dir = session.replace(/\.jsonl$/, '')
  const found: string[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 2) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name.endsWith('.jsonl')) found.push(p)
    }
  }
  walk(dir, 0)
  return found
}

function attach(file: string) {
  tails.clear()
  sessionFile = file
  title = ''
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0
  seenUsage.clear()
  pendingTools.clear()
  log.length = 0
  queue.length = 0
  // backfill from the start: stats and console, no rain
  const t: Tail = { file, offset: 0, rest: '', isAgent: false }
  readNew(t, false)
  tails.set(file, t)
  for (const a of agentFiles(file)) {
    const at: Tail = { file: a, offset: 0, rest: '', isAgent: true }
    readNew(at, false)
    tails.set(a, at)
  }
  mode = 'idle'
  pendingTools.clear()
  flash(title ? `Jacking in: ${title}` : 'Wake up, Neo...', 4000)
}

let lastScan = 0
function poll() {
  const now = Date.now()
  if (now - lastScan > 1500) {
    lastScan = now
    const newest = newestSession()
    if (newest && newest !== sessionFile) {
      let recent = !sessionFile
      try {
        recent ||= now - fs.statSync(newest).mtimeMs < 15000
      } catch {}
      if (recent) attach(newest)
    }
    if (sessionFile)
      for (const a of agentFiles(sessionFile))
        if (!tails.has(a)) tails.set(a, { file: a, offset: 0, rest: '', isAgent: true })
  }
  for (const t of tails.values()) readNew(t, true)
}

// ─── terminal ────────────────────────────────────────────────────────────
function restore() {
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l')
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
}
function start() {
  if (!process.stdout.isTTY) {
    console.error('digital-rain needs a terminal (run it in its own window or split).')
    process.exit(1)
  }
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[48;2;0;0;0m\x1b[2J')
  resize()
  process.stdout.on('resize', () => {
    resize()
    process.stdout.write('\x1b[48;2;0;0;0m\x1b[2J')
  })
  process.on('exit', restore)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (d: Buffer) => {
      const key = d.toString()
      if (key === 'q' || key === '\x03' || key === '\x1b') process.exit(0)
      else if (key === 'p' || key === ' ') paused = !paused
      else if (key === 'c') {
        showConsole = !showConsole
        resize()
      } else if (key === '+' || key === '=') FRAME_MS = Math.max(20, FRAME_MS - 10)
      else if (key === '-' || key === '_') FRAME_MS = Math.min(200, FRAME_MS + 10)
    })
  }

  poll()
  if (!sessionFile) {
    say(`waiting for a Claude Code session under ${ROOT}`, 'prompt')
    flash('Wake up, Neo...', 5000)
  }
  const loop = () => {
    try {
      poll()
      if (!paused) step()
      paint()
    } catch (err) {
      restore()
      console.error(err)
      process.exit(1)
    }
    setTimeout(loop, FRAME_MS)
  }
  loop()
}

start()
