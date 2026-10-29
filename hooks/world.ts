// The world: every agent this session spawned, as a tree, with what each one is doing
// and what it has cost. Pure functions only — no engine calls — so the model is tested
// on its own and the mod is nothing but wiring.

export const MAIN = 'main'

import type { Agent, Status, Tokens, World } from '../types'

export type { Agent, Status, Tokens, World }

// The usage fields every model request reports.
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// The part of $.agent.list()'s AgentInfo the world reads.
export type RosterEntry = {
  id: string
  type: string
  description: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  parentId?: string
}

export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

// Past this many agents the oldest finished leaves are dropped, so a long session
// cannot grow the snapshot without bound.
export const MAX_AGENTS = 150
// A running agent silent this long is drawn as quiet. One long model request with deep
// thinking can run past 30s with no event in it, so the bar is high enough not to call
// a hard-working agent stuck.
export const STALL_MS = 90_000

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export function emptyWorld(at: number): World {
  return {
    startedAt: at,
    updatedAt: at,
    agents: {
      [MAIN]: {
        id: MAIN,
        parentId: null,
        type: 'main',
        label: 'main session',
        status: 'idle',
        isBackground: false,
        tool: null,
        toolCalls: 0,
        tokens: zero(),
        model: null,
        startedAt: at,
        lastAt: at,
        endedAt: null,
      },
    },
    order: [MAIN],
    unattributed: zero(),
  }
}

// Events carry no agentId on the main loop.
export const loopOf = (agentId: string | undefined): string => agentId ?? MAIN

function patch(w: World, id: string, at: number, fn: (a: Agent) => Agent): World {
  const agent = w.agents[id]
  if (!agent) return w
  return { ...w, updatedAt: at, agents: { ...w.agents, [id]: fn(agent) } }
}

export function spawn(
  w: World,
  s: {
    id: string
    parentId?: string
    type: string
    label: string
    isBackground: boolean
    model?: string
    at: number
  },
): World {
  const existing = w.agents[s.id]
  const agent: Agent = {
    id: s.id,
    parentId: s.parentId ?? MAIN,
    type: s.type,
    label: s.label,
    status: 'running',
    isBackground: s.isBackground,
    tool: existing?.tool ?? null,
    toolCalls: existing?.toolCalls ?? 0,
    tokens: existing?.tokens ?? zero(),
    model: s.model ?? existing?.model ?? null,
    startedAt: existing?.startedAt ?? s.at,
    lastAt: s.at,
    endedAt: null,
  }
  return prune({
    ...w,
    updatedAt: s.at,
    agents: { ...w.agents, [s.id]: agent },
    order: existing ? w.order : [...w.order, s.id],
  })
}

export function turnStart(w: World, agentId: string | undefined, at: number): World {
  return patch(w, loopOf(agentId), at, a => ({ ...a, status: 'running', lastAt: at, endedAt: null }))
}

export function toolStart(w: World, agentId: string | undefined, tool: string, at: number): World {
  return patch(w, loopOf(agentId), at, a => ({
    ...a,
    status: a.status === 'done' || a.status === 'failed' ? a.status : 'running',
    tool,
    toolCalls: a.toolCalls + 1,
    lastAt: at,
  }))
}

export function toolEnd(w: World, agentId: string | undefined, at: number): World {
  return patch(w, loopOf(agentId), at, a => ({ ...a, tool: null, lastAt: at }))
}

export function addUsage(
  w: World,
  agentId: string | undefined,
  u: Usage,
  model: string | undefined,
  at: number,
): World {
  const add = (t: Tokens): Tokens => ({
    input: t.input + u.input_tokens,
    output: t.output + u.output_tokens,
    cacheRead: t.cacheRead + u.cache_read_input_tokens,
    cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
  })
  const id = loopOf(agentId)
  if (!w.agents[id]) return { ...w, updatedAt: at, unattributed: add(w.unattributed) }
  return patch(w, id, at, a => ({ ...a, tokens: add(a.tokens), model: model ?? a.model, lastAt: at }))
}

export function complete(w: World, agentId: string | undefined, reason: TurnEnd, at: number): World {
  const id = loopOf(agentId)
  // The main loop does not finish: it waits for the next prompt.
  if (id === MAIN) return patch(w, id, at, a => ({ ...a, status: 'idle', tool: null, lastAt: at }))
  const status: Status = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
  return patch(w, id, at, a => ({ ...a, status, tool: null, lastAt: at, endedAt: at }))
}

const fromRoster: Record<RosterEntry['status'], Status> = {
  pending: 'running',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

// The roster is the engine's own account of every agent, so it settles anything the
// events missed: an agent spawned before a reload, or a status change no event carried.
export function reconcile(w: World, roster: readonly RosterEntry[], at: number): World {
  let next = w
  for (const r of roster) {
    const status = fromRoster[r.status]
    const known = next.agents[r.id]
    if (!known) {
      next = spawn(next, {
        id: r.id,
        parentId: r.parentId,
        type: r.type,
        label: r.description,
        isBackground: false,
        at,
      })
    }
    next = patch(next, r.id, at, a => {
      const isOver = status === 'done' || status === 'failed' || status === 'stopped'
      return {
        ...a,
        status,
        parentId: r.parentId ?? a.parentId ?? MAIN,
        tool: isOver ? null : a.tool,
        endedAt: isOver ? (a.endedAt ?? at) : null,
      }
    })
  }
  return next
}

const isFinished = (a: Agent) => a.status === 'done' || a.status === 'failed' || a.status === 'stopped'

function prune(w: World): World {
  if (w.order.length <= MAX_AGENTS) return w
  const parents = new Set(Object.values(w.agents).map(a => a.parentId))
  const drop = new Set<string>()
  for (const id of w.order) {
    if (w.order.length - drop.size <= MAX_AGENTS) break
    const a = w.agents[id]
    if (a && id !== MAIN && isFinished(a) && !parents.has(id)) drop.add(id)
  }
  if (drop.size === 0) return w
  const agents = { ...w.agents }
  for (const id of drop) delete agents[id]
  return { ...w, agents, order: w.order.filter(id => !drop.has(id)) }
}

// Relative cost of a token kind against one fresh input token: Anthropic's published
// ratios (output 5x, cache write 1.25x, cache read 0.1x). A ratio, not a price, so it
// sizes characters by who is expensive without quoting dollars that go stale.
export const COST_WEIGHT = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } as const

export const weighted = (t: Tokens): number =>
  t.input * COST_WEIGHT.input +
  t.output * COST_WEIGHT.output +
  t.cacheWrite * COST_WEIGHT.cacheWrite +
  t.cacheRead * COST_WEIGHT.cacheRead

export type ViewAgent = Agent & {
  depth: number
  // What to draw: a parent blocked on a foreground child is waiting, not busy.
  shown: Status
  isStalled: boolean
  // The parent this agent claims is not in the world: drawn unattached, no edge.
  isOrphan: boolean
  isLast: boolean
  // Ancestors' isLast, for drawing tree rails in text.
  rails: boolean[]
  weight: number
}

export type View = {
  agents: ViewAgent[]
  totals: Tokens & { weighted: number }
  counts: Record<Status, number> & { all: number; maxDepth: number }
  unattributed: Tokens
  startedAt: number
  updatedAt: number
}

export function view(w: World, now: number): View {
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const id of w.order) {
    const a = w.agents[id]
    if (!a) continue
    if (a.parentId === null || !w.agents[a.parentId]) roots.push(id)
    else children.set(a.parentId, [...(children.get(a.parentId) ?? []), id])
  }

  const isActive = (a: Agent) => a.status === 'running' || a.status === 'waiting'
  const out: ViewAgent[] = []
  const counts = { running: 0, waiting: 0, idle: 0, done: 0, failed: 0, stopped: 0, all: 0, maxDepth: 0 }
  const totals = zero()

  const walk = (id: string, depth: number, isLast: boolean, rails: boolean[]) => {
    const a = w.agents[id]
    if (!a) return
    const kids = children.get(id) ?? []
    const blocksOn = kids.some(k => {
      const c = w.agents[k]
      return c !== undefined && !c.isBackground && isActive(c)
    })
    const shown: Status = a.status === 'running' && blocksOn ? 'waiting' : a.status
    out.push({
      ...a,
      depth,
      shown,
      isStalled: a.status === 'running' && !blocksOn && now - a.lastAt > STALL_MS,
      isOrphan: a.parentId !== null && !w.agents[a.parentId],
      isLast,
      rails,
      weight: weighted(a.tokens),
    })
    counts[shown] += 1
    counts.all += 1
    counts.maxDepth = Math.max(counts.maxDepth, depth)
    totals.input += a.tokens.input
    totals.output += a.tokens.output
    totals.cacheRead += a.tokens.cacheRead
    totals.cacheWrite += a.tokens.cacheWrite
    kids.forEach((k, i) => walk(k, depth + 1, i === kids.length - 1, [...rails, isLast]))
  }
  roots.forEach((r, i) => walk(r, 0, i === roots.length - 1, []))

  return {
    agents: out,
    totals: { ...totals, weighted: weighted(totals) },
    counts,
    unattributed: w.unattributed,
    startedAt: w.startedAt,
    updatedAt: w.updatedAt,
  }
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
