/**
 * The live half of chat: who is listening, and what they are told.
 *
 * ## Why server-sent events
 *
 * Delivery here is one-directional. A client never needs to push over the socket — sending
 * a message is an ordinary POST that already works, retries, and rides the outbox. What is
 * left is "something changed, come and look", which is exactly what SSE is: plain HTTP, no
 * upgrade to negotiate through helmet and the CSP, no second protocol to test, and a
 * browser that reconnects on its own. WebSockets would add all of that for no gain
 * (ADR-002 section 5).
 *
 * ## What travels
 *
 * Ids, never data. An event says which conversation changed and which message id appeared;
 * the client then asks for what it has not seen. That keeps the stream cheap, keeps
 * authorisation in one place — the ordinary group-scoped read — and means a replayed or
 * out-of-order event can only ever cause a redundant fetch, never a wrong row on screen.
 *
 * ## Where this stops working
 *
 * The subscriber map lives in this process. That is correct while Fly runs exactly one
 * machine (`min_machines_running = 1`, auto-stop off). The moment a second one exists,
 * this has to become Postgres `LISTEN/NOTIFY` or Redis — and that is the same trigger that
 * moves the database off SQLite, so the two migrations are one migration.
 */
import cds from '@sap/cds'

const LOG = cds.log('chat')

/** How often a comment is sent to keep proxies from closing an idle connection. */
const HEARTBEAT_MS = 25_000

/**
 * How many recent events to keep per household for replay.
 *
 * A browser reconnecting sends `Last-Event-ID`, and anything still in this window is
 * replayed rather than missed. Fifty is far more than a dropped tunnel loses and costs a
 * few kilobytes; beyond it the client refetches the thread, which is correct anyway.
 */
const REPLAY_DEPTH = 50

export interface ChatEvent {
  id: number
  conversationId: string
  messageId: string
}

/** One connected browser. */
interface Listener {
  groupId: string
  send(event: ChatEvent): void
}

const listeners = new Set<Listener>()
const recent = new Map<string, ChatEvent[]>()
let sequence = 0

/**
 * Tell everybody in a household that a message arrived.
 *
 * Never throws: a broken listener must not fail the POST that is delivering the message.
 * The message is already saved by the time this runs, so the worst case is a client that
 * finds out on its next poll or reconnect.
 */
export function publishChat(groupId: string, conversationId: string, messageId: string): void {
  if (groupId === '') return
  sequence += 1
  const event: ChatEvent = { id: sequence, conversationId, messageId }

  const history = recent.get(groupId) ?? []
  history.push(event)
  if (history.length > REPLAY_DEPTH) history.splice(0, history.length - REPLAY_DEPTH)
  recent.set(groupId, history)

  for (const listener of listeners) {
    if (listener.groupId !== groupId) continue
    try {
      listener.send(event)
    } catch (error) {
      LOG.warn('a chat listener could not be written to', describe(error))
    }
  }
}

/** Everything this household published after `afterId`, for a reconnecting browser. */
export function replayChat(groupId: string, afterId: number): ChatEvent[] {
  return (recent.get(groupId) ?? []).filter(event => event.id > afterId)
}

/** Register a listener. The returned function removes it and must be called on close. */
export function addChatListener(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** How many browsers are listening — surfaced by `/health` and useful when debugging. */
export function chatListenerCount(): number {
  return listeners.size
}

export const CHAT_HEARTBEAT_MS = HEARTBEAT_MS

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
