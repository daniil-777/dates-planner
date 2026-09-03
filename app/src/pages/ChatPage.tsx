/**
 * The household's thread — CONTRACTS section 12.3, FRONTEND-CONTRACT section 10.
 *
 * One conversation per household, text and voice, arriving without a refresh.
 *
 * ## How it stays live
 *
 * An `EventSource` on `/api/chat/stream` says *that* something arrived; this then fetches
 * everything after the newest message it already holds. The stream never carries text, so a
 * replayed or out-of-order event costs one redundant request and can never put a wrong
 * message on screen. When the stream is unavailable — an old browser, a proxy that will not
 * pass `text/event-stream` — a fifteen-second poll runs the same fetch, so the page has one
 * code path and merely a slower clock.
 *
 * ## Voice
 *
 * Press and hold the microphone. The waveform is captured while recording and travels with
 * the message, so a bubble draws its shape the moment it appears and only fetches audio
 * when somebody presses play. One `<audio>` element is shared, so two notes can never play
 * over each other.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { PersonAvatar } from '@/components/PersonAvatar'
import { formatDate } from '@/theme'
import {
  conversation as fetchConversation,
  listen,
  mediaUrl,
  messages as fetchMessages,
  sendText,
  sendVoice,
  type ChatMessage,
  type Conversation,
} from './chat/api'
import { useVoiceRecorder } from './chat/useVoiceRecorder'
import './chat/chat.css'

/** How often to refetch when the live stream is not available. */
const POLL_MS = 15_000

export function ChatPage() {
  const [thread, setThread] = useState<Conversation | null>(null)
  const [items, setItems] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [live, setLive] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)

  const recorder = useVoiceRecorder()
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Read inside callbacks that must not be rebuilt every time a message arrives.
  const itemsRef = useRef<ChatMessage[]>([])
  itemsRef.current = items

  /** Everything newer than what is already held, merged by id. */
  const refresh = useCallback(async (conversationId: string): Promise<void> => {
    const newest = itemsRef.current.at(-1)?.at
    const fetched = await fetchMessages(conversationId, newest)
    if (fetched.length === 0) return
    setItems(current => {
      const seen = new Set(current.map(message => message.ID))
      const added = fetched.filter(message => !seen.has(message.ID))
      return added.length === 0 ? current : [...current, ...added]
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let stopListening: (() => void) | null = null
    let poll: number | null = null

    void (async () => {
      try {
        const found = await fetchConversation()
        if (cancelled) return
        setThread(found)
        setItems(await fetchMessages(found.ID))
        if (cancelled) return
        setLoading(false)

        stopListening = listen(() => void refresh(found.ID).catch(() => {}), setLive)
        // The poll runs regardless and is the fallback: when the stream is live it finds
        // nothing new and costs one cheap request a quarter-minute.
        poll = window.setInterval(() => void refresh(found.ID).catch(() => {}), POLL_MS)
      } catch (cause) {
        if (!cancelled) {
          setError(cause)
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      stopListening?.()
      if (poll !== null) window.clearInterval(poll)
    }
  }, [refresh])

  // Follow the conversation down as it grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: items.length > 0 ? 'smooth' : 'auto' })
  }, [items.length])

  const grouped = useMemo(() => groupByDay(items), [items])

  async function submitText(): Promise<void> {
    const body = draft.trim()
    if (body === '' || thread === null || sending) return
    setSending(true)
    setDraft('')
    try {
      const sent = await sendText(thread.ID, body)
      setItems(current =>
        current.some(message => message.ID === sent.ID) ? current : [...current, sent],
      )
    } catch (cause) {
      // Put the words back rather than losing them.
      setDraft(body)
      setError(cause)
    } finally {
      setSending(false)
    }
  }

  async function finishRecording(): Promise<void> {
    const recording = await recorder.stop()
    if (recording === null || thread === null) return
    setSending(true)
    try {
      const sent = await sendVoice(thread.ID, recording)
      setItems(current =>
        current.some(message => message.ID === sent.ID) ? current : [...current, sent],
      )
    } catch (cause) {
      setError(cause)
    } finally {
      setSending(false)
    }
  }

  function play(message: ChatMessage): void {
    const audio = audioRef.current
    if (audio === null) return
    if (playing === message.ID) {
      audio.pause()
      setPlaying(null)
      return
    }
    audio.src = mediaUrl(message.ID)
    audio.play().then(
      () => setPlaying(message.ID),
      () => setPlaying(null),
    )
  }

  if (loading) return <LoadingSkeleton rows={5} />
  if (error !== null && items.length === 0) {
    return <ErrorState error={error} onRetry={() => window.location.reload()} />
  }

  return (
    <div className="chat">
      <header className="chat__head">
        <div>
          <h1 className="chat__title">{thread?.title ?? 'Us'}</h1>
          <p className="chat__sub">
            <span className={`chat__dot${live ? ' chat__dot--live' : ''}`} aria-hidden="true" />
            {live ? 'Live' : 'Checking every 15 seconds'}
          </p>
        </div>
      </header>

      <div className="chat__thread" role="log" aria-live="polite" aria-label="Messages">
        {items.length === 0 ? (
          <EmptyState
            icon="discussion"
            title="Nothing said yet"
            description="Ask about Thursday. Or send a voice note — hold the microphone."
          />
        ) : (
          grouped.map(day => (
            <section key={day.key} className="chat__day">
              <p className="chat__daymark">
                <span>{day.label}</span>
              </p>
              {day.messages.map(message => (
                <Bubble
                  key={message.ID}
                  message={message}
                  playing={playing === message.ID}
                  onPlay={() => play(message)}
                />
              ))}
            </section>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* One player for the whole thread: two notes can never talk over each other. */}
      <audio ref={audioRef} onEnded={() => setPlaying(null)} hidden />

      <form
        className="chat__composer"
        onSubmit={event => {
          event.preventDefault()
          void submitText()
        }}
      >
        {recorder.state === 'recording' ? (
          <RecordingBar
            elapsedMs={recorder.elapsedMs}
            peaks={recorder.peaks}
            onCancel={recorder.cancel}
            onSend={() => void finishRecording()}
          />
        ) : (
          <>
            <label className="chat__srOnly" htmlFor="chat-draft">
              Message
            </label>
            <input
              id="chat-draft"
              className="chat__input"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder="Say something"
              enterKeyHint="send"
              autoComplete="off"
            />
            {draft.trim() === '' && recorder.state !== 'unsupported' ? (
              <button
                type="button"
                className="chat__mic"
                onPointerDown={() => void recorder.start()}
                aria-label="Hold to record a voice message"
                title="Hold to record"
              >
                <MicIcon />
              </button>
            ) : (
              <button
                type="submit"
                className="chat__send"
                disabled={draft.trim() === '' || sending}
                aria-label="Send"
              >
                <SendIcon />
              </button>
            )}
          </>
        )}
      </form>

      {recorder.error !== null && (
        <p className="chat__hint" role="status">
          {recorder.error}
        </p>
      )}
    </div>
  )
}

function Bubble({
  message,
  playing,
  onPlay,
}: {
  message: ChatMessage
  playing: boolean
  onPlay(): void
}) {
  const time =
    message.at === ''
      ? ''
      : new Date(message.at).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })

  return (
    <article className={`chat__row${message.mine ? ' chat__row--mine' : ''}`}>
      {!message.mine && (
        <PersonAvatar
          person={{
            ID: message.authorId ?? 'unknown',
            name: message.authorName,
            colour: message.authorColour,
            isDefault: false,
          }}
          size="S"
        />
      )}
      <div className="chat__bubble">
        {!message.mine && <p className="chat__author">{message.authorName}</p>}

        {message.kind === 'audio' ? (
          <VoiceNote message={message} playing={playing} onPlay={onPlay} />
        ) : (
          <p className="chat__text">{message.body}</p>
        )}

        <time className="chat__time" dateTime={message.at}>
          {time}
        </time>
      </div>
    </article>
  )
}

/**
 * A voice note. The waveform is drawn from `peaks`, which arrived with the message, so the
 * bubble is complete before any audio is requested.
 */
function VoiceNote({
  message,
  playing,
  onPlay,
}: {
  message: ChatMessage
  playing: boolean
  onPlay(): void
}) {
  // A fixed number of bars regardless of length, so a 3-second note and a 90-second one
  // look like the same component.
  const bars = useMemo(() => resample(message.peaks ?? [], 32), [message.peaks])
  const seconds = Math.max(1, Math.round((message.durationMs ?? 0) / 1000))

  return (
    <div className="voice">
      <button
        type="button"
        className="voice__play"
        onClick={onPlay}
        aria-label={playing ? 'Pause' : `Play a ${seconds} second voice message`}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <span className="voice__wave" aria-hidden="true">
        {bars.map((peak, index) => (
          <span
            key={index}
            className="voice__bar"
            style={{ height: `${Math.max(12, Math.round(peak * 100))}%` }}
          />
        ))}
      </span>
      <span className="voice__len">{seconds}s</span>
    </div>
  )
}

function RecordingBar({
  elapsedMs,
  peaks,
  onCancel,
  onSend,
}: {
  elapsedMs: number
  peaks: number[]
  onCancel(): void
  onSend(): void
}) {
  const seconds = Math.floor(elapsedMs / 1000)
  const bars = resample(peaks, 24)
  return (
    <div className="chat__recording" role="status">
      <button type="button" className="chat__cancel" onClick={onCancel} aria-label="Cancel">
        <CloseIcon />
      </button>
      <span className="voice__wave voice__wave--live" aria-hidden="true">
        {bars.map((peak, index) => (
          <span
            key={index}
            className="voice__bar voice__bar--live"
            style={{ height: `${Math.max(10, Math.round(peak * 100))}%` }}
          />
        ))}
      </span>
      <span className="chat__timer">
        {String(Math.floor(seconds / 60)).padStart(1, '0')}:{String(seconds % 60).padStart(2, '0')}
      </span>
      <button type="button" className="chat__send" onClick={onSend} aria-label="Send voice message">
        <SendIcon />
      </button>
    </div>
  )
}

/** Squash or stretch a peak list to exactly `width` bars, so every waveform is one shape. */
function resample(peaks: number[], width: number): number[] {
  if (peaks.length === 0) return Array.from({ length: width }, () => 0.15)
  const out: number[] = []
  for (let index = 0; index < width; index += 1) {
    const from = Math.floor((index * peaks.length) / width)
    const to = Math.max(from + 1, Math.floor(((index + 1) * peaks.length) / width))
    let loudest = 0
    for (let at = from; at < to && at < peaks.length; at += 1) {
      if (peaks[at] > loudest) loudest = peaks[at]
    }
    out.push(loudest)
  }
  return out
}

interface Day {
  key: string
  label: string
  messages: ChatMessage[]
}

/** Split into days, so a thread read weeks later still says when things were said. */
function groupByDay(messages: ChatMessage[]): Day[] {
  const days: Day[] = []
  for (const message of messages) {
    const key = message.at.slice(0, 10)
    const last = days.at(-1)
    if (last?.key === key) last.messages.push(message)
    else days.push({ key, label: labelFor(key), messages: [message] })
  }
  return days
}

function labelFor(day: string): string {
  const today = new Date().toISOString().slice(0, 10)
  if (day === today) return 'Today'
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (day === yesterday) return 'Yesterday'
  return formatDate(day)
}

/* Inline so the thread needs no icon font and no registration side effects. */
const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
    <path d="M18 11a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.9V19H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.1A6 6 0 0 0 18 11Z" />
  </svg>
)
const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
    <path d="M3.4 20.4 21 12 3.4 3.6 3.39 10l12.6 2-12.6 2 .01 6.4Z" />
  </svg>
)
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
    <path d="M8 5v14l11-7L8 5Z" />
  </svg>
)
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
  </svg>
)
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
    <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z" />
  </svg>
)

export default ChatPage
