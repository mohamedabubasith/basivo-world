// Drives the ?demo world in Chromium with a frozen clock, at desktop and phone sizes,
// in both themes. Run: node tests-browser/demo.cjs [screenshot folder]
const { chromium } = require('playwright')
const os = require('os')
const path = require('path')
const fs = require('fs')
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'basivo-world-shots-'))
const PAGE = 'file://' + path.resolve(__dirname, '../web/index.html') + '?demo'
const LOOP = 22000
const base = 1_800_000_000_000 - (1_800_000_000_000 % LOOP)
let failed = 0
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failed++ }

async function open(browser, { width, height, scheme }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  await page.clock.install({ time: base })
  await page.goto(PAGE)
  return { ctx, page, errors }
}
const inspect = p => p.evaluate(() => window.__BASIVO_WORLD_INSPECT__())
// Move the page's clock to an exact moment in the demo loop, whatever drifted before.
async function at(page, ms) {
  const now = await page.evaluate(L => Date.now() % L, LOOP)
  if (ms > now) await page.clock.runFor(ms - now)
}

;(async () => {
  const browser = await chromium.launch()

  // 1. Desktop, dark, at 5.5s: the deepest moment of the loop.
  let { ctx, page, errors } = await open(browser, { width: 1440, height: 900, scheme: 'dark' })
  // 0. The tester is spawned at 2.4s: it takes its brief at the reviewer's desk first.
  await at(page, 2600)
  let s = await inspect(page)
  check(s.trips.some(t => t.id === 't1' && t.kind === 'brief' && t.to === 'r1'), `the tester is briefed at the reviewer's desk ${JSON.stringify(s.trips)}`)
  await page.screenshot({ path: `${SHOTS}/demo-1440-dark-brief.png` })
  await at(page, 5500)
  s = await inspect(page)
  check(s.mode === 'demo', `mode is demo (${s.mode})`)
  check(s.actors.length === 7, `7 agents on stage (${s.actors.length})`)
  check(Math.max(...s.actors.map(a => a.depth)) === 3, 'reaches depth 3')
  check(s.actors.find(a => a.id === 'main').shown === 'waiting', 'main is shown waiting while blocked')
  check(s.actors.find(a => a.id === 'b1').shown === 'running', 'background indexer works alongside')
  check(/depth 3/.test(s.stats) && /6 helpers/.test(s.stats), `HUD: ${s.stats}`)
  check(/demo/i.test(s.status), `status says demo: ${s.status}`)
  check(s.rooms.length === 3 && s.rooms[0].title === 'Main office', `three rooms, the main office first ${JSON.stringify(s.rooms)}`)
  await page.screenshot({ path: `${SHOTS}/demo-1440-dark-5.5s.png` })

  // Hover the tester once it is seated at its desk: the tooltip shows its detail.
  await at(page, 7000)
  s = await inspect(page)
  check(!s.trips.some(t => t.id === 't1'), 'the tester has walked in and sat down by 7s')
  const box = s.boxes.find(b => b.id === 't1')
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2)
  await page.clock.runFor(100)
  const tip = await page.locator('#tip').innerText()
  check(await page.locator('#tip').isVisible(), 'tooltip appears on hover')
  check(/tester/.test(tip) && /write the missing tests/.test(tip) && /reports to\s*review the change for issue #42/.test(tip), 'tooltip names the agent, its task and who it reports to')
  await page.screenshot({ path: `${SHOTS}/demo-1440-dark-hover.png` })
  await page.mouse.move(5, 5)

  // 2. The report: the tester finishes at 9.5s and walks its report to the reviewer.
  await at(page, 9600)
  s = await inspect(page)
  check(s.actors.find(a => a.id === 't1').shown === 'done', 'tester is done at 9.6s')
  check(s.trips.some(t => t.id === 't1' && t.kind === 'report' && t.to === 'r1'), `the tester walks its report to its spawner, the reviewer ${JSON.stringify(s.trips)}`)
  await page.screenshot({ path: `${SHOTS}/demo-1440-dark-report.png` })
  await at(page, 17000)
  check(!(await inspect(page)).trips.some(t => t.id === 't1'), 'the tester hands it in and is back at its desk')

  // 3. Everyone home at 19s: main idle, nobody waiting.
  await at(page, 19000)
  s = await inspect(page)
  check(s.actors.find(a => a.id === 'main').shown === 'idle', 'main is idle at 19s')
  check(s.actors.filter(a => a.shown === 'waiting').length === 0, 'nobody waiting at the end')
  check(s.actors.find(a => a.id === 'l1').shown === 'failed', 'the linter stays failed')
  check(s.inbox === 2, `the boss's inbox holds the two reports from its own team (${s.inbox})`)
  check(errors.length === 0, `no console or page errors (${errors.length}) ${errors.slice(0, 2).join(' | ')}`)
  await ctx.close()

  // 4. Light scheme, and the phone.
  for (const [w, h, scheme] of [[1440, 900, 'light'], [390, 844, 'dark'], [390, 844, 'light']]) {
    ;({ ctx, page, errors } = await open(browser, { width: w, height: h, scheme }))
    await at(page, 5500)
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    check(over <= 0, `${w}px ${scheme}: no horizontal scroll (${over})`)
    s = await inspect(page)
    const fits = s.boxes.every(b => b.x >= 0 && b.x + b.w <= w && b.w > 0)
    check(fits, `${w}px ${scheme}: every desk fits the width`)
    check(errors.length === 0, `${w}px ${scheme}: no errors`)
    await page.screenshot({ path: `${SHOTS}/demo-${w}-${scheme}-5.5s.png` })
    await ctx.close()
  }

  await browser.close()
  console.log(failed ? `\n${failed} FAILED` : `\nALL DEMO CHECKS PASSED · screenshots in ${SHOTS}`)
  process.exit(failed ? 1 : 0)
})()
