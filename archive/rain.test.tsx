import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'digital-rain',
  component: 'Pane',
  requestId: 'digital-rain',
  props: {
    title: 'The Matrix',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the pane draws a raster on the terminal and text elsewhere', async ($, on) => {
  on('command.register', () => ({ value: { command: 'matrix' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Read', file_path: '/a/b/register.tsx' })

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const raster = await term.find({ type: 'Raster' })
  expect(raster).toBeDefined()
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desk.find({ type: 'Text' }))?.text).toMatch(/Read/)
  await desk.unmount()
})
