// Pixel art for basivo-world: characters, tool icons, bubbles and cost blocks, drawn
// once into small offscreen canvases and cached. Every template is a grid of
// single-character cells; the legend maps a cell to a palette slot.
'use strict'

const Sprites = (() => {
  // 12 x 18. o outline, h hair or hat, s skin, e eye, c shirt, d shirt shade,
  // p trousers, f shoes, . empty.
  const HEADS = {
    hair: ['....oooo....', '...ohhhho...', '..ohhhhhho..', '..ohssssho..'],
    cap: ['...oooooo...', '..ohhhhhho..', '..ohhhhhhhoo', '..osssssso..'],
    beanie: ['.....oo.....', '...ohhhho...', '..ohhhhhho..', '..ohhhhhho..'],
  }
  const FACE = ['..osesseso..', '..osssssso..', '...oooooo...']
  const STAND_BODY = [
    '.occcccccco.',
    'osccccccccso',
    'osccddddccso',
    'osccccccccso',
    '.occcccccco.',
    '.oppppppppo.',
    '..oppppppo..',
    '..oppooppo..',
    '..opo..opo..',
    '..opo..opo..',
    '.ooff..ffoo.',
  ]
  const SIT_BODY = [
    '.occcccccco.',
    'osccccccccso',
    'osccddddccso',
    '.occcccccco.',
    'oppppppppppo',
    'offoppppoffo',
    '.oo......oo.',
  ]

  const W = 12
  const H = 18
  const BLANK = '.'.repeat(W)

  function template(head, pose) {
    const top = [...HEADS[head], ...FACE]
    if (pose === 'sit') return [BLANK, BLANK, BLANK, BLANK, ...top, ...SIT_BODY]
    return [...top, ...STAND_BODY]
  }

  // 7 x 7 icons. # ink, v violet, r red, . empty.
  const ICONS = {
    read: ['.###...', '#...#..', '#...#..', '#...#..', '.###...', '....##.', '.....##'],
    edit: ['.....##', '....###', '...###.', '..###..', '.###...', '##.....', '#......'],
    bash: ['.......', '#......', '.#.....', '..#....', '.#.....', '#..###.', '.......'],
    web: ['..###..', '.#.#.#.', '#..#..#', '#######', '#..#..#', '.#.#.#.', '..###..'],
    agent: ['.##....', '.##....', '..#....', '..####.', '.....##', '.....##', '.......'],
    plug: ['.#...#.', '.#...#.', '#######', '#######', '.#####.', '...#...', '...#...'],
    think: ['.......', '.......', '.......', '#.#.#..', '.......', '.......', '.......'],
    wait: ['#######', '.#vvv#.', '..#v#..', '...#...', '..#.#..', '.#...#.', '#######'],
    clock: ['..###..', '.#...#.', '#..#..#', '#..##.#', '#.....#', '.#...#.', '..###..'],
    fail: ['r.....r', '.r...r.', '..r.r..', '...r...', '..r.r..', '.r...r.', 'r.....r'],
    done: ['.......', '......v', '.....vv', 'v...vv.', 'vv.vv..', '.vvv...', '..v....'],
    stop: ['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......'],
    dots: ['.......', '.......', '.......', '#.#.#.#', '.......', '.......', '.......'],
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

  const SHIRTS = ['#c8b89a', '#8fa79a', '#b5838d', '#7d8fb3', '#c9a26b', '#9c8cb0', '#6f9fa8', '#b0896a']
  const HAIRS = ['#2a2733', '#5f4b3a', '#8a6a4a', '#c4b49a', '#1a1820', '#7a3e2e']
  const SKINS = ['#f1d3b3', '#e8c39e', '#d8a47f', '#a86b4a', '#6b4430']
  const HEAD_KINDS = ['hair', 'cap', 'beanie']

  function hash(text) {
    let h = 2166136261
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }

  function shade(hex, by) {
    const n = parseInt(hex.slice(1), 16)
    const f = c => Math.max(0, Math.min(255, Math.round(c * (1 - by))))
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`
  }

  // A role keeps one outfit, so every reviewer reads as a reviewer; the person in it
  // varies by id, so two reviewers are still two people.
  function lookOf(type, id, theme) {
    const t = hash(type)
    const p = hash(id)
    const isMain = type === 'main'
    const shirt = isMain ? theme.violet : SHIRTS[t % SHIRTS.length]
    return {
      head: isMain ? 'hair' : HEAD_KINDS[(t >>> 3) % HEAD_KINDS.length],
      colors: {
        // A rim, not an outline: lighter than the board so the figure separates from
        // it. A near-black edge on a dark ground is what made these read as mud.
        o: theme.rim,
        h: HAIRS[(t >>> 5) % HAIRS.length],
        s: SKINS[p % SKINS.length],
        e: theme.outline,
        c: shirt,
        d: shade(shirt, 0.18),
        p: theme.trousers,
        f: theme.outline,
      },
    }
  }

  const cache = new Map()

  function paint(grid, colors, faded) {
    const canvas = document.createElement('canvas')
    canvas.width = grid[0].length
    canvas.height = grid.length
    const g = canvas.getContext('2d')
    g.globalAlpha = faded ? 0.45 : 1
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        const color = colors[row[x]]
        if (!color) continue
        g.fillStyle = color
        g.fillRect(x, y, 1, 1)
      }
    })
    return canvas
  }

  function character(type, id, pose, isBlinking, isFaded, theme) {
    const key = `${type}|${id}|${pose}|${isBlinking}|${isFaded}|${theme.key}`
    let canvas = cache.get(key)
    if (!canvas) {
      const look = lookOf(type, id, theme)
      const colors = isBlinking ? { ...look.colors, e: look.colors.s } : look.colors
      canvas = paint(template(look.head, pose), colors, isFaded)
      cache.set(key, canvas)
    }
    return canvas
  }

  function icon(name, theme) {
    const key = `icon|${name}|${theme.key}`
    let canvas = cache.get(key)
    if (!canvas) {
      canvas = paint(ICONS[name], { '#': theme.outline, v: theme.violet, r: theme.fail }, false)
      cache.set(key, canvas)
    }
    return canvas
  }

  // A speech bubble 11 x 10 with a tail, the icon set in its middle.
  function bubble(name, theme) {
    const key = `bubble|${name}|${theme.key}`
    let canvas = cache.get(key)
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.width = 11
      canvas.height = 11
      const g = canvas.getContext('2d')
      g.fillStyle = theme.outline
      g.fillRect(1, 0, 9, 1)
      g.fillRect(1, 8, 9, 1)
      g.fillRect(0, 1, 1, 7)
      g.fillRect(10, 1, 1, 7)
      g.fillRect(4, 9, 2, 1)
      g.fillRect(4, 10, 1, 1)
      g.fillStyle = theme.bubble
      g.fillRect(1, 1, 9, 7)
      g.fillRect(4, 8, 1, 1)
      g.drawImage(icon(name, theme), 2, 1)
      cache.set(key, canvas)
    }
    return canvas
  }

  // One isometric block, 9 x 8: light top, two shaded sides.
  function block(theme, isLit) {
    const key = `block|${isLit}|${theme.key}`
    let canvas = cache.get(key)
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.width = 9
      canvas.height = 8
      const g = canvas.getContext('2d')
      const top = isLit ? theme.violetSoft : theme.blockTop
      const rows = [
        '....t....',
        '..ttttt..',
        'ttttttttt',
        'lltttttrr',
        'llllrrrrr',
        'llllrrrrr',
        '..llrrr..',
        '....r....',
      ]
      const colors = { t: top, l: theme.blockLeft, r: theme.blockRight }
      rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x += 1) {
          if (!colors[row[x]]) continue
          g.fillStyle = colors[row[x]]
          g.fillRect(x, y, 1, 1)
        }
      })
      cache.set(key, canvas)
    }
    return canvas
  }

  function clear() {
    cache.clear()
  }

  return { W, H, template, ICONS, HEADS, iconFor, character, icon, bubble, block, lookOf, hash, clear }
})()

if (typeof module !== 'undefined') module.exports = Sprites
