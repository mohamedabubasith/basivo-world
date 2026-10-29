const { chromium } = require('playwright')
const fs = require('fs')
const { execFileSync } = require('child_process')
// Publishes the page as the mod does, writes state.js from the real model (gen-state.ts),
// and checks every mode: connecting, live, a live rewrite, a stale snapshot, a lost
// file and an empty session. Run: node tests-browser/live.cjs [screenshot folder]
const os = require('os')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'basivo-world-session-'))
for (const f of ['index.html', 'world.js', 'sprites.js', 'demo.js']) fs.copyFileSync(path.join(ROOT, 'web', f), path.join(D, f))
const STATE = `${D}/state.js`
const SHOTS = process.argv[2] || D
const GEN = path.join(__dirname, 'gen-state.ts')
const gen = (scenario, out, age = '0') =>
  execFileSync('node', ['--experimental-strip-types', '--no-warnings', GEN, scenario, out, age])
let failed = 0
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failed++ }
const inspect = p => p.evaluate(() => window.__BASIVO_WORLD_INSPECT__())
async function until(page, fn, ms = 3000) {
  const end = Date.now() + ms
  for (;;) { const s = await inspect(page); if (fn(s) || Date.now() > end) return s; await page.waitForTimeout(100) }
}

;(async () => {
  fs.rmSync(STATE, { force: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FILE_NOT_FOUND|Failed to load resource/.test(m.text())) errors.push(m.text()) })
  await page.goto(`file://${D}/index.html`)

  // 1. Before /world has written anything: say so, and how to fix it.
  let s = await until(page, s => s.mode === 'connecting')
  check(s.mode === 'connecting', `no state file yet → connecting (${s.mode})`)
  check(/run \/world/.test(s.status), `status tells you what to do: "${s.status}"`)

  // 2. The mod writes the real model's snapshot: the page goes live.
  // Written now, as the mod would: a fresh snapshot.
  gen('rich', STATE)
  s = await until(page, s => s.mode === 'live' && s.actors.length === 7)
  check(s.mode === 'live', `state file appears → live (${s.mode})`)
  check(s.actors.length === 7, `all 7 agents from the real model are on stage (${s.actors.length})`)
  check(s.actors.find(a => a.id === 'png')?.depth === 2, 'the nested pinger is at depth 2')
  check(/^Live · updated \d+s ago$/.test(s.status), `a fresh snapshot reads as live: "${s.status}"`)
  check(/6 helpers/.test(s.stats) && /1 failed/.test(s.stats) && /depth 2/.test(s.stats), `HUD from real data: ${s.stats}`)
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${SHOTS}/live-rich.png` })

  // The stalled researcher, judged by the page's own clock.
  const box = s.boxes.find(b => b.id === 'slw')
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2)
  await page.waitForTimeout(200)
  const tip = await page.locator('#tip').innerText()
  check(/researcher/.test(tip) && /quiet \dm \d+s/.test(tip), `the stalled agent tooltip says how long it has been quiet: ${JSON.stringify(tip)}`)
  const orphan = s.boxes.find(b => b.id === 'orf')
  await page.mouse.move(orphan.x + orphan.w / 2, orphan.y + orphan.h / 2)
  await page.waitForTimeout(200)
  check(/spawned by\s*not seen/.test(await page.locator('#tip').innerText()), 'the orphan says its spawner was not seen, rather than guessing one')
  await page.mouse.move(5, 5)

  // 3. A live update: a new helper is spawned, the page picks it up from the rewrite.
  gen('more', STATE)
  s = await until(page, s => s.actors.length === 8)
  check(s.actors.length === 8, `rewrite picked up: 8 agents (${s.actors.length})`)
  check(s.actors.find(a => a.id === 'png')?.shown === 'waiting', 'the pinger now waits on its new helper')
  check(s.actors.find(a => a.id === 'new')?.depth === 3, 'the new Explore sits at depth 3')
  // A snapshot written two minutes ago with agents still busy: the page must not call it fresh.
  gen('more', STATE, '120000')
  s = await until(page, s => /no events/.test(s.status))
  check(/^Live · no events for 2m/.test(s.status), `an old snapshot with busy agents admits it: "${s.status}"`)
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${SHOTS}/live-more.png` })

  // 4. The file vanishes (session folder cleaned up): say so, keep the last picture.
  fs.rmSync(STATE)
  s = await until(page, s => s.mode === 'lost')
  check(s.mode === 'lost' && s.actors.length === 8, `state file gone → lost, last world kept (${s.mode}, ${s.actors.length})`)

  // 5. An empty session: only main, and the page says so plainly.
  gen('empty', STATE)
  s = await until(page, s => s.mode === 'live' && s.actors.length === 1)
  check(s.actors.length === 1, 'empty session: main alone')
  check(await page.locator('#empty').isVisible(), 'the "no helpers yet" note shows')
  await page.screenshot({ path: `${SHOTS}/live-empty.png` })

  check(errors.length === 0, `no errors besides the expected missing-file loads (${errors.length}) ${errors.slice(0, 2).join(' | ')}`)
  await browser.close()
  console.log(failed ? `\n${failed} FAILED` : `\nALL LIVE CHECKS PASSED · screenshots in ${SHOTS}`)
  process.exit(failed ? 1 : 0)
})()
