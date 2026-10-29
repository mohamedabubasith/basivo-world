import type { AgentInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'basivo-world',
  component: 'Pane',
  requestId: 'basivo-world',
  props: {
    title: 'World',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// Everything beneath the plugin: each hook here stands for the engine.
function engine(on: On, roster: AgentInfo[] = []) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/t' })
  const writes = new Map<string, string>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: roster }))
  on('fs.read', (_, e) => ({ value: `/* ${e.path} */` }))
  on('fs.write', (_, e) => {
    writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', (_, e) => ({ model: 'haiku', agentId: e.description }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 0,
        model: 'haiku',
      },
    }
  })
  return { clock, writes }
}

// A spawn as the engine raises it, the Agent tool's call behind it.
function spawn(description: string, subagentType: string, parentAgentId?: string) {
  return {
    tool_use_id: `tu-${description}`,
    prompt: description,
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'sonnet',
    parentAgentId,
    background: false,
    fork: false,
  }
}

async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'haiku', messageCount: 1, agentId })
  for await (const _ of stream) {
    // drain
  }
  return stream.result
}

async function rows($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ ...PANE, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

test('a nested helper shows in the pane under its parent, on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The engine's spawn hook beneath answers with the description as the id.
  await $.agent.spawn(spawn('r1', 'reviewer'))
  await $.agent.spawn(spawn('p1', 'pinger', 'r1'))
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'p1' })

  for (const surface of SURFACES) {
    const lines = await rows($, surface)
    expect(lines.some(l => /^└─ ◐ reviewer {2}waiting on a helper/.test(l))).toBe(true)
    expect(lines.some(l => /^ {3}└─ ● pinger/.test(l))).toBe(true)
    expect(lines[0]).toContain('2 helpers')
    expect(lines[0]).toContain('depth 2')
  }
})

test('tokens are charged to the helper whose request spent them', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn('a1', 'Explore'))
  await step($, 'a1')
  await step($, 'a1')
  // 2 requests × (1000 in + 200 out × 5 + 5000 cache read × 0.1) = 2 × 2500
  const lines = await rows($, 'desktop')
  expect(lines.some(l => /● Explore .* 5\.0k$/.test(l))).toBe(true)
})

test('usage from a loop no roster names is counted, never drawn', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($, 'compaction-fork')
  const lines = await rows($, 'desktop')
  expect(lines.some(l => l.includes('compaction-fork'))).toBe(false)
  expect(lines[0]).toContain('0 helpers')
})

test('a helper the spawn hook never saw is recovered from the roster', async ($, on) => {
  engine(on, [{ id: 'e1', type: 'Explore', description: 'look around', status: 'running' }])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'e1' })
  const lines = await rows($, 'desktop')
  // Recovered with its type and place in the tree; the Read has finished, so it is thinking.
  expect(lines.some(l => /^└─ ● Explore {2}thinking/.test(l))).toBe(true)
})

test('a finished helper is done, and the parent stops waiting', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'm' })
  await $.agent.spawn(spawn('r1', 'reviewer'))
  expect((await rows($, 'desktop'))[1]).toContain('◐ main')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'r', agentId: 'r1', reason: 'answer' })
  const lines = await rows($, 'desktop')
  expect(lines.some(l => /✓ reviewer {2}done/.test(l))).toBe(true)
  expect(lines[1]).toContain('● main')
})

test('the pane says so plainly when nothing has been delegated', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const lines = await rows($, 'desktop')
  expect(lines.some(l => l.startsWith('No helpers yet'))).toBe(true)
})

test('/world publishes the browser view, and state.js follows the world', async ($, on) => {
  const { clock, writes } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Nothing is written anywhere until the person asks for the browser view.
  expect(writes.size).toBe(0)

  const reply = await $.command.run({
    command: 'world',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  const dir = '/home/t/.claude/basivo-world/sess-1'
  expect(reply.text).toContain(`file://${dir}/index.html`)
  for (const file of ['index.html', 'world.js', 'sprites.js', 'demo.js']) expect(writes.has(`${dir}/${file}`)).toBe(true)

  const snapshot = () => JSON.parse(String(writes.get(`${dir}/state.js`)).replace(/^window\.__BASIVO_WORLD__ = /, '').replace(/;\n$/, ''))
  expect(snapshot().agents.map((a: { id: string }) => a.id)).toEqual(['main'])

  await $.agent.spawn(spawn('h1', 'tester'))
  // Writes are batched: nothing new until the quarter-second passes.
  expect(snapshot().agents.length).toBe(1)
  await clock.advance(300)
  expect(snapshot().agents.map((a: { id: string }) => a.id)).toEqual(['main', 'h1'])
  expect(snapshot().agents[1].type).toBe('tester')
})
