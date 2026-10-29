import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Status, World } from '../types'
import * as W from './world'

const PANE = 'basivo-world'
const WEB_FILES = ['index.html', 'world.js', 'sprites.js', 'demo.js'] as const

// Change the tag when World's fields change: it declines what an earlier version
// stored, which outlives a reload.
const world = atom({ plugin: 'basivo-world', key: 'world' } as const, W.emptyWorld(0), { shape: 'world-1' })
const browserDir = atom({ plugin: 'basivo-world', key: 'browserDir' } as const, null)
const isPaneOpened = atom({ plugin: 'basivo-world', key: 'isPaneOpened' } as const, false)

const GLYPH: Record<Status, string> = {
  running: '●',
  waiting: '◐',
  idle: '○',
  done: '✓',
  failed: '✗',
  stopped: '■',
}
const COLOR: Partial<Record<Status, string>> = { running: '#8b6dff', waiting: 'yellow', failed: 'red' }

function doing(a: W.ViewAgent): string {
  if (a.isStalled) return `quiet ${W.STALL_MS / 1000}s+`
  if (a.shown === 'running') return a.tool ?? 'thinking'
  if (a.shown === 'waiting') return 'waiting on a helper'
  return a.shown
}

function row(a: W.ViewAgent): string {
  const rails = a.rails
    .slice(1)
    .map(isLast => (isLast ? '   ' : '│  '))
    .join('')
  const branch = a.depth === 0 ? '' : a.isLast ? '└─ ' : '├─ '
  const orphan = a.isOrphan ? ' (parent unseen)' : ''
  return `${rails}${branch}${GLYPH[a.shown]} ${a.type}${orphan}  ${doing(a)}  ${W.fmtTokens(a.weight)}`
}

function summary(v: W.View): string {
  const helpers = v.counts.all - 1
  const parts = [
    `${helpers} helper${helpers === 1 ? '' : 's'}`,
    `${v.counts.running} running`,
    `${v.counts.waiting} waiting`,
  ]
  if (v.counts.maxDepth > 1) parts.push(`depth ${v.counts.maxDepth}`)
  parts.push(`≈${W.fmtTokens(v.totals.weighted)} weighted tokens`)
  return parts.join(' · ')
}

function fileUrl(dir: string): string {
  return encodeURI(`file://${dir.startsWith('/') ? '' : '/'}${dir}/index.html`)
}

// Module state: a hot reload starts these over, which is safe — the world itself is in
// $.state, and the roster refills anything forgotten.

// Loop ids no roster names — the engine's own forks, such as compaction. Remembered
// so their events are counted as unattributed without asking the roster each time.
const forks = new Set<string>()
let flush: { cancel: () => void } | null = null
let poll: { cancel: () => void } | null = null

async function publishState($: EngineInterface): Promise<void> {
  const dir = await read($, browserDir)
  if (!dir) return
  const v = W.view(await read($, world), await $.clock.now())
  await $.fs.write(`${dir}/state.js`, `window.__BASIVO_WORLD__ = ${JSON.stringify(v)};\n`)
}

// At most one write a quarter-second, however many events arrive in it.
function schedule($: EngineInterface): void {
  if (flush) return
  flush = $.clock.after(250, () => {
    flush = null
    void publishState($).catch(() => {})
  })
}

async function change($: EngineInterface, fn: (w: World, at: number) => World): Promise<void> {
  const at = await $.clock.now()
  await update($, world, w => fn(w, at))
  schedule($)
}

// The engine's roster settles what events missed: an agent spawned before a reload,
// or a status that changed with no event to carry it.
async function sync($: EngineInterface): Promise<void> {
  const roster = (await $.agent.list()).map(a => ({
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
    parentId: a.parentId,
  }))
  const at = await $.clock.now()
  const before = await read($, world)
  if (JSON.stringify(W.reconcile(before, roster, at).agents) === JSON.stringify(before.agents)) return
  await update($, world, w => W.reconcile(w, roster, at))
  schedule($)
}

// An agent's first events can race the hook that records its spawn, so an unknown
// loop is looked up in the roster before an event lands on it.
async function ensure($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId === undefined || forks.has(agentId)) return
  if ((await read($, world)).agents[agentId]) return
  await sync($)
  if (!(await read($, world)).agents[agentId]) forks.add(agentId)
}

async function publishWeb($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (!home) return null
  const dir = `${home.replace(/\\/g, '/')}/.claude/basivo-world/${await $.session.id()}`
  for (const file of WEB_FILES) {
    await $.fs.write(`${dir}/${file}`, await $.fs.read(`${$.plugin.root}/web/${file}`))
  }
  await update($, browserDir, () => dir)
  await publishState($)
  return dir
}

async function openInBrowser($: EngineInterface, url: string): Promise<boolean> {
  const openers = [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url]]
  for (const argv of openers) {
    try {
      if ((await $.process.run(argv)).exitCode === 0) return true
    } catch {
      // Not this platform's opener; try the next.
    }
  }
  return false
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'world',
      description: 'Show the live agent world: a pane here, and the pixel-art view in your browser',
    })
    const at = await $.clock.now()
    await update($, world, w => (w.startedAt === 0 ? W.emptyWorld(at) : w))
    await sync($).catch(() => {})
    // Statuses can change with no event, such as a helper the person stopped; poll the
    // roster, but only while some helper is still live.
    poll?.cancel()
    poll = $.clock.every(2000, () => {
      void (async () => {
        const w = await read($, world)
        const isLive = Object.values(w.agents).some(
          a => a.id !== W.MAIN && (a.status === 'running' || a.status === 'waiting' || a.status === 'idle'),
        )
        if (isLive) await sync($)
      })().catch(() => {})
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const id = spawned.agentId
    if (id === undefined) return spawned
    forks.delete(id)
    await change($, (w, at) =>
      W.spawn(w, {
        id,
        parentId: e.parentAgentId,
        type: e.subagentType || (e.fork ? 'fork' : 'agent'),
        label: e.description,
        isBackground: e.background,
        model: spawned.model,
        at,
      }),
    )
    // The world has something to show the first time a helper appears, so the pane
    // opens then, once, and never for a session that delegates nothing.
    if (!(await read($, isPaneOpened))) {
      await update($, isPaneOpened, () => true)
      void $.ui.open({ id: PANE, title: 'World' })
    }
    return spawned
  })

  on('turn.start', async ($, e, next) => {
    await ensure($, e.agentId)
    await change($, (w, at) => W.turnStart(w, e.agentId, at))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await ensure($, e.agentId)
    await change($, (w, at) => W.toolStart(w, e.agentId, e.tool, at))
    try {
      return await next(e)
    } finally {
      await change($, (w, at) => W.toolEnd(w, e.agentId, at))
    }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage) {
      await ensure($, e.agentId)
      await change($, (w, at) => W.addUsage(w, e.agentId, usage, usage.model, at))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    await ensure($, e.agentId)
    await change($, (w, at) => W.complete(w, e.agentId, e.reason, at))
    return ended
  })

  on('command.run', { command: 'world' }, async $ => {
    await update($, isPaneOpened, () => true)
    await $.ui.open({ id: PANE, title: 'World' })
    const dir = await publishWeb($)
    if (!dir) {
      return { text: 'The world pane is open. The browser view needs a home folder to write to, and none was found.' }
    }
    const url = fileUrl(dir)
    const isOpened = await openInBrowser($, url)
    return { text: isOpened ? `World opened in your browser: ${url}` : `Open the world in your browser: ${url}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = W.view(await read($, world), await $.clock.now())
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 4)
    const helpers = v.counts.all - 1
    const dir = await read($, browserDir)

    return (
      <Box flexDirection="column">
        <Text dimColor>{summary(v)}</Text>
        {v.agents.slice(0, room).map(a => (
          <Text
            color={COLOR[a.shown]}
            dimColor={a.shown === 'done' || a.shown === 'stopped'}
            wrap="truncate-end"
          >
            {row(a)}
          </Text>
        ))}
        {v.agents.length > room && <Text dimColor>… {v.agents.length - room} more</Text>}
        {helpers === 0 && <Text dimColor>No helpers yet. They appear here when Claude delegates.</Text>}
        <Text dimColor>
          {dir ? 'Also live in your browser. /world reopens it.' : '/world opens the pixel-art view in your browser.'}
        </Text>
      </Box>
    )
  })
}
