// Sample data for basivo-world's ?demo mode: a scripted crew on a 22-second loop,
// in exactly the shape the mod writes. The page labels it as demo data, always.
'use strict'

const Demo = (() => {
  const LOOP = 22_000
  // id, parent, type, what it was asked, background?, from, to, how it ended
  const CAST = [
    ['b1', 'main', 'indexer', 'index the repository', true, 600, 15_000, 'done'],
    ['r1', 'main', 'reviewer', 'review the change for issue #42', false, 1_200, 13_000, 'done'],
    ['t1', 'r1', 'tester', 'write the missing tests', false, 2_400, 9_500, 'done'],
    ['s1', 'r1', 'security', 'check the new endpoint', false, 2_800, 11_000, 'done'],
    ['x1', 't1', 'Explore', 'find the existing fixtures', false, 4_000, 7_000, 'done'],
    ['l1', 't1', 'linter', 'run the type checker', false, 5_000, 8_000, 'failed'],
  ]
  const TOOLS = {
    main: ['Read', 'Grep', 'Agent'],
    indexer: ['Glob', 'Read', 'Read', 'Bash'],
    reviewer: ['Read', 'Grep', 'Agent'],
    tester: ['Read', 'Edit', 'Bash', 'Bash'],
    security: ['Grep', 'Read', 'WebFetch'],
    Explore: ['Glob', 'Grep', 'Read'],
    linter: ['Bash', 'Bash'],
  }
  // Tokens a second of work: fresh input, output, cache read.
  const RATE = {
    main: [40, 90, 9_000],
    indexer: [30, 20, 3_000],
    reviewer: [35, 70, 7_000],
    tester: [60, 160, 16_000],
    security: [30, 60, 6_000],
    Explore: [20, 30, 4_000],
    linter: [10, 15, 1_500],
  }

  const weighted = t => t.input + t.output * 5 + t.cacheWrite * 1.25 + t.cacheRead * 0.1

  function at(wall) {
    const t = wall % LOOP
    const epoch = wall - t
    const agents = []
    const make = (id, parentId, type, label, isBackground, from, to, ending) => {
      const isOver = t >= to
      const worked = Math.max(0, Math.min(t, to) - from) / 1000
      const [i, o, cr] = RATE[type]
      const tokens = {
        input: Math.round(i * worked),
        output: Math.round(o * worked),
        cacheRead: Math.round(cr * worked),
        cacheWrite: Math.round(i * worked * 6),
      }
      const tools = TOOLS[type]
      const step = Math.floor((t + from * 0.37) / 1_100)
      return {
        id,
        parentId,
        type,
        label,
        status: isOver ? ending : 'running',
        isBackground,
        tool: isOver ? null : tools[step % tools.length],
        toolCalls: Math.floor(worked / 1.1),
        tokens,
        model: type === 'main' ? 'opus' : type === 'Explore' || type === 'indexer' ? 'haiku' : 'sonnet',
        startedAt: epoch + from,
        lastAt: wall,
        endedAt: isOver ? epoch + to : null,
        isOrphan: false,
        weight: weighted(tokens),
      }
    }

    const mainEnd = 18_000
    agents.push({
      ...make('main', null, 'main', 'main session', false, 0, mainEnd, 'idle'),
      status: t >= mainEnd ? 'idle' : 'running',
    })
    for (const c of CAST) if (t >= c[5]) agents.push(make(...c))

    // The same rule as the mod's view(): a parent blocked on a foreground helper waits.
    const byId = new Map(agents.map(a => [a.id, a]))
    const isLive = a => a.status === 'running'
    for (const a of agents) {
      const blocked = agents.some(k => k.parentId === a.id && !k.isBackground && isLive(k))
      a.shown = a.status === 'running' && blocked ? 'waiting' : a.status
      let depth = 0
      for (let p = a.parentId; p && byId.has(p); p = byId.get(p).parentId) depth += 1
      a.depth = depth
    }
    // Depth-first, as the mod lays them out.
    const ordered = []
    const walk = id => {
      const a = byId.get(id)
      if (!a) return
      ordered.push(a)
      for (const k of agents) if (k.parentId === id) walk(k.id)
    }
    walk('main')

    const counts = { running: 0, waiting: 0, idle: 0, done: 0, failed: 0, stopped: 0, all: 0, maxDepth: 0 }
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const a of ordered) {
      counts[a.shown] += 1
      counts.all += 1
      counts.maxDepth = Math.max(counts.maxDepth, a.depth)
      for (const k of Object.keys(totals)) totals[k] += a.tokens[k]
    }
    return {
      agents: ordered,
      totals: { ...totals, weighted: weighted(totals) },
      counts,
      unattributed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      startedAt: epoch,
      // Quantised, so the page re-lays the world four times a second, not every frame.
      updatedAt: wall - (wall % 250),
    }
  }

  return { at, LOOP }
})()

if (typeof module !== 'undefined') module.exports = Demo
