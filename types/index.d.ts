// The contract for what basivo-world keeps in $.state. The world model's types live
// here, so the stored shape and the code that reads it can never disagree.

export type Status = 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'stopped'

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// One tool call, for the browser's detail panel: what it was, and on what.
export type Step = {
  tool: string
  what: string | null
  at: number
}

// One line of an agent's live activity, as Claude Code shows it: the prompt it was
// given, its thinking and its writing as they stream, and each tool call with its result.
export type FeedItem = {
  id: string
  kind: 'prompt' | 'thinking' | 'text' | 'tool'
  text: string
  tool?: string
  result?: string
  isError?: boolean
  at: number
  // Still streaming, or the tool still running.
  live: boolean
}

export type Agent = {
  id: string
  // null only for the main loop. A parent we never saw spawn keeps its id; the view
  // reports the agent as unattached rather than inventing an edge.
  parentId: string | null
  type: string
  label: string
  status: Status
  isBackground: boolean
  tool: string | null
  // What the running tool is working on: its command, file, pattern or URL, clipped.
  what: string | null
  // The last few tool calls, oldest first.
  recent: Step[]
  // The live activity, oldest first, capped (FEED in hooks/world.ts).
  feed: FeedItem[]
  toolCalls: number
  tokens: Tokens
  model: string | null
  startedAt: number
  lastAt: number
  endedAt: number | null
}

export type World = {
  startedAt: number
  updatedAt: number
  agents: Record<string, Agent>
  // Spawn order, so the layout never reshuffles as statuses change.
  order: string[]
  // Usage from loops no roster names — the engine's own forks, such as compaction.
  // Counted, never drawn as a character that does not exist.
  unattributed: Tokens
}

declare module 'claude-code' {
  interface PluginState {
    'basivo-world': {
      world: Shaped<World>
      // Where the browser view was published, once /world has run this session.
      browserDir: string | null
      isPaneOpened: boolean
    }
  }
}
