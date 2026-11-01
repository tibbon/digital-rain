# digital-rain

Matrix mode for Claude Code.

## The mod

New text in the conversation (replies, your messages, tool calls and their
results) arrives as flickering katakana and decodes, glyph by glyph, into what
it really says. The spinner speaks in half-decoded code ("Decoding",
"Transmitting", "Jacking in"), and now and then a few words of the latest reply
glitch back into code.

- `/matrix on`, `/matrix off`, or `/matrix` to toggle

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install digital-rain --marketplace tibbon/digital-rain
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in
every session).

From a shell:

```
claude plugin install digital-rain --marketplace tibbon/digital-rain
```

In the desktop app: click + next to the prompt box, then Plugins, Add
marketplace with `tibbon/digital-rain`, then Add plugin.

## The full-screen rain

`digital-rain.ts` is a standalone full-screen rain for a second terminal
window. It follows your most recently active Claude Code session by reading the
transcript Claude Code writes to `~/.claude/projects`:

- ↓ falling: output tokens (Claude → you): reply text, tool-call arguments,
  and thinking (unreadable glyphs, sized to the real thinking-token count)
- ↑ rising: input tokens (→ Claude): your prompts, tool results, and a faint
  surge sized to the context each request re-sends

```
node digital-rain.ts [--project <part of the project folder name>] [--session <id or file>]
```

Needs Node 23.6 or newer (it runs the TypeScript directly), no dependencies.
Keys: `q` quit, `p` pause, `c` console, `+` / `-` speed.

## Also here

`archive/` holds an earlier version of the mod: the rain drawn in a pane beside
the conversation.

## License

MIT
