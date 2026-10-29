// Builds a world with the REAL model and writes state.js in the mod's exact format.
import * as W from '../hooks/world.ts'
import { writeFileSync } from 'node:fs'

const [scenario, out, age = '0'] = process.argv.slice(2)
// age: how long ago this snapshot was written, for testing what the page does with an old one.
const now = Date.now() - Number(age)
const u = (i: number, o: number, cr = 0, cw = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw })

let w = W.emptyWorld(now - 120_000)
if (scenario !== 'empty') {
  w = W.turnStart(w, undefined, now - 100_000)
  w = W.addUsage(w, undefined, u(4_000, 2_000, 180_000, 12_000), 'claude-opus-5-5', now - 99_000)
  w = W.spawn(w, { id: 'idx', type: 'indexer', label: 'index the repository', isBackground: true, at: now - 90_000 })
  w = W.toolStart(w, 'idx', 'Glob', now - 2_000)
  w = W.addUsage(w, 'idx', u(900, 300, 30_000), 'claude-haiku-5-5', now - 2_000)
  w = W.spawn(w, { id: 'rev', type: 'reviewer', label: 'review the change for issue #42', isBackground: false, at: now - 80_000 })
  w = W.addUsage(w, 'rev', u(2_000, 1_500, 90_000, 6_000), 'claude-sonnet-5-5', now - 70_000)
  w = W.spawn(w, { id: 'png', parentId: 'rev', type: 'pinger', label: 'check the endpoint answers', isBackground: false, at: now - 60_000 })
  w = W.toolStart(w, 'png', 'Bash', now - 1_000)
  w = W.addUsage(w, 'png', u(300, 100, 9_000), 'claude-haiku-5-5', now - 1_000)
  w = W.spawn(w, { id: 'lnt', parentId: 'rev', type: 'linter', label: 'run the type checker', isBackground: false, at: now - 59_000 })
  w = W.addUsage(w, 'lnt', u(200, 80, 4_000), 'claude-haiku-5-5', now - 50_000)
  w = W.complete(w, 'lnt', 'error', now - 40_000)
  // Running, but silent for 100s: the page should show it as stalled from its own clock.
  w = W.spawn(w, { id: 'slw', type: 'researcher', label: 'read the RFC', isBackground: true, at: now - 110_000 })
  w = W.toolStart(w, 'slw', 'WebFetch', now - 100_000)
  // A helper whose parent was never seen: drawn unattached.
  w = W.spawn(w, { id: 'orf', parentId: 'gone', type: 'orphan', label: 'spawned before a reload', isBackground: false, at: now - 30_000 })
  if (scenario === 'more') {
    w = W.spawn(w, { id: 'new', parentId: 'png', type: 'Explore', label: 'find the fixtures', isBackground: false, at: now })
  }
}
const v = W.view(w, now)
// Exactly what register.tsx's publishState writes.
writeFileSync(out, `window.__BASIVO_WORLD__ = ${JSON.stringify(v)};\n`)
console.log(`${scenario}: ${v.agents.length} agents → ${v.agents.map(a => `${a.type}:${a.shown}${a.isStalled ? '(stalled)' : ''}${a.isOrphan ? '(orphan)' : ''}`).join(', ')}`)
