// basivo-world: an isometric pixel-art diorama of a Claude Code session's agents.
// Reads window.__BASIVO_WORLD__, which the mod rewrites in state.js beside this page,
// by re-loading that script on a timer: no server, no port, nothing listening.
'use strict'
;(() => {
  const POLL_MS = 500
  // Matches STALL_MS in hooks/world.ts.
  const STALL_MS = 90_000
  const QUIET_MS = 60_000
  const TW = 16 // tile width, art pixels
  const TH = 8 // tile height
  const FAN = [(-15 * Math.PI) / 180, (105 * Math.PI) / 180]
  const DROP_MS = 420
  const PACKET_MS = 950
  const isDemo = new URLSearchParams(location.search).has('demo')

  const canvas = document.getElementById('world')
  const g = canvas.getContext('2d')
  const low = document.createElement('canvas')
  const lg = low.getContext('2d')
  const el = id => document.getElementById(id)
  const hud = { bar: el('hud'), stats: el('stats'), status: el('status'), empty: el('empty'), summary: el('summary') }
  const tip = el('tip')

  let theme = readTheme()
  let view = null
  let mode = isDemo ? 'demo' : 'connecting'
  let hasLoaded = false
  let pulls = 0
  const actors = new Map()
  const packets = []
  let hovered = null
  let pinned = null
  let pointer = null
  let geometry = { K: 4, S: 4, ox: 0, oy: 0, lowW: 0, lowH: 0, dpr: 1 }
  let laidOutAt = 0
  let ground = []

  // ---- theme ---------------------------------------------------------------

  function readTheme() {
    const css = getComputedStyle(document.documentElement)
    const v = name => css.getPropertyValue(name).trim()
    const t = {
      bg: v('--bg'),
      text: v('--text'),
      muted: v('--muted'),
      violet: v('--violet'),
      violetSoft: v('--violet-soft'),
      outline: v('--outline'),
      trousers: v('--trousers'),
      bubble: v('--bubble'),
      tileA: v('--tile-a'),
      tileB: v('--tile-b'),
      slab: v('--slab'),
      slabDark: v('--slab-dark'),
      blockTop: v('--block-top'),
      blockLeft: v('--block-left'),
      blockRight: v('--block-right'),
      fail: v('--fail'),
      tether: v('--tether'),
      mono: v('--mono'),
      label: v('--label'),
      labelMuted: v('--label-muted'),
      chip: v('--chip'),
    }
    t.key = Object.values(t).join(',')
    return t
  }

  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    theme = readTheme()
    Sprites.clear()
  })

  // ---- data ----------------------------------------------------------------

  function pull() {
    const script = document.createElement('script')
    script.src = `state.js?n=${(pulls += 1)}`
    script.onload = () => {
      script.remove()
      const next = window.__BASIVO_WORLD__
      hasLoaded = true
      if (next && (!view || next.updatedAt !== view.updatedAt)) apply(next)
      setMode('live')
    }
    script.onerror = () => {
      script.remove()
      setMode(hasLoaded ? 'lost' : 'connecting')
    }
    document.head.appendChild(script)
  }

  // The status line changes the moment the mode does, not on the next second's tick.
  function setMode(next) {
    if (mode === next) return
    mode = next
    renderStatus()
  }

  const isActive = a => a.shown === 'running' || a.shown === 'waiting'

  function apply(next) {
    const now = performance.now()
    const targets = layout(next.agents, geometry.K)
    const seen = new Set()
    for (const a of next.agents) {
      seen.add(a.id)
      const target = targets.get(a.id) ?? { x: 0, y: 0 }
      let actor = actors.get(a.id)
      if (!actor) {
        // A newcomer drops in where it belongs; on first load nobody drops.
        actor = { x: target.x, y: target.y, born: view ? now : -Infinity, phase: Sprites.hash(a.id) % 1000 }
        actors.set(a.id, actor)
      } else if (actor.agent.shown !== 'done' && a.shown === 'done' && a.parentId && !a.isOrphan) {
        // The one real conversation between agents: a helper handing its result back.
        packets.push({ from: a.id, to: a.parentId, t0: now })
      }
      actor.agent = a
    }
    for (const id of [...actors.keys()]) if (!seen.has(id)) actors.delete(id)
    view = next
    relayout()
    renderHud()
  }

  // A tidy tree, laid out in screen space: each depth a row down the screen, siblings
  // across it, every parent centred over its children. Gaps come from what is drawn
  // (stack heights, label widths), so nothing can overlap by construction.
  function layout(agents, K) {
    const children = new Map()
    const roots = []
    for (const a of agents) {
      if (a.depth === 0 && a.id !== 'main') roots.push(a.id)
      if (a.depth > 0 && a.parentId) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a.id])
    }
    // Unattached helpers sit in main's row of children so the layout stays one piece;
    // they get no tether, because there is no edge we can honestly draw.
    children.set('main', [...(children.get('main') ?? []), ...roots])

    const maxBlocks = Math.max(0, ...agents.map(a => blocksFor(a.weight)))
    const longest = Math.max(4, ...agents.map(a => Math.min(16, a.type.length)))
    // A monospace label is about 0.6em a character, at 11 CSS px, in art pixels at K.
    const labelW = (longest * 0.6 * 11) / K
    const colGap = Math.max(22, Math.ceil(labelW) + 8)
    const rowGap = Sprites.H + 13 + maxBlocks * 4 + Math.ceil(30 / K) + 6

    const col = new Map()
    let next = 0
    const assign = id => {
      const kids = children.get(id) ?? []
      if (kids.length === 0) {
        col.set(id, next)
        next += 1
        return
      }
      kids.forEach(assign)
      col.set(id, (col.get(kids[0]) + col.get(kids[kids.length - 1])) / 2)
    }
    assign('main')
    const middle = (next - 1) / 2
    const depthOf = new Map()
    const walk = (id, d) => {
      depthOf.set(id, d)
      for (const k of children.get(id) ?? []) walk(k, d + 1)
    }
    walk('main', 0)

    const out = new Map()
    for (const [id, c] of col) {
      const sx = (c - middle) * colGap
      const sy = (depthOf.get(id) ?? 0) * rowGap
      // Screen offsets back to the ground's grid: sx = (x - y) * TW/2, sy = (x + y) * TH/2.
      out.set(id, { x: sx / TW + sy / TH, y: sy / TH - sx / TW })
    }
    return out
  }

  function relayout() {
    if (!view) return
    const targets = layout(view.agents, geometry.K)
    for (const [id, actor] of actors) {
      const t = targets.get(id) ?? { x: 0, y: 0 }
      actor.tx = t.x
      actor.ty = t.y
    }
    laidOutAt = geometry.K
    ground = island()
  }

  // The ground is an island that grows with the crew: tiles around each agent and
  // under each tether, so there are no empty corners to fit the camera around.
  function island() {
    const tiles = new Set()
    const add = (cx, cy, r) => {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
        for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) tiles.add(`${x},${y}`)
        }
      }
    }
    for (const a of actors.values()) {
      add(a.tx, a.ty, 2.6)
      const p = a.agent.parentId && !a.agent.isOrphan ? actors.get(a.agent.parentId) : null
      if (!p) continue
      const steps = Math.ceil(Math.hypot(p.tx - a.tx, p.ty - a.ty) * 2)
      for (let i = 0; i <= steps; i += 1) {
        const t = i / Math.max(1, steps)
        add(a.tx + (p.tx - a.tx) * t, a.ty + (p.ty - a.ty) * t, 2)
      }
    }
    if (tiles.size === 0) add(0, 0, 2.6)
    return smooth(tiles)
  }

  // Fill the gaps between circles (a tile mostly surrounded by ground is ground), then
  // trim lone spikes, so the island reads as one solid slab with clean edges.
  function smooth(tiles) {
    const near = (x, y) =>
      [tiles.has(`${x + 1},${y}`), tiles.has(`${x - 1},${y}`), tiles.has(`${x},${y + 1}`), tiles.has(`${x},${y - 1}`)].filter(Boolean).length
    const cells = () => [...tiles].map(k => k.split(',').map(Number))
    for (let pass = 0; pass < 3; pass += 1) {
      const add = []
      for (const [x, y] of cells()) {
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (!tiles.has(`${nx},${ny}`) && near(nx, ny) >= 3) add.push(`${nx},${ny}`)
        }
      }
      if (add.length === 0) break
      for (const k of add) tiles.add(k)
    }
    for (const [x, y] of cells()) if (near(x, y) <= 1) tiles.delete(`${x},${y}`)
    return cells()
  }

  // ---- drawing helpers -----------------------------------------------------

  const project = (x, y) => [(x - y) * (TW / 2), (x + y) * (TH / 2)]

  function blocksFor(weight) {
    if (!(weight > 0)) return 0
    return Math.max(0, Math.min(6, Math.floor(Math.log10(weight)) - 1))
  }

  function line(x0, y0, x1, y1, color, isDashed) {
    x0 = Math.round(x0)
    y0 = Math.round(y0)
    x1 = Math.round(x1)
    y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    let i = 0
    lg.fillStyle = color
    for (;;) {
      if (!isDashed || i % 4 < 2) lg.fillRect(x0, y0, 1, 1)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x0 += sx
      }
      if (e2 <= dx) {
        err += dx
        y0 += sy
      }
      i += 1
    }
  }

  function fit() {
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    const devW = Math.max(1, Math.round(cssW * dpr))
    const devH = Math.max(1, Math.round(cssH * dpr))
    if (canvas.width !== devW || canvas.height !== devH) {
      canvas.width = devW
      canvas.height = devH
    }
    // The island's edges, plus each agent's head-room above it and its labels below.
    let left = Infinity
    let right = -Infinity
    let top = Infinity
    let bottom = -Infinity
    for (const [x, y] of ground) {
      const [px, py] = project(x, y)
      left = Math.min(left, px - TW / 2)
      right = Math.max(right, px + TW / 2)
      top = Math.min(top, py - TH / 2)
      bottom = Math.max(bottom, py + TH / 2 + 4)
    }
    for (const a of actors.values()) {
      const [px, py] = project(a.tx, a.ty)
      top = Math.min(top, py - (Sprites.H + 14 + blocksFor(a.agent.weight) * 4))
      bottom = Math.max(bottom, py + 4 + Math.ceil(30 / geometry.K))
      left = Math.min(left, px - 12)
      right = Math.max(right, px + 12)
    }
    const hudH = hud.bar.offsetHeight
    const legendH = document.getElementById('legend').offsetHeight + 18
    const roomH = cssH - hudH - legendH
    const K = Math.max(1, Math.min(8, Math.floor(Math.min(cssW / (right - left + 12), roomH / (bottom - top + 12)))))
    const S = Math.max(1, Math.round(K * dpr))
    const lowW = Math.ceil(devW / S)
    const lowH = Math.ceil(devH / S)
    if (low.width !== lowW || low.height !== lowH) {
      low.width = lowW
      low.height = lowH
    }
    const ox = Math.round(lowW / 2 - (left + right) / 2)
    const oy = Math.round(((hudH + roomH / 2) * dpr) / S - (top + bottom) / 2)
    return { K, S, ox, oy, lowW, lowH, dpr }
  }

  function drawGround() {
    const has = new Set(ground.map(([x, y]) => `${x},${y}`))
    const depth = 4
    for (const [x, y] of ground) {
      const [px, py] = project(x, y)
      const cx = px + geometry.ox
      const cy = py + geometry.oy
      lg.fillStyle = (x + y) % 2 === 0 ? theme.tileA : theme.tileB
      for (let r = 0; r < TH; r += 1) {
        const half = r < TH / 2 ? r * 2 + 1 : (TH - 1 - r) * 2 + 1
        lg.fillRect(cx - half, cy - TH / 2 + r, half * 2, 1)
      }
    }
    // Faces only where the island ends, so it reads as a floating slab.
    for (const [x, y] of ground) {
      const [px, py] = project(x, y)
      const cx = px + geometry.ox
      const cy = py + geometry.oy
      if (!has.has(`${x},${y + 1}`)) {
        lg.fillStyle = theme.slab
        for (let r = 0; r < depth; r += 1) lg.fillRect(cx - TW / 2, cy + r, TW / 2, 1)
      }
      if (!has.has(`${x + 1},${y}`)) {
        lg.fillStyle = theme.slabDark
        for (let r = 0; r < depth; r += 1) lg.fillRect(cx, cy + r, TW / 2, 1)
      }
    }
  }

  // ---- frame ---------------------------------------------------------------

  let previous = performance.now()

  // One clock for everything: apply() stamps births and packets with performance.now(),
  // so the frame reads the same clock rather than the timestamp rAF hands in.
  function frame() {
    const now = performance.now()
    const dt = Math.min(0.1, (now - previous) / 1000)
    previous = now
    if (isDemo) {
      const next = Demo.at(Date.now())
      if (!view || next.updatedAt !== view.updatedAt) apply(next)
    }
    for (const a of actors.values()) {
      const k = Math.min(1, dt * 6)
      a.x += (a.tx - a.x) * k
      a.y += (a.ty - a.y) * k
    }

    geometry = fit()
    // Label widths depend on the scale, so a new scale means a new layout.
    if (geometry.K !== laidOutAt) relayout()
    lg.clearRect(0, 0, low.width, low.height)
    drawGround()

    const wall = Date.now()
    const foot = a => {
      const [px, py] = project(a.x, a.y)
      const drop = a.born === -Infinity ? 0 : Math.max(0, 1 - (now - a.born) / DROP_MS)
      return [Math.round(px + geometry.ox), Math.round(py + geometry.oy - drop * drop * 48)]
    }

    // Tethers on the ground, under everyone: who spawned whom.
    for (const a of actors.values()) {
      const p = a.agent.parentId && !a.agent.isOrphan ? actors.get(a.agent.parentId) : null
      if (!p) continue
      const [x0, y0] = foot(a)
      const [x1, y1] = foot(p)
      line(x0, y0, x1, y1, isActive(a.agent) ? theme.violet : theme.tether, a.agent.isBackground)
    }

    const order = [...actors.values()].sort((m, n) => m.x + m.y - (n.x + n.y))
    const hits = []
    for (const a of order) {
      const agent = a.agent
      const [fx, fy] = foot(a)
      const isStalled = agent.shown === 'running' && wall - agent.lastAt > STALL_MS
      // Shadow.
      lg.fillStyle = theme.tether
      lg.globalAlpha = 0.35
      lg.fillRect(fx - 4, fy - 1, 9, 2)
      lg.fillRect(fx - 3, fy + 1, 7, 1)
      lg.globalAlpha = 1
      // The stack: one block per order of magnitude of cost-weighted tokens.
      const blocks = blocksFor(agent.weight)
      for (let i = 0; i < blocks; i += 1) {
        lg.drawImage(Sprites.block(theme, i === blocks - 1 && isActive(agent)), fx - 4, fy - 5 - i * 4)
      }
      const standOn = fy - blocks * 4
      const pose = agent.shown === 'waiting' ? 'sit' : 'stand'
      const isWorking = agent.shown === 'running' && !isStalled
      const bob = isWorking ? Math.floor(now / 260 + a.phase) % 2 : 0
      const blink = (now + a.phase * 7) % 4200 < 130
      const faded = agent.shown === 'done' || agent.shown === 'stopped'
      const top = standOn - Sprites.H - bob
      lg.drawImage(Sprites.character(agent.type, agent.id, pose, blink, faded, theme), fx - 6, top)
      // What it is doing, above its head.
      const icon =
        agent.shown === 'running'
          ? isStalled
            ? 'clock'
            : Sprites.iconFor(agent.tool)
          : agent.shown === 'waiting'
            ? 'wait'
            : agent.shown === 'failed'
              ? 'fail'
              : agent.shown === 'done'
                ? 'done'
                : agent.shown === 'stopped'
                  ? 'stop'
                  : null
      if (icon) lg.drawImage(Sprites.bubble(icon, theme), fx - 5, top - 12)
      if (a === hovered || a === pinned) {
        lg.fillStyle = theme.violet
        lg.fillRect(fx - 6, fy + 2, 13, 1)
      }
      hits.push({ actor: a, x0: fx - 7, y0: top - 12, x1: fx + 7, y1: fy + 3, fx, fy, isStalled })
    }

    // Results travelling home.
    for (let i = packets.length - 1; i >= 0; i -= 1) {
      const p = packets[i]
      const t = (now - p.t0) / PACKET_MS
      const from = actors.get(p.from)
      const to = actors.get(p.to)
      if (t >= 1 || !from || !to) {
        packets.splice(i, 1)
        continue
      }
      const [x0, y0] = foot(from)
      const [x1, y1] = foot(to)
      const ease = t * t * (3 - 2 * t)
      const x = Math.round(x0 + (x1 - x0) * ease)
      const y = Math.round(y0 + (y1 - y0) * ease - Math.sin(Math.PI * t) * 10 - 8)
      lg.fillStyle = theme.outline
      lg.fillRect(x - 2, y - 2, 5, 4)
      lg.fillStyle = theme.violetSoft
      lg.fillRect(x - 1, y - 1, 3, 2)
    }

    // Up to the screen, pixels kept square.
    const { S, dpr } = geometry
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.imageSmoothingEnabled = false
    g.fillStyle = theme.bg
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.drawImage(low, 0, 0, low.width * S, low.height * S)
    drawLabels(hits, S, dpr)
    hitboxes = hits
    updateTip()
    requestAnimationFrame(frame)
  }

  let hitboxes = []

  // Labels sit on the ground, which is paper in both themes, so they are ink on a
  // paper chip: readable over tiles and tethers alike.
  function drawLabels(hits, S, dpr) {
    const size = Math.max(10, Math.round(11 * dpr))
    const small = Math.round(size * 0.9)
    const pad = Math.round(3 * dpr)
    g.textAlign = 'center'
    g.textBaseline = 'top'
    for (const h of hits) {
      const a = h.actor.agent
      const x = (h.fx + 0.5) * S
      const y = (h.fy + 4) * S
      const name = a.type.length > 16 ? `${a.type.slice(0, 15)}…` : a.type
      const detail = `${fmt(a.weight)}${a.isBackground ? ' · bg' : ''}${a.isOrphan ? ' · ?' : ''}`
      g.font = `500 ${size}px ${theme.mono}`
      const w1 = g.measureText(name).width
      g.font = `400 ${small}px ${theme.mono}`
      const w2 = g.measureText(detail).width
      const w = Math.max(w1, w2) + pad * 2
      const hgt = size * 1.25 + small * 1.2 + pad
      g.fillStyle = theme.chip
      g.beginPath()
      g.roundRect(Math.round(x - w / 2), Math.round(y - pad / 2), Math.round(w), Math.round(hgt), pad)
      g.fill()
      g.font = `500 ${size}px ${theme.mono}`
      g.fillStyle = a.shown === 'done' || a.shown === 'stopped' ? theme.labelMuted : theme.label
      g.fillText(name, x, y)
      g.font = `400 ${small}px ${theme.mono}`
      g.fillStyle = a.shown === 'failed' ? theme.fail : theme.labelMuted
      g.fillText(detail, x, y + size * 1.25)
    }
  }

  // ---- HUD, tooltip, summary -----------------------------------------------

  function fmt(n) {
    if (!(n > 0)) return '0'
    if (n < 1000) return String(Math.round(n))
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
    return `${(n / 1_000_000).toFixed(1)}M`
  }

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
  }

  function renderHud() {
    if (!view) return
    const c = view.counts
    const helpers = c.all - 1
    const parts = [`${helpers} helper${helpers === 1 ? '' : 's'}`, `${c.running} running`, `${c.waiting} waiting`]
    if (c.done) parts.push(`${c.done} done`)
    if (c.failed) parts.push(`${c.failed} failed`)
    if (c.maxDepth > 1) parts.push(`depth ${c.maxDepth}`)
    parts.push(`≈${fmt(view.totals.weighted)} weighted tokens`)
    hud.stats.textContent = parts.join(' · ')
    hud.empty.hidden = helpers > 0
    const said = view.agents
      .filter(a => a.id !== 'main')
      .map(a => `${a.type} ${a.shown === 'running' ? `running ${a.tool ?? ''}`.trim() : a.shown}`)
      .join('. ')
    const sentence = helpers === 0 ? 'No helpers yet.' : `${parts.join(', ')}. ${said}.`
    if (hud.summary.textContent !== sentence) hud.summary.textContent = sentence
  }

  function renderStatus() {
    const s = hud.status
    s.dataset.mode = mode
    if (mode === 'demo') s.textContent = 'Demo · sample data, not a live session'
    else if (mode === 'connecting') s.textContent = 'Waiting for Claude Code · run /world in your session'
    else if (mode === 'lost') s.textContent = 'Lost the session’s state file'
    else if (view) {
      const quiet = Date.now() - view.updatedAt
      const isBusy = view.agents.some(isActive)
      s.textContent = isBusy && quiet > QUIET_MS ? `Live · no events for ${ago(quiet)}` : `Live · updated ${ago(quiet)} ago`
    }
  }

  function updateTip() {
    const target = pinned ?? hovered
    if (!target || !actors.has(target.agent.id)) {
      tip.hidden = true
      return
    }
    const a = actors.get(target.agent.id).agent
    const parent = a.parentId ? view?.agents.find(p => p.id === a.parentId) : null
    const wall = Date.now()
    const isStalled = a.shown === 'running' && wall - a.lastAt > STALL_MS
    const rows = [
      ['', a.type],
      ['', a.label],
      [
        'state',
        `${a.shown}${isStalled ? ` · quiet ${ago(wall - a.lastAt)}` : ''}${a.shown === 'waiting' ? ' on a helper' : ''}${a.isBackground ? ' · background' : ''}`,
      ],
      ['doing', a.shown === 'running' ? (a.tool ?? 'thinking') : '—'],
      ['model', a.model ?? '—'],
      ['spawned by', a.isOrphan ? 'not seen' : parent ? parent.type : '—'],
      ['tools', String(a.toolCalls)],
      ['tokens', `${fmt(a.tokens.input)} in · ${fmt(a.tokens.output)} out`],
      ['cache', `${fmt(a.tokens.cacheRead)} read · ${fmt(a.tokens.cacheWrite)} written`],
      ['weighted', fmt(a.weight)],
      ['for', ago((a.endedAt ?? wall) - a.startedAt)],
    ]
    // textContent only: labels come from the session and are never parsed as HTML.
    tip.replaceChildren(
      ...rows.map(([k, v], i) => {
        const row = document.createElement('div')
        row.className = i === 0 ? 'tip-title' : i === 1 ? 'tip-label' : 'tip-row'
        if (k) {
          const key = document.createElement('span')
          key.textContent = k
          row.append(key)
        }
        const val = document.createElement('span')
        val.textContent = v
        row.append(val)
        return row
      }),
    )
    tip.hidden = false
    const { S, dpr } = geometry
    const hit = hitboxes.find(h => h.actor === target)
    if (!hit) return
    const x = ((hit.x1 + 2) * S) / dpr
    const y = (hit.y0 * S) / dpr
    const w = tip.offsetWidth
    const left = x + w + 12 > innerWidth ? ((hit.x0 - 2) * S) / dpr - w : x
    tip.style.left = `${Math.max(8, left)}px`
    tip.style.top = `${Math.max(8, Math.min(innerHeight - tip.offsetHeight - 8, y))}px`
  }

  function hitAt(cx, cy) {
    const { S, dpr } = geometry
    const x = (cx * dpr) / S
    const y = (cy * dpr) / S
    for (let i = hitboxes.length - 1; i >= 0; i -= 1) {
      const h = hitboxes[i]
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h.actor
    }
    return null
  }

  canvas.addEventListener('pointermove', e => {
    pointer = [e.offsetX, e.offsetY]
    hovered = hitAt(...pointer)
    canvas.style.cursor = hovered ? 'pointer' : 'default'
  })
  canvas.addEventListener('pointerleave', () => {
    hovered = null
  })
  canvas.addEventListener('click', e => {
    const hit = hitAt(e.offsetX, e.offsetY)
    pinned = hit && hit !== pinned ? hit : null
  })
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') pinned = null
  })

  // ---- start ---------------------------------------------------------------

  if (isDemo) {
    mode = 'demo'
  } else {
    pull()
    setInterval(pull, POLL_MS)
  }
  setInterval(() => {
    renderStatus()
    renderHud()
  }, 1000)
  renderStatus()
  ground = island()
  requestAnimationFrame(frame)

  // What the page holds, for tests and for anyone embedding it. Read-only.
  window.__BASIVO_WORLD_INSPECT__ = () => ({
    mode,
    actors: [...actors.values()].map(a => ({ id: a.agent.id, shown: a.agent.shown, depth: a.agent.depth })),
    // Each character's box on screen, in CSS pixels.
    boxes: hitboxes.map(h => {
      const k = geometry.S / geometry.dpr
      return { id: h.actor.agent.id, x: h.x0 * k, y: h.y0 * k, w: (h.x1 - h.x0) * k, h: (h.y1 - h.y0) * k }
    }),
    packets: packets.map(p => ({ from: p.from, to: p.to, age: Math.round(performance.now() - p.t0) })),
    scale: geometry.S,
    stats: hud.stats.textContent,
    status: hud.status.textContent,
  })
})()
