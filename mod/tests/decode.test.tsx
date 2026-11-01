import { expect, test } from 'claude-code/testing'

test('a new reply reaches the engine scrambled, its markup kept', async ($, on) => {
  let drawn = ''
  on('ui.render', ($, e) => {
    if (e.component === 'AssistantMessage') drawn = e.props.text
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({
    plugin: 'digital-rain',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    props: { text: '**Hello** world, 42 times', isFirstOfReply: true },
  })
  expect(drawn).not.toBe('**Hello** world, 42 times')
  expect(drawn.startsWith('**')).toBe(true)
  expect(drawn.length).toBe('**Hello** world, 42 times'.length)
  expect(/[ｦ-ﾝ]/.test(drawn)).toBe(true)
  await ui.unmount()
})
