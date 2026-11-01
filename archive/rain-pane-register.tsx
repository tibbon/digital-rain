import type { EngineInterface, Register } from 'claude-code'

import { endDecodeTurn, installDecode, isDecoding, setDecode, startDecode } from './decode'

// ─── DIGITAL RAIN ────────────────────────────────────────────────────────────
// A pane of falling green code. Ambient rain is random katakana; everything
// Claude actually does (your prompt, its thinking, its words, every tool call,
// file and error) falls as readable vertical streams, tinted by kind. The
// bottom rows are an operator console, the top row the live status.

const PANE = 'digital-rain'
const KEY = 'rain'
const FRAME_MS = 66 // ~15 fps

type Kind =
  | 'ambient'
  | 'prompt'
  | 'text'
  | 'think'
  | 'tool'
  | 'file'
  | 'ok'
  | 'err'
  | 'agent'
  | 'sys'

const KINDS: Kind[] = ['ambient', 'prompt', 'text', 'think', 'tool', 'file', 'ok', 'err', 'agent', 'sys']
const PALETTE: Record<Kind, [number, number, number]> = {
  ambient: [0, 255, 70],
  prompt: [200, 255, 230],
  text: [80, 255, 120],
  think: [40, 200, 170],
  tool: [180, 255, 60],
  file: [255, 220, 90],
  ok: [120, 255, 160],
  err: [255, 60, 60],
  agent: [120, 200, 255],
  sys: [210, 255, 210],
}
// how fast a trail fades per frame, by kind: words linger so they can be read
const FADE: Record<Kind, number> = {
  ambient: 0.07,
  prompt: 0.012,
  text: 0.018,
  think: 0.03,
  tool: 0.014,
  file: 0.014,
  ok: 0.02,
  err: 0.01,
  agent: 0.018,
  sys: 0.02,
}

const BLACK = 0x000000
const CONSOLE_BG = 0x000a02

// ─── glyphs ──────────────────────────────────────────────────────────────
const KATAKANA_START = 0xff66 // halfwidth katakana: single-cell wide
const KATAKANA_END = 0xff9d
const EXTRA = '0123456789:.=*+-<>|Z'
function randomGlyph(): number {
  if (Math.random() < 0.18) return EXTRA.charCodeAt((Math.random() * EXTRA.length) | 0)
  return KATAKANA_START + ((Math.random() * (KATAKANA_END - KATAKANA_START + 1)) | 0)
}
function cellCode(ch: string): number {
  const c = ch.codePointAt(0) ?? 32
  if (c >= 0x20 && c <= 0x7e) return c
  if (c >= 0xa1 && c <= 0xff && c !== 0xad) return c
  if (c === 0x09 || c === 0x0a || c === 0x0d) return 32
  return randomGlyph()
}

// ─── the world (module state: a reload starts the rain over, on purpose) ──
type Drop = {
  x: number
  y: number // head position, rows, float
  row: number // last row written
  speed: number
  kind: Kind
  text?: number[] // payload code points, top to bottom
  i: number
  tail: number // ambient: random glyphs left to write after start
}
type LogLine = { text: string; kind: Kind; at: number }
type Running = { name: string; detail: string; at: number }

let W = 0
let H = 0
let glyph = new Uint32Array(0)
let bright = new Float32Array(0)
let kindOf = new Uint8Array(0)
let drops: Drop[] = []
const queue: { text: string; kind: Kind }[] = []
const log: LogLine[] = []
const running = new Map<string, Running>()
let activity = 0.3
let mode: 'idle' | 'thinking' | 'speaking' | 'tools' = 'idle'
let mounted = false
let frame = 0
let stats = { turns: 0, tools: 0, errors: 0, files: new Set<string>() }
let banner: { text: string; at: number; until: number } | undefined
let ticker: { cancel: () => void } | undefined

function resize(cols: number, rows: number) {
  if (cols === W && rows === H) return
  const g = new Uint32Array(cols * rows)
  const b = new Float32Array(cols * rows)
  const k = new Uint8Array(cols * rows)
  for (let y = 0; y < Math.min(rows, H); y++)
    for (let x = 0; x < Math.min(cols, W); x++) {
      g[y * cols + x] = glyph[y * W + x]!
      b[y * cols + x] = bright[y * W + x]!
      k[y * cols + x] = kindOf[y * W + x]!
    }
  W = cols
  H = rows
  glyph = g
  bright = b
  kindOf = k
  drops = drops.filter(d => d.x < W)
}

function consoleRows() {
  return H >= 14 ? 4 : H >= 9 ? 2 : 0
}
function rainTop() {
  return H >= 6 ? 1 : 0
}
function rainBottom() {
  // last row the rain may write to, exclusive
  const c = consoleRows()
  return c > 0 ? H - c - 1 : H
}

// ─── feeding it ──────────────────────────────────────────────────────────
function now() {
  return Date.now()
}
function bump(n: number) {
  activity = Math.min(1, activity + n)
}
function say(text: string, kind: Kind) {
  log.push({ text, kind, at: now() })
  if (log.length > 40) log.splice(0, log.length - 40)
}
function rain(text: string, kind: Kind) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return
  const max = Math.max(6, rainBottom() - rainTop() - 3)
  // split long strings at spaces into column-sized pieces
  let rest = clean
  while (rest.length > 0) {
    let piece = rest.slice(0, max)
    if (rest.length > max) {
      const cut = piece.lastIndexOf(' ')
      if (cut > max / 2) piece = piece.slice(0, cut)
    }
    queue.push({ text: piece.trim(), kind })
    rest = rest.slice(piece.length).trim()
  }
  if (queue.length > 80) queue.splice(0, queue.length - 80)
}
function flash(text: string, ms = 3500) {
  banner = { text, at: now(), until: now() + ms }
}

function short(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '~' : one
}
function base(p: string) {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}
function describeTool(tool: string, e: Record<string, unknown>): { detail: string; isFile: boolean } {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined)
  const file = str('file_path') ?? str('notebook_path')
  if (file) return { detail: base(file), isFile: true }
  const detail =
    str('command') ??
    str('pattern') ??
    str('url') ??
    str('query') ??
    str('description') ??
    str('skill') ??
    str('path') ??
    str('prompt') ??
    Object.values(e).find((v): v is string => typeof v === 'string' && v.length > 0 && v !== tool) ??
    ''
  return { detail, isFile: false }
}
function toolLabel(tool: string) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? `${m[1]}:${m[2]}` : tool
}

// ─── simulation ──────────────────────────────────────────────────────────
function freeColumn(): number | undefined {
  const busy = new Set(drops.filter(d => d.text && d.y < rainBottom()).map(d => d.x))
  for (let tries = 0; tries < 12; tries++) {
    const x = (Math.random() * W) | 0
    if (!busy.has(x) && !busy.has(x - 1) && !busy.has(x + 1)) return x
  }
  return undefined
}

function step() {
  frame++
  const top = rainTop()
  const bottom = rainBottom()
  const kindIdx = (k: Kind) => KINDS.indexOf(k)

  // fade
  for (let i = 0; i < bright.length; i++) {
    const b = bright[i]!
    if (b <= 0) continue
    bright[i] = Math.max(0, b - FADE[KINDS[kindOf[i]!]!])
    // ambient glyphs shimmer
    if (kindOf[i] === 0 && Math.random() < 0.02) glyph[i] = randomGlyph()
  }

  // spawn payload drops, a couple per frame at most
  for (let n = 0; n < 2 && queue.length > 0; n++) {
    const x = freeColumn()
    if (x === undefined) break
    const next = queue.shift()!
    drops.push({
      x,
      y: top - Math.random() * 3,
      row: top - 4,
      speed: 0.32 + Math.random() * 0.2,
      kind: next.kind,
      text: Array.from(next.text).map(cellCode),
      i: 0,
      tail: 0,
    })
  }

  // ambient rain, denser when Claude is busy
  activity = Math.max(mode === 'idle' ? 0.08 : 0.35, activity * 0.985)
  const spawn = W * (0.006 + 0.05 * activity)
  for (let s = spawn; s > 0; s--) {
    if (Math.random() > s) break
    drops.push({
      x: (Math.random() * W) | 0,
      y: top,
      row: top - 1,
      speed: 0.35 + Math.random() * (0.5 + activity * 0.7),
      kind: 'ambient',
      i: 0,
      tail: 6 + ((Math.random() * (H * 0.8)) | 0),
    })
  }

  // move
  const kept: Drop[] = []
  for (const d of drops) {
    d.y += d.speed
    let alive = true
    while (d.row < Math.floor(d.y)) {
      d.row++
      if (d.row < top) continue
      if (d.row >= bottom) {
        alive = false
        break
      }
      let code: number
      if (d.text) {
        if (d.i >= d.text.length) {
          alive = false
          break
        }
        code = d.text[d.i++]!
      } else {
        if (d.tail-- <= 0) {
          alive = false
          break
        }
        code = randomGlyph()
      }
      const at = d.row * W + d.x
      if (d.kind === 'ambient' && kindOf[at] !== 0 && bright[at]! > 0.25) continue // don't overwrite words
      glyph[at] = code
      bright[at] = 1
      kindOf[at] = kindIdx(d.kind)
    }
    if (alive) kept.push(d)
  }
  drops = kept
}

// ─── drawing ─────────────────────────────────────────────────────────────
function scale(rgb: [number, number, number], b: number) {
  const f = Math.max(0, Math.min(1, b))
  const r = (rgb[0] * f) | 0
  const g = (rgb[1] * f) | 0
  const bl = (rgb[2] * f) | 0
  return (r << 16) | (g << 8) | bl
}

function encodeFrame(): string {
  const words = new Uint32Array(W * H * 3)
  const put = (x: number, y: number, code: number, fg: number, bg: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const o = (y * W + x) * 3
    words[o] = code
    words[o + 1] = fg
    words[o + 2] = bg
  }
  const write = (x: number, y: number, s: string, fg: number, bg: number) => {
    let i = 0
    for (const ch of s) put(x + i++, y, cellCode(ch), fg, bg)
  }

  // rain
  const heads = new Set<number>()
  for (const d of drops) if (d.row >= rainTop() && d.row < rainBottom()) heads.add(d.row * W + d.x)
  for (let i = 0; i < W * H; i++) {
    const o = i * 3
    const b = bright[i]!
    if (b <= 0.02) {
      words[o] = 32
      words[o + 1] = BLACK
      words[o + 2] = BLACK
      continue
    }
    const k = KINDS[kindOf[i]!]!
    words[o] = glyph[i] || 32
    if (heads.has(i)) {
      words[o + 1] = k === 'err' ? 0xffd0d0 : 0xe8ffe8
    } else {
      // words stay bright longer; rain trails fall off fast
      const curve = k === 'ambient' ? b * b : Math.sqrt(b)
      words[o + 1] = scale(PALETTE[k], 0.15 + 0.85 * curve)
    }
    words[o + 2] = BLACK
  }

  // status row
  if (rainTop() > 0) {
    for (let x = 0; x < W; x++) put(x, 0, 32, 0, CONSOLE_BG)
    const live = [...running.values()].pop()
    const spin = '|/-\\'[frame % 4]
    let state: string
    if (live) state = `${spin} ${toolLabel(live.name)} ${((now() - live.at) / 1000).toFixed(1)}s`
    else if (mode === 'thinking') state = `${spin} thinking`
    else if (mode === 'speaking') state = `${spin} speaking`
    else state = 'idle'
    const left = ` DIGITAL RAIN  ${state}`
    const right = `turn ${stats.turns}  tools ${stats.tools}  files ${stats.files.size}  err ${stats.errors} `
    write(0, 0, left, mode === 'idle' && !live ? 0x2f8f4f : 0xb0ffb0, CONSOLE_BG)
    if (left.length + right.length + 2 <= W) write(W - right.length, 0, right, stats.errors ? 0x9fdf9f : 0x4faf6f, CONSOLE_BG)
    if (stats.errors && left.length + right.length + 2 <= W) {
      const errText = `err ${stats.errors} `
      write(W - errText.length, 0, errText, 0xff7070, CONSOLE_BG)
    }
  }

  // console
  const c = consoleRows()
  if (c > 0) {
    const sep = H - c - 1
    for (let x = 0; x < W; x++) put(x, sep, 0x2500, 0x0f5f2a, BLACK)
    const lines = log.slice(-c)
    for (let r = 0; r < c; r++) {
      const y = H - c + r
      for (let x = 0; x < W; x++) put(x, y, 32, 0, CONSOLE_BG)
      const line = lines[r - (c - lines.length)]
      if (!line) continue
      const age = r === c - 1 ? 1 : 0.55 + 0.15 * (r / c)
      const color = scale(PALETTE[line.kind], age)
      write(1, y, short(line.text, W - 2), color, CONSOLE_BG)
    }
  }

  // center banner, typed out
  if (banner && now() < banner.until) {
    const shown = Math.min(banner.text.length, Math.floor((now() - banner.at) / 45))
    const text = banner.text.slice(0, shown) + (frame % 8 < 4 ? '_' : ' ')
    const width = Math.min(W - 2, banner.text.length + 4)
    const x0 = Math.max(0, ((W - width) / 2) | 0)
    const y0 = Math.max(rainTop(), ((rainBottom() - rainTop()) / 2 + rainTop()) | 0)
    for (let x = x0; x < x0 + width; x++) put(x, y0, 32, 0, BLACK)
    write(x0 + 2, y0, short(text, width - 2), 0xd8ffd8, BLACK)
  } else banner = undefined

  return toBase64(new Uint8Array(words.buffer))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  const at = (n: number) => bytes[n] ?? 0
  const c = (n: number) => B64.charAt(n & 63)
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2)
    out += c((n >> 18)) + c((n >> 12)) + c((n >> 6)) + c(n)
  }
  const left = bytes.length - i
  if (left === 1) {
    const n = at(i) << 16
    out += c((n >> 18)) + c((n >> 12)) + '=='
  } else if (left === 2) {
    const n = (at(i) << 16) | (at(i + 1) << 8)
    out += c((n >> 18)) + c((n >> 12)) + c((n >> 6)) + '='
  }
  return out
}

// ─── the loop ────────────────────────────────────────────────────────────
let blitting = false
function tick($: EngineInterface) {
  if (!mounted || W === 0 || blitting) return
  step()
  blitting = true
  $.ui
    .blit({ requestId: PANE, key: KEY, cells: encodeFrame(), columns: W, rows: H })
    .then(r => {
      if (r.deny !== undefined) mounted = false
    })
    .catch(() => {
      mounted = false
    })
    .finally(() => {
      blitting = false
    })
}

function safely(fn: () => void) {
  try {
    fn()
  } catch {
    // the rain must never break the session
  }
}

// ─── hooks ───────────────────────────────────────────────────────────────
export const register: Register = on => {
  installDecode(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'matrix',
      description: 'Matrix mode: `/matrix` opens the rain pane, `/matrix off` closes it, `/matrix decode on|off` toggles decoding text',
      argumentHint: '[off | decode on | decode off]',
    })
    ticker?.cancel()
    ticker = $.clock.every(FRAME_MS, () => tick($))
    setDecode((await $.store.get('decode')) !== false)
    startDecode($)
    flash('Wake up, Neo...', 4500)
    say('the Matrix has you. follow the white rabbit.', 'sys')
    // reopen the pane only if it was not closed last time
    if ((await $.store.get('pane')) !== false) void $.ui.open({ id: PANE, title: 'The Matrix' })
    return next(e)
  })

  on('command.run', { command: 'matrix' }, async ($, e) => {
    const decode = /^\s*decode\s*(on|off)?\s*$/i.exec(e.args)
    if (decode) {
      const isOn = decode[1] ? decode[1].toLowerCase() === 'on' : !isDecoding()
      setDecode(isOn)
      await $.store.set('decode', isOn)
      $.ui.invalidate('ui.render')
      return { text: isOn ? 'Decode is on: new text resolves out of the code.' : 'Decode is off: text shows plainly.' }
    }
    if (/^\s*(off|close|blue)\s*$/i.test(e.args)) {
      await $.ui.close({ id: PANE })
      await $.store.set('pane', false)
      mounted = false
      return { text: 'You took the blue pill. The Matrix pane is closed.' }
    }
    await $.store.set('pane', true)
    const opened = await $.ui.open({ id: PANE, title: 'The Matrix' })
    flash('Knock, knock, Neo.', 3000)
    return {
      text: opened.isPlaced
        ? 'You took the red pill. The Matrix pane is open.'
        : 'The Matrix pane will appear once the terminal is wide enough.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    safely(() => {
      if (e.text.trim().startsWith('/')) return
      rain(e.text, 'prompt')
      say(`you> ${e.text}`, 'prompt')
      mode = 'thinking'
      bump(0.6)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    safely(() => {
      if (e.agentId === undefined) stats.turns++
      if (mode === 'idle') mode = 'thinking'
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isAgent = e.agentId !== undefined
    const buffers = new Map<string, string>()
    const flush = (key: string, kind: Kind, force: boolean) => {
      const buf = buffers.get(key) ?? ''
      const cut = force ? buf.length : Math.max(buf.lastIndexOf(' '), buf.lastIndexOf('\n'))
      if (cut <= 0 || (!force && cut < 14)) return
      rain(buf.slice(0, cut), kind)
      buffers.set(key, buf.slice(cut))
    }
    const stream = next(e)
    for await (const chunk of stream) {
      safely(() => {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          const kind: Kind = isAgent ? 'agent' : chunk.kind === 'text' ? 'text' : 'think'
          const key = `${chunk.kind}:${chunk.index}`
          buffers.set(key, (buffers.get(key) ?? '') + chunk.text)
          flush(key, kind, false)
          if (!isAgent) mode = chunk.kind === 'text' ? 'speaking' : 'thinking'
          bump(0.03)
        }
      })
      yield chunk
    }
    safely(() => {
      for (const key of buffers.keys())
        flush(key, isAgent ? 'agent' : key.startsWith('text') ? 'text' : 'think', true)
    })
    return await stream.result
  })

  on('tool.call', async ($, e, next) => {
    const ev = e as unknown as { tool: string; tool_use_id?: string; agentId?: string } & Record<string, unknown>
    const id = ev.tool_use_id ?? `${ev.tool}-${now()}`
    let detail = ''
    safely(() => {
      const d = describeTool(ev.tool, ev)
      detail = d.detail
      const isAgent = ev.agentId !== undefined
      const kind: Kind = isAgent ? 'agent' : d.isFile ? 'file' : 'tool'
      if (d.isFile) stats.files.add(String((ev).file_path ?? detail))
      stats.tools++
      running.set(id, { name: ev.tool, detail, at: now() })
      mode = 'tools'
      rain(`${toolLabel(ev.tool)} ${detail}`, kind)
      say(`${isAgent ? '  agent ' : ''}> ${toolLabel(ev.tool)}  ${detail}`, kind)
      bump(0.35)
    })
    const ran = await next(e)
    safely(() => {
      const started = running.get(id)?.at ?? now()
      running.delete(id)
      const secs = ((now() - started) / 1000).toFixed(1)
      const failed = ran.deny !== undefined || ran.isError === true
      if (failed) {
        stats.errors++
        const why = ran.deny ?? ran.text ?? 'error'
        rain(`ERR ${toolLabel(ev.tool)} ${why}`, 'err')
        say(`x ${toolLabel(ev.tool)} ${secs}s  ${why}`, 'err')
        bump(0.5)
      } else {
        say(`+ ${toolLabel(ev.tool)} ${secs}s  ${short(detail, 60)}`, 'ok')
      }
      if (running.size === 0) mode = 'thinking'
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    safely(() => {
      if (e.agentId !== undefined) return
      endDecodeTurn()
      mode = 'idle'
      running.clear()
      const secs = Math.round(e.durationMs / 1000)
      if (e.isAborted) {
        say('-- interrupted. there is no spoon.', 'err')
      } else {
        say(`-- turn ${stats.turns} done in ${secs}s`, 'sys')
        if (secs >= 20) flash(`${secs}s in the construct. done.`, 3000)
      }
    })
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      mounted = false
      return <Text>The rain needs a terminal. Log: {log.slice(-1)[0]?.text ?? 'idle'}</Text>
    }
    const { Raster } = $.ui.resolve(e)
    const cols = Math.max(1, Math.min(512, e.props.bodyColumns))
    const rows = Math.max(3, Math.min(256, e.props.scroll.bodyRows))
    resize(cols, rows)
    mounted = true
    return <Raster key={KEY} columns={cols} rows={rows} cells={encodeFrame()} />
  })
}
