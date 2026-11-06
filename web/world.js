// basivo-world: a Claude Code session as a 3D office. Main is the boss, at a big desk
// in a glass cabin. Each manager's helpers share a room, one desk each. A new helper
// takes its brief at its manager's desk and walks the corridors to its own; when it
// is done it walks the report back, and the paper lands on the manager's desk.
// Reads window.__BASIVO_WORLD__, which the mod rewrites in state.js beside this page,
// by re-loading that script on a timer: no server, no port, nothing listening.
'use strict'
;(() => {
  const POLL_MS = 500
  // Matches STALL_MS in hooks/world.ts.
  const STALL_MS = 90_000
  const QUIET_MS = 60_000
  const BRIEF_MS = 700 // at the manager's desk, taking the job
  const HAND_MS = 900 // at the manager's desk, handing the report in
  const WALK = 4.5 // metres a second, at the least
  const LEG_S = 2.2 // no single walk takes longer than this
  const STROLL = 1.8 // metres a second, on a break: nobody hurries to the coffee
  const REST_MS = 2500 // at the least, sat idle this long before getting up
  const BREAK_MS = 3500 // at the least, this long at the coffee, a colleague or the shelf
  const CARRY = new Set(['brief', 'in', 'report']) // legs walked with a paper in hand
  // The floor plan, in metres.
  const HALL = 2.4 // the hallway down the left side
  const CORR = 2.6 // the corridor in front of each row of rooms
  const DEPTH = 5.4 // a room, back wall to front
  const COL = 2.7 // one desk's width of floor
  const PAD = 1.1 // floor either side of a room's desks
  const BOSS_W = 8
  const WALL_H = 2.6 // the building's outer back and left walls
  const PART_H = 1.05 // partitions between rooms, low so the camera sees over them
  const isDemo = new URLSearchParams(location.search).has('demo')
  const calm = matchMedia('(prefers-reduced-motion: reduce)')
  const darkQuery = matchMedia('(prefers-color-scheme: dark)')

  const el = id => document.getElementById(id)
  const hud = { bar: el('hud'), stats: el('stats'), status: el('status'), empty: el('empty'), summary: el('summary'), legend: el('legend') }
  const tip = el('tip')
  const panel = el('panel')
  const panelBody = el('panel-body')
  const labels = el('labels')
  const canvas = el('world')

  let view = null
  let mode = isDemo ? 'demo' : 'connecting'
  let hasLoaded = false
  let pulls = 0
  const actors = new Map()
  const signs = new Map()
  const inboxCount = new Map()
  let hovered = null
  let pinned = null
  let pointer = null
  let drag = null
  let plan = { rooms: [], seats: new Map(), W: BOSS_W + HALL + 1, D: DEPTH + CORR, key: '' }
  let builtKey = ''
  let boxes = []

  // ---- renderer, camera, light --------------------------------------------

  // Colours below are written as sRGB, the way a designer picks them.
  THREE.ColorManagement.legacyMode = false
  let renderer = null
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  } catch {
    el('nogl').hidden = false
  }
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400)
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8070, 1)
  const sun = new THREE.DirectionalLight(0xffffff, 1)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0005
  scene.add(hemi, sun, sun.target)
  const building = new THREE.Group()
  const furniture = new THREE.Group()
  const people = new THREE.Group()
  scene.add(building, furniture, people)
  // A ring on the floor under whoever the panel follows.
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 40), new THREE.MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.85 }))
  ring.rotation.x = -Math.PI / 2
  ring.visible = false
  scene.add(ring)
  if (renderer) {
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputEncoding = THREE.sRGBEncoding
  }

  // Camera: a fixed tilt, a yaw you can drag, and a zoom you can scroll.
  let yaw = Math.PI / 4
  let zoom = 1
  const TILT = 0.6

  // ---- palette: day in light mode, night in dark mode ----------------------

  const SHIRTS = ['#e0b15c', '#6aa88b', '#d07a8c', '#6c8fd6', '#d9925b', '#9a83c9', '#4fa7b5', '#b88d6a', '#7fb069', '#c96b5b']
  const HAIRS = ['#2b2420', '#5a3d2b', '#8a5a35', '#c9a66b', '#1c1c24', '#7a2e1f']
  const SKINS = ['#f2d0b1', '#e6bc93', '#c9946b', '#9a6a48', '#6b4630']

  function palette(isDark) {
    return isDark
      ? {
          isDark,
          bg: 0x0b0e14,
          ground: '#1a1e27', corridor: '#232834', wall: '#2c3240', cap: '#3b4354', partition: '#2f3545',
          wood: '#5b4130', woodDark: '#4a3527', glass: '#6d8fbf', frame: '#a3adbf', rug: '#6d28d9',
          desk: '#6e5442', leg: '#2a2420', chair: '#1d2230', monitor: '#14171d', screenOn: '#38bdf8', screenOff: '#11151c',
          paper: '#e6e2d8', paperLit: '#a78bfa', plant: '#3e8e5a', plantDark: '#2b6a41', pot: '#8a5a3c', shelf: '#4a3526',
          window: '#1e3a5f', trousers: '#2b3240', violet: '#8b5cf6', gold: '#f5c542', carpetL: 22, carpetS: 18,
          hemi: [0x9fb4ff, 0x1a1410, 0.55], sun: [0xbfd0ff, 0.55], exposure: 1,
        }
      : {
          isDark,
          bg: 0xe8edf2,
          ground: '#d6d0c4', corridor: '#e7e1d5', wall: '#f4f0e8', cap: '#cfc5b4', partition: '#efe9de',
          wood: '#c79b6c', woodDark: '#b5895c', glass: '#bfe1ff', frame: '#5d6676', rug: '#8b5cf6',
          desk: '#cfa77c', leg: '#5f5146', chair: '#3d4556', monitor: '#272b33', screenOn: '#38bdf8', screenOff: '#1f2530',
          paper: '#fbfaf6', paperLit: '#a78bfa', plant: '#4f9d69', plantDark: '#3b7d51', pot: '#b5734a', shelf: '#7c5a3c',
          window: '#a9d8f5', trousers: '#3b4252', violet: '#7c3aed', gold: '#f2b705', carpetL: 84, carpetS: 28,
          hemi: [0xffffff, 0x8a7a66, 1.0], sun: [0xfff2dd, 0.95], exposure: 1,
        }
  }
  // Light or dark: the switch's choice, remembered in this browser, else the system's.
  const THEME_KEY = 'basivo-world-theme'
  let chosen = null
  try {
    chosen = localStorage.getItem(THEME_KEY)
  } catch {}
  const wantsDark = () => (chosen ? chosen === 'dark' : darkQuery.matches)
  let pal = palette(wantsDark())
  function markTheme() {
    const root = document.documentElement
    if (chosen) root.dataset.theme = chosen
    else delete root.dataset.theme
    root.dataset.dark = pal.isDark ? '1' : ''
    el('theme').setAttribute('aria-label', pal.isDark ? 'Switch to light mode' : 'Switch to dark mode')
  }
  markTheme()

  function applyLight() {
    hemi.color.set(pal.hemi[0])
    hemi.groundColor.set(pal.hemi[1])
    hemi.intensity = pal.hemi[2]
    sun.color.set(pal.sun[0])
    sun.intensity = pal.sun[1]
  }
  applyLight()

  function applyTheme() {
    pal = palette(wantsDark())
    markTheme()
    applyLight()
    mats.clear()
    for (const actor of actors.values()) rebuildActor(actor)
    builtKey = ''
  }
  darkQuery.addEventListener('change', () => {
    if (!chosen) applyTheme()
  })

  // The switch: a snapshot of the old scene sits on top and shrinks into the button
  // as a closing circle, so the new light spreads out from where you clicked.
  const fade = el('fade')
  let fading = null
  el('theme').addEventListener('click', () => {
    chosen = pal.isDark ? 'light' : 'dark'
    try {
      localStorage.setItem(THEME_KEY, chosen)
    } catch {}
    let shot = null
    if (renderer && !calm.matches) {
      try {
        // Flattened onto the old background, so nothing of the new one shows through
        // the canvas's see-through pixels while it shrinks away.
        renderer.render(scene, camera)
        const flat = document.createElement('canvas')
        flat.width = canvas.width
        flat.height = canvas.height
        const g = flat.getContext('2d')
        g.fillStyle = getComputedStyle(document.body).backgroundColor
        g.fillRect(0, 0, flat.width, flat.height)
        g.drawImage(canvas, 0, 0)
        shot = flat.toDataURL('image/jpeg', 0.92)
      } catch {}
    }
    applyTheme()
    if (!shot) return
    const r = el('theme').getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    fading?.cancel()
    fade.src = shot
    fade.hidden = false
    fading = fade.animate([{ clipPath: `circle(${far}px at ${x}px ${y}px)` }, { clipPath: `circle(0px at ${x}px ${y}px)` }], {
      duration: 900,
      easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
    })
    fading.onfinish = () => {
      fade.hidden = true
      fading = null
    }
  })

  // ---- shared geometry and materials ---------------------------------------

  const geos = new Map()
  const geo = (key, make) => {
    if (!geos.has(key)) geos.set(key, make())
    return geos.get(key)
  }
  const box = (w, h, d) => geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d))
  const mats = new Map()
  const mat = (color, extra = {}) => {
    const key = `${color}|${JSON.stringify(extra)}`
    if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra }))
    return mats.get(key)
  }

  function mesh(g, m, x = 0, y = 0, z = 0, parent = null) {
    const n = new THREE.Mesh(g, m)
    n.position.set(x, y, z)
    n.castShadow = true
    n.receiveShadow = true
    if (parent) parent.add(n)
    return n
  }

  // ---- small helpers -------------------------------------------------------

  function hash(text) {
    let x = 2166136261
    for (let i = 0; i < text.length; i += 1) {
      x ^= text.charCodeAt(i)
      x = Math.imul(x, 16777619)
    }
    return x >>> 0
  }
  const hueOf = type => (hash(type) % 12) * 30 + 10
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
  const nameOf = a => (a.id === 'main' ? 'Boss' : a.label || a.type)
  const short = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
  const h = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
  }

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

  function blocksFor(weight) {
    if (!(weight > 0)) return 0
    return Math.max(0, Math.min(6, Math.floor(Math.log10(weight)) - 1))
  }

  // Lucide icons, static markup only.
  const ICONS = {
    read: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    bash: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    web: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    agent: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    plug: '<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    think: '<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2Z"/>',
    dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    wait: '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    done: '<path d="M20 6 9 17l-5-5"/>',
    fail: '<path d="M18 6 6 18M6 6l12 12"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    coffee: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M6 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>',
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8M16 17H8M10 9H8"/>',
  }
  function icon(name) {
    const t = document.createElement('template')
    t.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS.dots}</svg>`
    return t.content.firstChild
  }
  function iconFor(tool) {
    if (!tool) return 'think'
    if (/^(Read|Grep|Glob|LS)$/.test(tool)) return 'read'
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'edit'
    if (/^(Bash|BashOutput|KillShell|Monitor)$/.test(tool)) return 'bash'
    if (/^Web/.test(tool)) return 'web'
    if (/^(Agent|Task)$/.test(tool)) return 'agent'
    if (/^mcp__/.test(tool)) return 'plug'
    return 'dots'
  }

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
  const isReported = a => a.shown === 'done' || a.shown === 'failed'

  // Places, looked up every frame so a walker still arrives after a re-layout: behind
  // an agent's own chair, and in front of a manager's desk, where a visitor stands.
  const homeOf = id => () => {
    const s = plan.seats.get(id)
    return s ? { x: s.x, z: s.stand, room: s.room } : null
  }
  const visitOf = id => () => {
    const s = plan.seats.get(id)
    return s ? { x: s.x + s.visit[0], z: s.visit[1], room: s.room, face: [s.x, s.deskZ] } : null
  }

  // Break spots. The coffee corner of a row is in the hallway, against the outer wall,
  // level with that row's corridor; it is a place of its own, so routes leave the room.
  const coffeeOf = id => () => {
    const s = plan.seats.get(id)
    if (!s) return null
    const c = s.room.corr
    return { x: 0.95, z: c, room: { door: HALL / 2, aisle: c, corr: c, row: s.room.row }, face: [0, c] }
  }
  // The boss stays in the cabin: the bookshelf, or the window in the far corner.
  const cabinSpot = which => () => {
    const s = plan.seats.get('main')
    if (!s) return null
    const r = s.room
    return which ? { x: r.x + 1.2, z: r.z + 1.15, room: r, face: [r.x + 1.2, r.z] } : { x: r.x + r.w - 1.7, z: r.z + 1.0, room: r, face: [r.x + r.w - 1.3, r.z] }
  }

  // An agent with nothing to do does what people in an office do: it gets up, has a
  // coffee or a word with a colleague, and comes back. Working and waiting agents stay
  // at their desks, so a walk never hides what the session is doing.
  function maybeBreak(actor, now) {
    const a = actor.agent
    if (calm.matches || actor.legs.length || isActive(a) || !plan.seats.has(a.id)) {
      actor.breakAt = null
      return
    }
    actor.breaks ??= 0
    actor.breakAt ??= now + REST_MS + (hash(`${a.id}:${actor.breaks}`) % 5000)
    if (now < actor.breakAt) return
    actor.breakAt = null
    actor.breaks += 1
    const pick = hash(`${a.id}/${actor.breaks}`)
    const seat = plan.seats.get(a.id)
    const home = homeOf(a.id)
    const hold = BREAK_MS + (pick % 3000)
    if (seat.isBoss) {
      const to = cabinSpot(pick % 2)
      actor.legs.push({ kind: 'stroll', from: home, to, hold, direct: true }, { kind: 'back', from: to, to: home, hold: 0, direct: true })
      return
    }
    const mates = seat.room.members.filter(id => id !== a.id && actors.has(id))
    const isChat = mates.length > 0 && pick % 3 === 0
    const to = isChat ? visitOf(mates[(pick >>> 3) % mates.length]) : coffeeOf(a.id)
    actor.legs.push({ kind: isChat ? 'chat' : 'coffee', from: home, to, hold }, { kind: 'back', from: to, to: home, hold: 0 })
  }

  function apply(next) {
    const now = performance.now()
    const byId = new Map(next.agents.map(a => [a.id, a]))
    // A helper reports to its spawner. One whose spawner was never seen sits in the
    // main office and reports to no one: there is no manager we can honestly name.
    const managerOf = a => (a.id !== 'main' && a.parentId && !a.isOrphan && byId.has(a.parentId) ? a.parentId : null)
    const seen = new Set()
    for (const a of next.agents) {
      seen.add(a.id)
      const boss = managerOf(a)
      let actor = actors.get(a.id)
      if (!actor) {
        actor = { agent: a, legs: [], phase: (hash(a.id) % 1000) / 160 }
        actors.set(a.id, actor)
        rebuildActor(actor)
        // On first load everyone is already at their desk, and reports already in
        // are on the managers' desks. Later, a newcomer walks in from its manager.
        if (view && boss && actors.has(boss)) {
          actor.legs.push(
            { kind: 'brief', from: visitOf(boss), to: visitOf(boss), hold: BRIEF_MS },
            { kind: 'in', from: visitOf(boss), to: homeOf(a.id), hold: 0 },
          )
        } else if (!view && boss && isReported(a)) {
          inboxCount.set(boss, (inboxCount.get(boss) ?? 0) + 1)
        }
      } else if (!isReported(actor.agent) && isReported(a) && boss) {
        // The one real conversation between agents: a helper handing its result back.
        actor.legs.push(
          { kind: 'report', from: homeOf(a.id), to: visitOf(boss), hold: HAND_MS, deliver: boss },
          { kind: 'home', from: visitOf(boss), to: homeOf(a.id), hold: 0 },
        )
      }
      actor.agent = a
    }
    for (const [id, actor] of actors) {
      if (seen.has(id)) continue
      dropActor(actor)
      actors.delete(id)
    }
    view = next
    plan = layout(next.agents, managerOf)
    renderHud()
  }

  // ---- the floor plan ------------------------------------------------------

  // The boss's cabin first; then each manager's helpers share a room, in the order the
  // managers were spawned. Rooms flow into rows like words into lines, at whatever row
  // width lets the building fill the screen best.
  function layout(agents, managerOf) {
    const byId = new Map(agents.map(a => [a.id, a]))
    const teams = new Map()
    for (const a of agents) {
      if (a.id === 'main') continue
      const m = managerOf(a) ?? 'main'
      teams.set(m, [...(teams.get(m) ?? []), a.id])
    }
    const all = [{ id: 'main', kind: 'boss', members: ['main'], w: BOSS_W }]
    for (const [m, ids] of teams) all.push({ id: m, kind: 'team', members: ids, w: ids.length * COL + PAD * 2 })

    const pack = cap => {
      const rows = [[]]
      let used = 0
      for (const r of all) {
        if (rows[rows.length - 1].length && used + r.w > cap) {
          rows.push([])
          used = 0
        }
        rows[rows.length - 1].push(r)
        used += r.w
      }
      return rows
    }
    // Score a packing by how large the building would be drawn on this screen.
    const aspect = Math.max(0.4, innerWidth / Math.max(1, innerHeight - 140))
    const total = all.reduce((s, r) => s + r.w, 0)
    let rows = null
    let best = -1
    for (let cap = Math.max(...all.map(r => r.w)); cap <= total + 0.01; cap += 1) {
      const packed = pack(cap)
      const W = HALL + Math.max(...packed.map(list => list.reduce((s, r) => s + r.w, 0))) + 0.6
      const D = packed.length * (DEPTH + CORR)
      const sw = (W + D) * 0.71
      const sh = (W + D) * 0.71 * Math.sin(TILT) + WALL_H
      const score = Math.min(aspect / sw, 1 / sh)
      if (score > best) {
        best = score
        rows = packed
      }
    }
    const widest = Math.max(...rows.map(list => list.reduce((s, r) => s + r.w, 0)))
    const W = HALL + widest + 0.6
    const D = rows.length * (DEPTH + CORR)
    const rooms = []
    const seats = new Map()
    rows.forEach((list, f) => {
      let x = HALL + (widest - list.reduce((s, r) => s + r.w, 0)) / 2
      const z = f * (DEPTH + CORR)
      for (const room of list) {
        const lead = byId.get(room.id)
        Object.assign(room, {
          x,
          z,
          row: f,
          door: x + room.w / 2,
          aisle: z + DEPTH - 1.0,
          corr: z + DEPTH + CORR / 2,
          name: room.kind === 'boss' ? "Boss's cabin" : room.id === 'main' ? 'Main office' : `${cap(lead?.type ?? 'team')} team`,
          hue: room.id === 'main' ? 265 : hueOf(lead?.type ?? ''),
        })
        room.members.forEach((id, i) => {
          if (room.kind === 'boss') {
            // The boss faces the door, desk between it and its visitors.
            const sx = x + room.w / 2
            seats.set(id, { x: sx, deskZ: z + 2.5, chairZ: z + 1.65, stand: z + 1.0, facing: 0, visit: [0.9, z + 3.6], room, isBoss: true })
          } else {
            // Helpers face the back wall, so their screens face you.
            const sx = x + PAD + COL * (i + 0.5)
            seats.set(id, { x: sx, deskZ: z + 1.8, chairZ: z + 2.6, stand: z + 3.3, facing: Math.PI, visit: [1.05, z + 2.75], room, isBoss: false })
          }
        })
        rooms.push(room)
        x += room.w
      }
    })
    const key = rooms.map(r => `${r.id}:${r.x.toFixed(2)},${r.z},${r.w}`).join('|') + `|${W}|${D}`
    return { rooms, seats, W, D, key }
  }

  // Everything that does not move: the slab, outer walls with windows, each room's
  // floor and partitions, the boss's glass cabin, rug, bookshelf and plants.
  function build() {
    building.clear()
    const { W, D, rooms } = plan
    mesh(box(W, 0.2, D), mat(pal.corridor), W / 2, -0.1, D / 2, building)
    // The outer back and left walls, full height, with windows.
    mesh(box(W, WALL_H, 0.2), mat(pal.wall), W / 2, WALL_H / 2, -0.1, building)
    mesh(box(0.2, WALL_H, D), mat(pal.wall), -0.1, WALL_H / 2, D / 2, building)
    mesh(box(W + 0.2, 0.08, 0.24), mat(pal.cap), W / 2 - 0.1, WALL_H + 0.04, -0.1, building)
    mesh(box(0.24, 0.08, D), mat(pal.cap), -0.1, WALL_H + 0.04, D / 2, building)
    const glow = pal.isDark ? { emissive: pal.window, emissiveIntensity: 0.6 } : {}
    for (let x = 1.6; x < W - 1; x += 3.2) mesh(box(1.8, 1.0, 0.05), mat(pal.window, glow), x, 1.55, 0.02, building)
    for (let z = 1.6; z < D - 1; z += 3.2) mesh(box(0.05, 1.0, 1.8), mat(pal.window, glow), 0.02, 1.55, z, building)
    // The low outer front and right walls: a cutaway, so you can see in.
    mesh(box(W, 0.3, 0.15), mat(pal.cap), W / 2, 0.15, D, building)
    mesh(box(0.15, 0.3, D), mat(pal.cap), W, 0.15, D / 2, building)

    // A coffee corner per row, in the hallway against the outer wall.
    for (const c of new Set(rooms.map(r => r.corr))) coffeeCorner(c)
    for (const r of rooms) {
      const cx = r.x + r.w / 2
      const cz = r.z + DEPTH / 2
      if (r.kind === 'boss') {
        mesh(box(r.w - 0.1, 0.04, DEPTH - 0.1), mat(pal.wood), cx, 0.02, cz, building)
        for (let z = r.z + 0.6; z < r.z + DEPTH; z += 0.6) mesh(box(r.w - 0.1, 0.045, 0.02), mat(pal.woodDark), cx, 0.02, z, building)
        const rug = mesh(box(3.6, 0.02, 2.6), mat(pal.rug, { transparent: true, opacity: 0.35 }), cx, 0.05, r.z + 2.3, building)
        rug.castShadow = false
        glassWalls(r)
        bookshelf(r.x + 1.2, r.z + 0.35)
        plant(r.x + 0.6, r.z + DEPTH - 0.6)
        plant(r.x + r.w - 0.6, r.z + 0.6)
        sofa(r.x + r.w - 1.0, r.z + 3.6)
      } else {
        const carpet = `hsl(${r.hue}, ${pal.carpetS}%, ${pal.carpetL}%)`
        mesh(box(r.w - 0.1, 0.04, DEPTH - 0.1), mat(carpet), cx, 0.02, cz, building)
        partitions(r)
        plant(r.x + r.w - 0.55, r.z + DEPTH - 0.55)
      }
    }
    // Light and shadow that cover the whole building.
    const span = Math.max(W, D) * 0.9 + 6
    sun.position.set(W / 2 + span * 0.5, span, D / 2 + span * 0.35)
    sun.target.position.set(W / 2, 0, D / 2)
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: span * 4 })
    sun.shadow.camera.updateProjectionMatrix()
    builtKey = plan.key
    syncSigns()
  }

  // A room's walls: back and sides as low partitions with a cap, the front lower still
  // and broken by the door.
  function partitions(r) {
    const m = mat(pal.partition)
    const capM = mat(pal.cap)
    const wall = (w, hgt, d, x, z) => {
      mesh(box(w, hgt, d), m, x, hgt / 2, z, building)
      mesh(box(w + 0.02, 0.05, d + 0.02), capM, x, hgt + 0.025, z, building)
    }
    if (r.z > 0) wall(r.w, PART_H, 0.1, r.x + r.w / 2, r.z)
    wall(0.1, PART_H, DEPTH, r.x, r.z + DEPTH / 2)
    wall(0.1, PART_H, DEPTH, r.x + r.w, r.z + DEPTH / 2)
    const d0 = r.door - 0.75
    const d1 = r.door + 0.75
    wall(d0 - r.x, 0.4, 0.1, (r.x + d0) / 2, r.z + DEPTH)
    wall(r.x + r.w - d1, 0.4, 0.1, (d1 + r.x + r.w) / 2, r.z + DEPTH)
  }

  // The boss's cabin: glass on every side, framed, with a door at the front.
  function glassWalls(r) {
    const glass = mat(pal.glass, { transparent: true, opacity: 0.22, roughness: 0.1, depthWrite: false })
    const frame = mat(pal.frame)
    const H = 2.3
    const pane = (w, d, x, z) => {
      const p = mesh(box(w, H, d), glass, x, H / 2, z, building)
      p.castShadow = false
      mesh(box(w + 0.04, 0.06, d + 0.04), frame, x, H, z, building)
      mesh(box(w + 0.04, 0.06, d + 0.04), frame, x, 0.03, z, building)
    }
    if (r.z > 0) pane(r.w, 0.06, r.x + r.w / 2, r.z)
    pane(0.06, DEPTH, r.x, r.z + DEPTH / 2)
    pane(0.06, DEPTH, r.x + r.w, r.z + DEPTH / 2)
    const d0 = r.door - 0.8
    const d1 = r.door + 0.8
    pane(d0 - r.x, 0.06, (r.x + d0) / 2, r.z + DEPTH)
    pane(r.x + r.w - d1, 0.06, (d1 + r.x + r.w) / 2, r.z + DEPTH)
    for (const [x, z] of [[r.x, r.z], [r.x + r.w, r.z], [r.x, r.z + DEPTH], [r.x + r.w, r.z + DEPTH], [d0, r.z + DEPTH], [d1, r.z + DEPTH]]) {
      mesh(box(0.08, H, 0.08), frame, x, H / 2, z, building)
    }
  }

  function coffeeCorner(z) {
    mesh(box(0.55, 0.9, 1.5), mat(pal.desk), 0.32, 0.45, z, building)
    mesh(box(0.6, 0.04, 1.56), mat(pal.woodDark), 0.32, 0.92, z, building)
    mesh(box(0.34, 0.46, 0.34), mat(pal.monitor), 0.3, 1.17, z - 0.35, building)
    mesh(box(0.05, 0.08, 0.12), mat(pal.screenOn, { emissive: pal.screenOn, emissiveIntensity: 0.8 }), 0.48, 1.25, z - 0.35, building)
    const cup = geo('cup', () => new THREE.CylinderGeometry(0.05, 0.04, 0.1, 10))
    for (const [dz, c] of [[0.1, '#fbfaf6'], [0.3, '#d07a8c'], [0.45, '#6c8fd6']]) mesh(cup, mat(c), 0.38, 0.99, z + dz, building)
    // A water cooler beside it.
    mesh(geo('cooler', () => new THREE.CylinderGeometry(0.17, 0.17, 0.9, 14)), mat(pal.wall), 0.3, 0.45, z + 1.05, building)
    mesh(geo('bottle', () => new THREE.CylinderGeometry(0.14, 0.14, 0.38, 14)), mat(pal.glass, { transparent: true, opacity: 0.6, roughness: 0.1 }), 0.3, 1.09, z + 1.05, building)
  }

  function plant(x, z) {
    mesh(geo('pot', () => new THREE.CylinderGeometry(0.2, 0.15, 0.35, 12)), mat(pal.pot), x, 0.175, z, building)
    mesh(geo('leaf1', () => new THREE.IcosahedronGeometry(0.34, 0)), mat(pal.plant, { flatShading: true }), x, 0.62, z, building)
    mesh(geo('leaf2', () => new THREE.IcosahedronGeometry(0.24, 0)), mat(pal.plantDark, { flatShading: true }), x + 0.1, 0.9, z - 0.05, building)
  }

  function bookshelf(x, z) {
    mesh(box(1.6, 1.9, 0.35), mat(pal.shelf), x, 0.95, z, building)
    for (let s = 0; s < 4; s += 1) {
      for (let b = 0; b < 7; b += 1) {
        const hgt = 0.26 + ((b * 7 + s * 3) % 3) * 0.04
        mesh(box(0.16, hgt, 0.24), mat(SHIRTS[(b + s * 3) % SHIRTS.length]), x - 0.62 + b * 0.2, 0.18 + s * 0.45 + hgt / 2, z + 0.06, building)
      }
    }
  }

  function sofa(x, z) {
    const m = mat(pal.isDark ? '#3b3f58' : '#8e9ab5')
    mesh(box(0.8, 0.4, 1.8), m, x, 0.2, z, building)
    mesh(box(0.2, 0.75, 1.8), m, x + 0.3, 0.375, z, building)
    mesh(box(0.8, 0.55, 0.2), m, x, 0.275, z - 0.9, building)
    mesh(box(0.8, 0.55, 0.2), m, x, 0.275, z + 0.9, building)
  }

  // ---- desks and people ----------------------------------------------------

  function makeDesk(a, isBoss) {
    const g = new THREE.Group()
    const w = isBoss ? 2.2 : 1.5
    const d = isBoss ? 1.0 : 0.75
    mesh(box(w, 0.06, d), mat(pal.desk), 0, 0.75, 0, g)
    // A modesty panel on the side away from the chair, so the desk reads as a desk.
    mesh(box(w - 0.1, 0.55, 0.04), mat(pal.desk), 0, 0.42, -d / 2 + 0.06, g)
    for (const sx of [-1, 1]) mesh(box(0.06, 0.72, d - 0.05), mat(pal.leg), sx * (w / 2 - 0.05), 0.36, 0, g)
    // The monitor faces the chair; its screen lights while its owner works.
    mesh(box(0.12, 0.2, 0.1), mat(pal.monitor), 0.25, 0.88, -0.15, g)
    mesh(box(0.7, 0.42, 0.05), mat(pal.monitor), 0.25, 1.15, -0.2, g)
    const screen = mesh(box(0.62, 0.34, 0.01), mat(pal.screenOff), 0.25, 1.15, -0.17, g)
    // The chair, on the near side.
    const chair = new THREE.Group()
    mesh(box(0.5, 0.08, 0.5), mat(pal.chair), 0, 0.48, 0, chair)
    mesh(box(0.5, 0.6, 0.08), mat(isBoss ? pal.violet : pal.chair), 0, 0.82, 0.25, chair)
    mesh(geo('pole', () => new THREE.CylinderGeometry(0.03, 0.03, 0.44, 8)), mat(pal.leg), 0, 0.22, 0, chair)
    mesh(geo('base', () => new THREE.CylinderGeometry(0.25, 0.25, 0.04, 12)), mat(pal.leg), 0, 0.02, 0, chair)
    chair.position.z = 0.85
    g.add(chair)
    // The cost: a stack of paper. On the boss's desk, a second stack: reports in.
    const papers = new THREE.Group()
    papers.position.set(-w / 2 + 0.3, 0.78, -0.05)
    g.add(papers)
    const tray = new THREE.Group()
    tray.position.set(-w / 2 + 0.75, 0.78, 0.05)
    g.add(tray)
    return { g, screen, papers, tray, chair }
  }

  function makePerson(a) {
    const g = new THREE.Group()
    const t = hash(a.type)
    const p = hash(a.id)
    const isMain = a.id === 'main'
    const shirt = mat(isMain ? pal.violet : SHIRTS[t % SHIRTS.length])
    const skin = mat(SKINS[p % SKINS.length])
    const hair = mat(HAIRS[(t >>> 5) % HAIRS.length])
    const trousers = mat(pal.trousers)
    const legGeo = geo('leg', () => new THREE.BoxGeometry(0.15, 0.72, 0.17).translate(0, -0.36, 0))
    const armGeo = geo('arm', () => new THREE.CapsuleGeometry(0.065, 0.4, 4, 8).translate(0, -0.27, 0))
    const legs = [-0.1, 0.1].map(x => {
      const leg = mesh(legGeo, trousers, x, 0.74, 0, g)
      return leg
    })
    mesh(geo('torso', () => new THREE.CapsuleGeometry(0.21, 0.36, 4, 12)), shirt, 0, 1.12, 0, g)
    const arms = [-0.29, 0.29].map(x => mesh(armGeo, shirt, x, 1.38, 0, g))
    const head = new THREE.Group()
    head.position.y = 1.68
    g.add(head)
    mesh(geo('head', () => new THREE.SphereGeometry(0.19, 16, 12)), skin, 0, 0, 0, head)
    mesh(geo('hair', () => new THREE.SphereGeometry(0.2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.1)), hair, 0, 0.02, -0.02, head)
    for (const x of [-0.07, 0.07]) mesh(geo('eye', () => new THREE.SphereGeometry(0.025, 6, 6)), mat('#111111'), x, 0.01, 0.17, head)
    if (isMain) {
      mesh(geo('crown', () => new THREE.CylinderGeometry(0.15, 0.17, 0.12, 8, 1, true)), mat(pal.gold, { metalness: 0.5, roughness: 0.4, side: THREE.DoubleSide }), 0, 0.2, 0, head)
    }
    // The paper it carries: its brief going in, its report coming back.
    const paper = mesh(box(0.24, 0.02, 0.3), mat(pal.paper), 0, 1.12, 0.3, g)
    paper.rotation.x = -0.35
    paper.visible = false
    return { g, legs, arms, head, paper }
  }

  function rebuildActor(actor) {
    dropActor(actor)
    const a = actor.agent
    const isBoss = a.id === 'main'
    actor.desk = makeDesk(a, isBoss)
    actor.person = makePerson(a)
    furniture.add(actor.desk.g)
    people.add(actor.person.g)
    actor.tag = h('div', `tag${isBoss ? ' boss' : ''}`)
    actor.tagName = h('div', 'n')
    actor.tagDetail = h('div', 'd')
    actor.tag.append(actor.tagName, actor.tagDetail)
    actor.bubble = h('div', 'bubble')
    labels.append(actor.tag, actor.bubble)
    actor.papersShown = -1
    actor.trayShown = -1
    actor.bubbleKey = null
    actor.placed = false
  }

  function dropActor(actor) {
    if (actor.desk) furniture.remove(actor.desk.g)
    if (actor.person) people.remove(actor.person.g)
    actor.tag?.remove()
    actor.bubble?.remove()
  }

  function stack(group, n, isLit, topColor) {
    group.clear()
    for (let i = 0; i < n; i += 1) {
      const sheet = mesh(box(0.3, 0.03, 0.22), mat(i === n - 1 && isLit ? topColor : pal.paper), 0, 0.015 + i * 0.035, 0, group)
      sheet.rotation.y = ((i * 37) % 9) * 0.03 - 0.12
    }
  }

  function syncSigns() {
    const keep = new Set(plan.rooms.map(r => r.id))
    for (const [id, s] of signs) {
      if (keep.has(id)) continue
      s.remove()
      signs.delete(id)
    }
    for (const r of plan.rooms) {
      let s = signs.get(r.id)
      if (!s) {
        s = h('div', 'sign')
        labels.prepend(s)
        signs.set(r.id, s)
      }
      s.className = `sign${r.kind === 'boss' ? ' boss' : ''}`
      s.textContent = r.name
    }
  }

  // ---- walking -------------------------------------------------------------

  // A walk from one place to another along the building's own paths: to the aisle,
  // through the door, along the corridor, up or down the hallway, and in through the
  // other room's door. Nobody walks through a wall.
  function route(A, B) {
    const pts = [[A.x, A.z], [A.x, A.room.aisle]]
    if (A.room !== B.room) {
      pts.push([A.room.door, A.room.aisle], [A.room.door, A.room.corr])
      if (A.room.row !== B.room.row) pts.push([HALL / 2, A.room.corr], [HALL / 2, B.room.corr])
      pts.push([B.room.door, B.room.corr], [B.room.door, B.room.aisle])
    }
    pts.push([B.x, B.room.aisle], [B.x, B.z])
    return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6)
  }

  function along(pts, d) {
    for (let i = 1; i < pts.length; i += 1) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
      if (d <= seg || i === pts.length - 1) {
        const t = seg === 0 ? 1 : Math.max(0, Math.min(1, d / seg))
        return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, z: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, dx: pts[i][0] - pts[i - 1][0], dz: pts[i][1] - pts[i - 1][1] }
      }
      d -= seg
    }
    const last = pts[pts.length - 1]
    return { x: last[0], z: last[1], dx: 0, dz: 1 }
  }

  // One step of an errand. Progress is a distance along the route, and the route is
  // re-read every frame, so a re-layout moves the walker with the building.
  function walk(actor, dt, now) {
    const leg = actor.legs[0]
    if (!leg) return null
    const from = leg.from()
    const to = leg.to()
    if (!from || !to) {
      actor.legs.shift()
      return null
    }
    const pts = leg.direct ? [[from.x, from.z], [to.x, to.z]] : route(from, to)
    let len = 0
    for (let i = 1; i < pts.length; i += 1) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    // On an errand nobody keeps the boss waiting; a break is taken at a stroll. Called
    // back to work mid-break, the agent heads straight back.
    if (!CARRY.has(leg.kind) && leg.kind !== 'home' && isActive(actor.agent)) leg.hold = 0
    const isErrand = CARRY.has(leg.kind) || leg.kind === 'home'
    const speed = calm.matches ? Infinity : isErrand ? Math.max(WALK, len / LEG_S) : isActive(actor.agent) ? WALK : STROLL
    leg.d = Math.min(len, (leg.d ?? 0) + speed * dt)
    const at = along(pts, leg.d)
    const moving = leg.d < len
    if (!moving) {
      leg.arrivedAt ??= now
      if (now - leg.arrivedAt >= leg.hold) {
        actor.legs.shift()
        if (leg.deliver) deliver(leg.deliver)
      }
    }
    const face = !moving && to.face ? Math.atan2(to.face[0] - at.x, to.face[1] - at.z) : Math.atan2(at.dx, at.dz)
    return { x: at.x, z: at.z, moving, face, kind: leg.kind }
  }

  function deliver(to) {
    inboxCount.set(to, (inboxCount.get(to) ?? 0) + 1)
  }

  // ---- per frame -----------------------------------------------------------

  const tmp = new THREE.Vector3()
  function toScreen(x, y, z) {
    tmp.set(x, y, z).project(camera)
    return [((tmp.x + 1) / 2) * innerWidth, ((1 - tmp.y) / 2) * innerHeight]
  }

  function stateOf(a, wall) {
    if (a.shown === 'running' && wall - a.lastAt > STALL_MS) return { cls: 'quiet', icon: 'clock', text: `quiet ${ago(wall - a.lastAt)}` }
    if (a.shown === 'running') return { cls: 'running', icon: iconFor(a.tool), text: a.tool ? short(a.tool.replace(/^mcp__/, ''), 14) : 'thinking' }
    return (
      {
        waiting: { cls: 'waiting', icon: 'wait', text: 'waiting' },
        done: { cls: 'done', icon: 'done', text: 'done' },
        failed: { cls: 'failed', icon: 'fail', text: 'failed' },
        stopped: { cls: '', icon: 'stop', text: 'stopped' },
      }[a.shown] ?? null
    )
  }

  function animate(actor, dt, now, wall) {
    const a = actor.agent
    const seat = plan.seats.get(a.id)
    if (!seat) return
    const { desk, person } = actor
    // The desk glides to a new place on a re-layout; its owner goes with it.
    const k = actor.placed ? Math.min(1, dt * 10) : 1
    actor.placed = true
    desk.g.position.x += (seat.x - desk.g.position.x) * k
    desk.g.position.z += (seat.deskZ - desk.g.position.z) * k
    desk.g.rotation.y = seat.facing === 0 ? Math.PI : 0
    const isStalled = a.shown === 'running' && wall - a.lastAt > STALL_MS
    const isWorking = a.shown === 'running' && !isStalled
    maybeBreak(actor, now)
    const trip = walk(actor, dt, now)
    const t = now / 1000 + actor.phase

    desk.screen.material = mat(isWorking && !trip ? pal.screenOn : pal.screenOff, isWorking && !trip ? { emissive: pal.screenOn, emissiveIntensity: 1.1 } : {})
    const sheets = blocksFor(a.weight)
    const lit = isActive(a)
    if (actor.papersShown !== sheets * 2 + (lit ? 1 : 0)) {
      stack(desk.papers, sheets, lit, pal.paperLit)
      actor.papersShown = sheets * 2 + (lit ? 1 : 0)
    }
    const reports = Math.min(12, inboxCount.get(a.id) ?? 0)
    if (actor.trayShown !== reports) {
      stack(desk.tray, reports, false, pal.paper)
      actor.trayShown = reports
    }

    const P = person
    const isCarrying = Boolean(trip && CARRY.has(trip.kind))
    P.paper.visible = isCarrying
    if (trip) {
      // Out of the chair: walking, or standing at the manager's desk.
      P.g.position.set(trip.x, 0, trip.z)
      P.g.rotation.y = trip.face
      const swing = trip.moving ? Math.sin(t * 11) * 0.6 : 0
      P.legs[0].rotation.x = swing
      P.legs[1].rotation.x = -swing
      // A paper is carried in both hands; otherwise the arms swing, or one lifts a cup.
      const sip = trip.kind === 'coffee' && !trip.moving ? -1.6 - Math.max(0, Math.sin(t * 1.3)) * 0.5 : null
      P.arms[0].rotation.x = isCarrying ? -0.9 : -swing * 0.8
      P.arms[1].rotation.x = isCarrying ? -0.9 : (sip ?? swing * 0.8)
      P.g.position.y = trip.moving ? Math.abs(Math.sin(t * 11)) * 0.05 : 0
      P.head.rotation.x = 0
    } else {
      // In the chair: legs under the desk, arms on the keyboard while working.
      const chairZ = desk.g.position.z + (seat.chairZ - seat.deskZ)
      P.g.position.set(desk.g.position.x, -0.26, chairZ)
      P.g.rotation.y = seat.facing
      P.legs[0].rotation.x = P.legs[1].rotation.x = -Math.PI / 2
      const typing = isWorking ? Math.sin(t * 18) * 0.08 : 0
      const reach = isWorking ? -1.15 : a.shown === 'waiting' ? -0.2 : -0.5
      P.arms[0].rotation.x = reach + typing
      P.arms[1].rotation.x = reach - typing
      P.head.rotation.x = a.shown === 'waiting' ? -0.25 + Math.sin(t * 1.5) * 0.05 : isWorking ? 0.12 + Math.sin(t * 3) * 0.03 : 0
    }

    // Labels: a name tag at the desk, a bubble over whoever is there.
    const tagAt = toScreen(desk.g.position.x, 0, desk.g.position.z + (seat.isBoss ? 0.75 : 1.45))
    const reportsIn = inboxCount.get(a.id) ?? 0
    actor.tagName.textContent = a.id === 'main' ? 'Boss' : short(nameOf(a), 22)
    actor.tagDetail.textContent = `${fmt(a.weight)} tok${a.isBackground ? ' · bg' : ''}${a.isOrphan ? ' · ?' : ''}${reportsIn ? ` · ${reportsIn} report${reportsIn === 1 ? '' : 's'} in` : ''}`
    actor.tag.className = `tag${a.id === 'main' ? ' boss' : ''}${a.shown === 'done' || a.shown === 'stopped' ? ' faded' : ''}${a.shown === 'failed' ? ' failed' : ''}`
    actor.tag.style.transform = `translate(${Math.round(tagAt[0])}px, ${Math.round(tagAt[1])}px) translate(-50%, 0)`

    const headY = trip ? 2.1 : 1.85
    const headAt = toScreen(P.g.position.x, headY + P.g.position.y, P.g.position.z)
    const s = !trip || trip.kind === 'home' || trip.kind === 'back' || (trip.moving && !CARRY.has(trip.kind))
      ? stateOf(a, wall)
      : trip.kind === 'coffee' ? { cls: 'brief', icon: 'coffee', text: 'coffee' }
      : trip.kind === 'chat' ? { cls: 'brief', icon: 'chat', text: 'chat' }
      : trip.kind === 'stroll' ? { cls: 'brief', icon: 'book', text: 'break' }
      : { cls: trip.kind === 'report' ? (a.shown === 'failed' ? 'failed' : 'report') : 'brief', icon: trip.kind === 'report' && a.shown === 'failed' ? 'fail' : 'file', text: trip.kind === 'report' ? 'report' : 'brief' }
    const bubbleKey = s ? `${s.cls}|${s.icon}|${s.text}` : ''
    if (actor.bubbleKey !== bubbleKey) {
      actor.bubbleKey = bubbleKey
      actor.bubble.hidden = !s
      if (s) {
        actor.bubble.className = `bubble ${s.cls}`
        actor.bubble.replaceChildren(icon(s.icon), s.text)
      }
    }
    actor.bubble.style.transform = `translate(${Math.round(headAt[0])}px, ${Math.round(headAt[1])}px) translate(-50%, -100%)`

    // The hit box: the person and the desk together, on screen.
    // While walking it is the person alone, so a walker is picked where they are.
    const feet = toScreen(P.g.position.x, 0, P.g.position.z)
    const pts = trip
      ? [headAt, feet, [feet[0] - 16, feet[1]], [feet[0] + 16, feet[1]]]
      : [headAt, feet, toScreen(desk.g.position.x - 1, 0.8, desk.g.position.z), toScreen(desk.g.position.x + 1, 0.8, desk.g.position.z), [tagAt[0], tagAt[1] + 30]]
    const xs = pts.map(q => q[0])
    const ys = pts.map(q => q[1])
    boxes.push({ id: a.id, x: Math.min(...xs) - 4, y: Math.min(...ys) - 4, w: Math.max(...xs) - Math.min(...xs) + 8, h: Math.max(...ys) - Math.min(...ys) + 8 })
  }

  function fitCamera() {
    const W = plan.W
    const D = plan.D
    const center = new THREE.Vector3(W / 2, 0.8, D / 2)
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(TILT), Math.sin(TILT), Math.cos(yaw) * Math.cos(TILT))
    camera.position.copy(center).addScaledVector(dir, 120)
    camera.up.set(0, 1, 0)
    camera.lookAt(center)
    camera.updateMatrixWorld()
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const x of [0, W]) {
      for (const y of [0, WALL_H]) {
        for (const z of [0, D]) {
          tmp.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
          minX = Math.min(minX, tmp.x)
          maxX = Math.max(maxX, tmp.x)
          minY = Math.min(minY, tmp.y)
          maxY = Math.max(maxY, tmp.y)
        }
      }
    }
    const top = hud.bar.offsetHeight + 8
    const bottom = hud.legend.offsetHeight + 28
    // An open panel on the right takes its width out of the stage.
    const side = !panel.hidden && innerWidth > 560 ? panel.offsetWidth : 0
    const avail = innerWidth - side
    const roomW = avail - 24
    const roomH = Math.max(100, innerHeight - top - bottom)
    const scale = Math.min(roomW / (maxX - minX), roomH / (maxY - minY)) * zoom
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    camera.left = cx - avail / 2 / scale
    camera.right = camera.left + innerWidth / scale
    camera.top = cy + (top + roomH / 2) / scale
    camera.bottom = camera.top - innerHeight / scale
    camera.updateProjectionMatrix()
  }

  let previous = performance.now()

  // One clock for everything: errands are stamped with performance.now(), so the frame
  // reads the same clock rather than the timestamp rAF hands in.
  function frame() {
    const now = performance.now()
    const dt = Math.min(0.1, (now - previous) / 1000)
    previous = now
    if (isDemo) {
      const next = Demo.at(Date.now())
      if (!view || next.updatedAt !== view.updatedAt) apply(next)
    }
    if (renderer) {
      const size = renderer.getSize(new THREE.Vector2())
      if (size.x !== innerWidth || size.y !== innerHeight) renderer.setSize(innerWidth, innerHeight, false)
      renderer.setClearColor(pal.bg, 0)
    }
    if (builtKey !== plan.key) build()
    fitCamera()
    boxes = []
    const wall = Date.now()
    for (const actor of actors.values()) animate(actor, dt, now, wall)
    for (const r of plan.rooms) {
      const s = signs.get(r.id)
      if (!s) continue
      const at = toScreen(r.x + r.w / 2, r.kind === 'boss' ? 2.45 : PART_H + 0.25, r.z + 0.05)
      s.style.transform = `translate(${Math.round(at[0])}px, ${Math.round(at[1])}px) translate(-50%, -100%)`
    }
    const followed = pinned ? actors.get(pinned) : null
    ring.visible = Boolean(followed)
    if (followed) {
      ring.position.set(followed.person.g.position.x, 0.06, followed.person.g.position.z)
      ring.material.color.set(pal.violet)
      ring.scale.setScalar(1 + Math.sin(now / 300) * 0.06)
    }
    if (renderer) renderer.render(scene, camera)
    // Hover is re-judged every frame, so a desk that glides under a still pointer counts.
    if (pointer && !drag) hovered = hitAt(...pointer)
    updateTip()
    renderPanel()
    requestAnimationFrame(frame)
  }

  // ---- HUD, tooltip, summary -----------------------------------------------

  function renderHud() {
    if (!view) return
    const c = view.counts
    const helpers = c.all - 1
    const parts = [`${helpers} helper${helpers === 1 ? '' : 's'}`, `${c.running} running`, `${c.waiting} waiting`]
    if (c.done) parts.push(`${c.done} done`)
    if (c.failed) parts.push(`${c.failed} failed`)
    if (c.maxDepth > 1) parts.push(`depth ${c.maxDepth}`)
    parts.push(`≈${fmt(view.totals.weighted)} weighted tokens`)
    const text = parts.join(' · ')
    if (hud.stats.dataset.text !== text) {
      hud.stats.dataset.text = text
      hud.stats.replaceChildren(
        ...parts.map(p => {
          const [num, ...rest] = p.split(' ')
          const chip = h('span', 'stat')
          chip.append(h('b', '', num), rest.join(' '))
          return chip
        }),
      )
    }
    hud.empty.hidden = helpers > 0
    const said = view.agents
      .filter(a => a.id !== 'main')
      .map(a => `${a.label || a.type} ${a.shown === 'running' ? `running ${a.tool ?? ''}`.trim() : a.shown}`)
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
    const id = hovered && hovered !== pinned ? hovered : null
    const actor = id ? actors.get(id) : null
    const b = id ? boxes.find(x => x.id === id) : null
    if (!actor || !b) {
      tip.hidden = true
      return
    }
    const a = actor.agent
    const parent = a.parentId ? view?.agents.find(p => p.id === a.parentId) : null
    const wall = Date.now()
    const isStalled = a.shown === 'running' && wall - a.lastAt > STALL_MS
    const rows = [
      ['', a.id === 'main' ? 'Boss · main session' : a.label || a.type],
      ['', a.type],
      [
        'state',
        `${a.shown}${isStalled ? ` · quiet ${ago(wall - a.lastAt)}` : ''}${a.shown === 'waiting' ? ' on a helper' : ''}${a.isBackground ? ' · background' : ''}`,
      ],
      ['doing', a.shown === 'running' ? (a.tool ?? 'thinking') : '—'],
      ['room', plan.seats.get(a.id)?.room.name ?? '—'],
      ['model', a.model ?? '—'],
      ['reports to', a.isOrphan ? 'not seen' : parent ? nameOf(parent) : '—'],
      ['reports in', String(inboxCount.get(a.id) ?? 0)],
      ['tools', String(a.toolCalls)],
      ['tokens', `${fmt(a.tokens.input)} in · ${fmt(a.tokens.output)} out`],
      ['cache', `${fmt(a.tokens.cacheRead)} read · ${fmt(a.tokens.cacheWrite)} written`],
      ['weighted', fmt(a.weight)],
      ['for', ago((a.endedAt ?? wall) - a.startedAt)],
    ]
    const key = rows.map(r => r[1]).join('|')
    if (tip.dataset.key !== key) {
      tip.dataset.key = key
      // textContent only: labels come from the session and are never parsed as HTML.
      tip.replaceChildren(
        ...rows.map(([k, v], i) => {
          const row = h('div', i === 0 ? 'tip-title' : i === 1 ? 'tip-label' : 'tip-row')
          if (k) row.append(h('span', '', k))
          row.append(h('span', '', v))
          return row
        }),
      )
    }
    tip.hidden = false
    const w = tip.offsetWidth
    const left = b.x + b.w + w + 12 > innerWidth ? b.x - w - 8 : b.x + b.w + 8
    tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, left))}px`
    tip.style.top = `${Math.max(8, Math.min(innerHeight - tip.offsetHeight - 8, b.y))}px`
  }

  // ---- the detail panel ----------------------------------------------------

  // Click anyone: a panel on the right follows them, with what they are running now,
  // their last few tool calls, their manager and helpers, and what they have cost.
  function follow(id) {
    pinned = id && actors.has(id) ? id : null
    panel.hidden = !pinned
    document.body.classList.toggle('panel-open', Boolean(pinned))
    panel.dataset.key = ''
  }

  function nowLine(a, wall) {
    if (a.shown === 'running' && wall - a.lastAt > STALL_MS) return { icon: 'clock', head: `Quiet for ${ago(wall - a.lastAt)}`, sub: 'One long request, most likely: thinking, not stuck.' }
    if (a.shown === 'running') return a.tool ? { icon: iconFor(a.tool), head: a.tool.replace(/^mcp__/, ''), sub: a.what ?? '', isCode: true } : { icon: 'think', head: 'Thinking', sub: 'Between tool calls: the model is writing.' }
    const kids = view?.agents.filter(k => k.parentId === a.id && isActive(k) && !k.isBackground) ?? []
    if (a.shown === 'waiting') return { icon: 'wait', head: `Waiting on ${kids.length || 'a'} helper${kids.length === 1 ? '' : 's'}`, sub: kids.map(nameOf).join(', ') }
    if (a.shown === 'done') return { icon: 'done', head: 'Done', sub: 'Its report is handed in.' }
    if (a.shown === 'failed') return { icon: 'fail', head: 'Failed', sub: 'It handed in what it had.' }
    if (a.shown === 'stopped') return { icon: 'stop', head: 'Stopped', sub: '' }
    return { icon: 'coffee', head: 'Idle', sub: a.id === 'main' ? 'Waiting for your next prompt.' : '' }
  }

  function renderPanel() {
    const actor = pinned ? actors.get(pinned) : null
    if (!actor) {
      if (!panel.hidden) follow(null)
      return
    }
    const a = actor.agent
    const wall = Date.now()
    const parent = a.parentId && !a.isOrphan ? view?.agents.find(p => p.id === a.parentId) : null
    const kids = view?.agents.filter(k => k.parentId === a.id) ?? []
    const now = nowLine(a, wall)
    const away = actor.legs[0]?.kind
    const steps = (a.recent ?? []).slice().reverse()
    const data = {
      name: a.id === 'main' ? 'Boss' : nameOf(a),
      type: a.id === 'main' ? 'main session' : a.type,
      shown: a.shown,
      model: a.model ?? '—',
      since: [a.startedAt, a.endedAt],
      now,
      away: away === 'coffee' ? 'at the coffee corner' : away === 'chat' ? 'talking to a colleague' : away === 'stroll' ? 'stretching their legs' : away === 'brief' ? 'taking the brief' : away === 'report' ? 'handing in the report' : '',
      task: a.id === 'main' ? '' : a.label,
      steps: steps.map(st => [st.tool, st.what ?? '', st.at]),
      parent: parent ? [parent.id, nameOf(parent), parent.shown] : a.isOrphan ? ['', 'not seen', ''] : null,
      kids: kids.map(k => [k.id, nameOf(k), k.shown]),
      cost: [fmt(a.tokens.input), fmt(a.tokens.output), fmt(a.tokens.cacheRead), fmt(a.tokens.cacheWrite), fmt(a.weight), String(a.toolCalls)],
      room: plan.seats.get(a.id)?.room.name ?? '—',
    }
    // Rebuilt only when what it says changes, never just because a second passed, so a
    // click inside it is never lost to a rebuild. The times tick in place.
    const key = JSON.stringify(data)
    if (panel.dataset.key !== key) {
      panel.dataset.key = key
      buildPanel(data)
    }
    for (const n of panelBody.querySelectorAll('[data-at]')) {
      const text = n.dataset.end ? ago(Number(n.dataset.end) - Number(n.dataset.at)) : `${ago(wall - Number(n.dataset.at))}${n.dataset.suffix ?? ''}`
      if (n.textContent !== text) n.textContent = text
    }
  }

  const ticking = (cls, at, end, suffix) => {
    const n = h('span', cls)
    n.dataset.at = String(at)
    if (end) n.dataset.end = String(end)
    if (suffix) n.dataset.suffix = suffix
    return n
  }

  function buildPanel(data) {
    const now = data.now

    // textContent only, all of it: tasks and commands come from the session.
    const sect = (title, ...kids2) => {
      const s2 = h('section', 'p-sec')
      s2.append(h('h3', '', title), ...kids2)
      return s2
    }
    const person = ([id, name, shown]) => {
      const b = h('button', `p-person ${shown}`)
      b.type = 'button'
      if (id) b.dataset.id = id
      else b.disabled = true
      b.append(h('span', 'dot'), h('span', 'nm', name), h('span', 'st', shown))
      return b
    }
    const head = h('header', 'p-head')
    const title = h('div', 'p-title')
    title.append(h('h2', '', data.name), h('div', 'p-sub', `${data.type} · ${data.model} · ${data.room}`))
    const close = h('button', 'p-close')
    close.type = 'button'
    close.dataset.close = '1'
    close.setAttribute('aria-label', 'Close the panel')
    close.append(icon('fail'))
    head.append(title, close)

    const pill = h('div', `p-pill ${data.shown}`)
    pill.append(h('span', 'dot'), `${data.shown} · `, ticking('', data.since[0], data.since[1]))
    const nowBox = h('div', `p-now ${data.shown}`)
    const nowHead = h('div', 'p-now-head')
    nowHead.append(icon(now.icon), now.head)
    nowBox.append(nowHead)
    if (now.sub) nowBox.append(h('div', now.isCode ? 'p-now-sub code' : 'p-now-sub', now.sub))
    if (data.away) nowBox.append(h('div', 'p-away', `Away from the desk: ${data.away}`))

    const parts = [head, pill, sect('Now', nowBox)]
    if (data.task) parts.push(sect('Task', h('p', 'p-task', data.task)))
    const list = h('ol', 'p-steps')
    for (const [tool, what, when] of data.steps) {
      const li = h('li', '')
      const top = h('div', 'p-step-top')
      top.append(icon(iconFor(tool)), h('b', '', tool.replace(/^mcp__/, '')), ticking('when', when, null, ' ago'))
      li.append(top)
      if (what) li.append(h('code', '', what))
      list.append(li)
    }
    parts.push(sect('Recent tool calls', data.steps.length ? list : h('p', 'p-none', 'None yet.')))
    const team = h('div', 'p-team')
    if (data.parent) team.append(h('div', 'p-k', 'Reports to'), person(data.parent))
    if (data.kids.length) team.append(h('div', 'p-k', `Its helpers (${data.kids.length})`), ...data.kids.map(person))
    if (data.parent || data.kids.length) parts.push(sect('Team', team))
    const grid = h('dl', 'p-cost')
    for (const [k, v] of [['input', data.cost[0]], ['output', data.cost[1]], ['cache read', data.cost[2]], ['cache written', data.cost[3]], ['weighted', data.cost[4]], ['tool calls', data.cost[5]]]) {
      grid.append(h('dt', '', k), h('dd', '', v))
    }
    parts.push(sect('Cost', grid))
    panelBody.replaceChildren(...parts)
  }

  // One listener for the panel: its content is rebuilt as the agent changes.
  panel.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) return follow(null)
    const to = e.target.closest('[data-id]')
    if (to) follow(to.dataset.id)
  })

  // The agent under the pointer: of the boxes it is in, the one whose centre is nearest.
  function hitAt(x, y) {
    let best = null
    let bestD = Infinity
    for (const b of boxes) {
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue
      const d = Math.hypot(x - (b.x + b.w / 2), y - (b.y + b.h / 2))
      if (d < bestD) {
        bestD = d
        best = b.id
      }
    }
    return best
  }

  canvas.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, yaw, moved: false }
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.clientX - drag.x
      if (Math.abs(dx) > 3) drag.moved = true
      if (drag.moved) {
        canvas.classList.add('dragging')
        yaw = drag.yaw - dx * 0.008
        return
      }
    }
    pointer = [e.clientX, e.clientY]
    hovered = hitAt(...pointer)
  })
  canvas.addEventListener('pointerup', e => {
    const wasDrag = drag?.moved
    drag = null
    canvas.classList.remove('dragging')
    if (wasDrag) return
    const id = hitAt(e.clientX, e.clientY)
    follow(id && id !== pinned ? id : null)
  })
  canvas.addEventListener('pointerleave', () => {
    if (drag) return
    pointer = null
    hovered = null
  })
  canvas.addEventListener(
    'wheel',
    e => {
      e.preventDefault()
      zoom = Math.max(0.6, Math.min(3, zoom * Math.exp(-e.deltaY * 0.0015)))
    },
    { passive: false },
  )
  canvas.addEventListener('dblclick', () => {
    yaw = Math.PI / 4
    zoom = 1
  })
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      follow(null)
      hovered = null
    }
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
  requestAnimationFrame(frame)

  // What the page holds, for tests and for anyone embedding it. Read-only.
  window.__BASIVO_WORLD_INSPECT__ = () => ({
    mode,
    actors: [...actors.values()].map(a => ({ id: a.agent.id, shown: a.agent.shown, depth: a.agent.depth })),
    // Each agent's box on screen, person and desk together, in CSS pixels.
    boxes: boxes.map(b => ({ ...b })),
    // Who is away from their desk, and why: brief, in, report or home.
    trips: [...actors.values()].filter(a => a.legs.length).map(a => ({ id: a.agent.id, kind: a.legs[0].kind, to: a.agent.parentId })),
    rooms: plan.rooms.filter(r => r.kind !== 'boss').map(r => ({ id: r.id, title: r.name, desks: r.members.length })),
    inbox: inboxCount.get('main') ?? 0,
    // Whom the detail panel follows, if anyone.
    panel: panel.hidden ? null : pinned,
    theme: pal.isDark ? 'dark' : 'light',
    gl: Boolean(renderer),
    stats: hud.stats.dataset.text ?? '',
    status: hud.status.textContent,
  })
})()
