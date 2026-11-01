import type { Register } from 'claude-code'

import { endDecodeTurn, installDecode, isDecoding, setDecode, startDecode } from './decode'

// DIGITAL RAIN: Matrix mode for Claude Code. New text in the conversation decodes
// out of flickering katakana, and the spinner speaks in half-decoded code.
export const register: Register = on => {
  installDecode(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'matrix',
      description: 'Matrix decode effect: `/matrix on`, `/matrix off`, or `/matrix` to toggle',
      argumentHint: '[on | off]',
    })
    setDecode((await $.store.get('decode')) !== false)
    startDecode($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) endDecodeTurn()
    return next(e)
  })

  on('command.run', { command: 'matrix' }, async ($, e) => {
    const arg = e.args.trim().replace(/^decode\s*/i, '').toLowerCase()
    const isOn = arg === 'on' ? true : arg === 'off' ? false : !isDecoding()
    setDecode(isOn)
    await $.store.set('decode', isOn)
    $.ui.invalidate('ui.render')
    return {
      text: isOn
        ? 'Matrix decode is on.'
        : 'Matrix decode is off.',
    }
  })
}
