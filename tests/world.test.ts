import { expect, test } from 'claude-code/testing'

import * as W from '../hooks/world'

const usage = (i: number, o: number, cr = 0, cw = 0) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
})

// main → r1 (foreground) → p1 (foreground, running Bash), and bg alongside main.
function crew() {
  let w = W.emptyWorld(0)
  w = W.turnStart(w, undefined, 1)
  w = W.spawn(w, { id: 'r1', type: 'reviewer', label: 'review', isBackground: false, at: 2 })
  w = W.spawn(w, { id: 'p1', parentId: 'r1', type: 'pinger', label: 'ping', isBackground: false, at: 3 })
  w = W.spawn(w, { id: 'bg', type: 'indexer', label: 'index', isBackground: true, at: 4 })
  w = W.toolStart(w, 'p1', 'Bash', 5)
  return W.addUsage(w, 'p1', usage(100, 50, 1000, 200), 'haiku', 6)
}

const find = (v: W.View, id: string) => v.agents.find(a => a.id === id)

test('the tree is laid out depth-first, nested helpers included', async () => {
  const v = W.view(crew(), 10)
  expect(v.agents.map(a => a.id)).toEqual(['main', 'r1', 'p1', 'bg'])
  expect(find(v, 'p1')?.depth).toBe(2)
  expect(v.counts.maxDepth).toBe(2)
})

test('a parent blocked on a foreground helper is waiting, not busy', async () => {
  const v = W.view(crew(), 10)
  expect(find(v, 'main')?.shown).toBe('waiting')
  expect(find(v, 'r1')?.shown).toBe('waiting')
  expect(find(v, 'p1')?.shown).toBe('running')
  expect(find(v, 'p1')?.tool).toBe('Bash')
  // A background helper does not block anyone, and runs alongside.
  expect(find(v, 'bg')?.shown).toBe('running')
})

test('usage lands on the agent that spent it, unknown loops are counted apart', async () => {
  const w = W.addUsage(crew(), 'engine-fork', usage(7, 3), undefined, 7)
  const v = W.view(w, 10)
  expect(find(v, 'p1')?.tokens).toEqual({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 })
  expect(find(v, 'p1')?.model).toBe('haiku')
  expect(v.unattributed.input).toBe(7)
  expect(v.agents.some(a => a.id === 'engine-fork')).toBe(false)
})

test('a parent resumes when its helper finishes; errors fail; main only idles', async () => {
  let w = W.complete(W.toolEnd(crew(), 'p1', 11), 'p1', 'answer', 12)
  expect(find(W.view(w, 13), 'p1')?.status).toBe('done')
  expect(find(W.view(w, 13), 'r1')?.shown).toBe('running')
  w = W.complete(w, 'r1', 'error', 14)
  expect(find(W.view(w, 15), 'r1')?.status).toBe('failed')
  w = W.complete(w, 'bg', 'aborted', 15)
  expect(find(W.view(w, 16), 'bg')?.status).toBe('stopped')
  w = W.complete(w, undefined, 'answer', 16)
  expect(find(W.view(w, 17), 'main')?.status).toBe('idle')
})

test('a running agent silent past the limit is stalled; a waiting one is not', async () => {
  const w = W.spawn(W.emptyWorld(0), { id: 'x', type: 't', label: 'l', isBackground: false, at: 0 })
  expect(find(W.view(w, W.STALL_MS - 1), 'x')?.isStalled).toBe(false)
  expect(find(W.view(w, W.STALL_MS + 1), 'x')?.isStalled).toBe(true)
  const blocked = W.turnStart(w, undefined, 0)
  expect(find(W.view(blocked, W.STALL_MS + 1), 'main')?.isStalled).toBe(false)
})

test('a helper whose parent was never seen is unattached, with no invented edge', async () => {
  const w = W.spawn(W.emptyWorld(0), { id: 'kid', parentId: 'nobody', type: 't', label: 'l', isBackground: false, at: 1 })
  const kid = find(W.view(w, 2), 'kid')
  expect(kid?.isOrphan).toBe(true)
  expect(kid?.depth).toBe(0)
})

test('the roster rebuilds the tree after a reload, edges and endings included', async () => {
  const w = W.reconcile(
    W.emptyWorld(0),
    [
      { id: 'a', type: 'Explore', description: 'look', status: 'running' },
      { id: 'b', type: 'pinger', description: 'ping', status: 'completed', parentId: 'a' },
      { id: 'c', type: 'pinger', description: 'ping', status: 'killed', parentId: 'a' },
    ],
    5,
  )
  const v = W.view(w, 6)
  expect(v.agents.map(a => a.id)).toEqual(['main', 'a', 'b', 'c'])
  expect(find(v, 'b')?.status).toBe('done')
  expect(find(v, 'b')?.endedAt).toBe(5)
  expect(find(v, 'c')?.status).toBe('stopped')
})

test('a spawn the roster already reported keeps what was counted', async () => {
  let w = W.reconcile(W.emptyWorld(0), [{ id: 'a', type: 'Explore', description: 'look', status: 'running' }], 1)
  w = W.toolStart(w, 'a', 'Read', 2)
  w = W.spawn(w, { id: 'a', type: 'Explore', label: 'look', isBackground: true, model: 'sonnet', at: 3 })
  const a = find(W.view(w, 4), 'a')
  expect(a?.toolCalls).toBe(1)
  expect(a?.isBackground).toBe(true)
  expect(a?.model).toBe('sonnet')
  expect(w.order.filter(id => id === 'a').length).toBe(1)
})

test('the world is capped, finished leaves go first, and main stays', async () => {
  let w = W.emptyWorld(0)
  for (let i = 0; i < W.MAX_AGENTS + 20; i += 1) {
    w = W.complete(W.spawn(w, { id: `z${i}`, type: 't', label: 'l', isBackground: false, at: i }), `z${i}`, 'answer', i)
  }
  expect(w.order.length).toBe(W.MAX_AGENTS)
  expect(w.order[0]).toBe('main')
})

test('tokens format compactly and weigh by the published ratios', async () => {
  expect(W.fmtTokens(950)).toBe('950')
  expect(W.fmtTokens(1234)).toBe('1.2k')
  expect(W.fmtTokens(12_345)).toBe('12k')
  expect(W.fmtTokens(2_500_000)).toBe('2.5M')
  expect(W.weighted({ input: 100, output: 10, cacheRead: 1000, cacheWrite: 8 })).toBe(260)
})
