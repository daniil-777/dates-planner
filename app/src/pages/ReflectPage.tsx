/**
 * A place to write down what is on your mind, which writes something back.
 *
 * ## What this screen is, and the sentence it has to earn
 *
 * It is a private journal with a listener attached. It is not therapy, and the screen says
 * so before anybody types — not as small print at the bottom, but as the second line, where
 * it is read. An app that lets somebody discover *afterwards* what it was has taken
 * something from them.
 *
 * The other thing said up front is that the words go to a language model. Everywhere else in
 * this app that would be a promise broken (a touch map is never sent to one, CONTRACTS
 * §13.4); here it is the feature, and the only honest thing to do is say it in the same
 * breath as asking for the words.
 *
 * ## Why it looks like this
 *
 * The aurora is the same one behind the mood picker, and reusing it rather than building a
 * second is the point — this screen and that one are the two places in the app where
 * somebody says how they are, and they should feel like the same room. The field is set to a
 * fixed, slow, cool green: it does not react to what is typed, because a background that
 * brightened when you wrote something cheerful would be reading over your shoulder and
 * grading it.
 *
 * Dark, wide-set, generously spaced — closer to a text editor than to a form. A journal that
 * looks like a support ticket does not get written in.
 *
 * ## The one interaction detail that matters
 *
 * The entry stays on screen after it is answered, above the reply, rather than being cleared
 * into a list. What somebody wrote is the valuable half; the reply is a response *to* it and
 * is meaningless floating on its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { reflect, type Reflection } from '@/api/reflect'
import { MoodAurora } from './mood/MoodAurora'
import './mood/mood.css'
import './reflect/reflect.css'

/** The aurora level this screen sits at: cool, green, slow. Never varies. */
const CALM = 3

function when(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}

export function ReflectPage(): React.ReactElement {
  const [entry, setEntry] = useState('')
  const [busy, setBusy] = useState(false)
  const [current, setCurrent] = useState<Reflection | null>(null)
  const [past, setPast] = useState<Reflection[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [engine, setEngine] = useState<{ available: boolean; engine: string } | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void reflect
      .available()
      .then(setEngine)
      .catch(() => undefined)
    void reflect
      .mine(20)
      .then(setPast)
      .catch(() => undefined)
  }, [])

  // Grows with what is written, rather than scrolling inside a fixed box. A four-line window
  // makes long thoughts feel unwelcome, which is the opposite of what this is for.
  const grow = useCallback(() => {
    const node = box.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(420, node.scrollHeight)}px`
  }, [])

  const send = useCallback(async () => {
    const text = entry.trim()
    if (text === '' || busy) return

    setBusy(true)
    setProblem(null)
    try {
      const written = await reflect.write(text)
      setCurrent(written)
      setEntry('')
      setPast(before => [written, ...before])
      if (box.current !== null) box.current.style.height = 'auto'
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That could not be saved.')
    } finally {
      setBusy(false)
    }
  }, [entry, busy])

  const forget = useCallback(async (one: Reflection) => {
    if (!window.confirm('Delete this entry? It cannot be brought back.')) return
    await reflect.forget(one.ID)
    setPast(before => before.filter(other => other.ID !== one.ID))
    setCurrent(shown => (shown?.ID === one.ID ? null : shown))
  }, [])

  return (
    <MoodAurora level={CALM}>
      <section className="reflect">
        <header className="reflect__head">
          <h2 className="reflect__title">On your mind</h2>
          {/* Second line, not small print at the bottom. Somebody who finds out afterwards
              what this was has had something taken from them. */}
          <p className="reflect__lede">
            Write down whatever is there. Something reads it and writes back — a listener, not a
            therapist, and no substitute for one. Only you can see what you put here.
          </p>
        </header>

        {current === null ? (
          <div className="reflect__composer">
            <textarea
              ref={box}
              className="reflect__box"
              value={entry}
              placeholder="It has been one of those weeks…"
              maxLength={4000}
              rows={5}
              onChange={event => {
                setEntry(event.target.value)
                grow()
              }}
              aria-label="What is on your mind"
            />

            <div className="reflect__actions">
              <span className="reflect__count">
                {entry.length > 3600 ? `${4000 - entry.length} left` : ''}
              </span>
              <button
                type="button"
                className="reflect__send"
                onClick={() => void send()}
                disabled={entry.trim() === '' || busy}
              >
                {busy ? 'Reading…' : 'Write it down'}
              </button>
            </div>

            {/* Said plainly, and only when it is true. */}
            {engine !== null && !engine.available && (
              <p className="reflect__note">
                No language model is configured here, so nothing will write back today. What you
                write is still saved.
              </p>
            )}
            {engine !== null && engine.available && (
              <p className="reflect__note">
                What you write is sent to a language model to be read. Nothing else in this app is.
              </p>
            )}

            {problem !== null && (
              <p className="reflect__problem" role="alert">
                {problem}
              </p>
            )}
          </div>
        ) : (
          <div className="reflect__answered">
            {/* The entry stays, above the reply. What somebody wrote is the valuable half. */}
            <blockquote className="reflect__yours">{current.entry}</blockquote>

            <div className={`reflect__reply${current.concerned ? ' reflect__reply--help' : ''}`}>
              {current.reply.split('\n\n').map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}

              {current.helplines.length > 0 && (
                <ul className="helplines">
                  {current.helplines.map(line => (
                    <li key={line.name} className="helpline">
                      <span className="helpline__contact">{line.contact}</span>
                      <span className="helpline__body">
                        <span className="helpline__name">{line.name}</span>
                        <span className="helpline__detail">{line.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <button type="button" className="reflect__again" onClick={() => setCurrent(null)}>
              Write something else
            </button>
          </div>
        )}

        {past.length > 0 && (
          <section className="reflect__past">
            <h3 className="reflect__h3">Before</h3>
            <ul className="entries">
              {past.map(one => (
                <li key={one.ID} className="entry">
                  <button
                    type="button"
                    className="entry__open"
                    onClick={() => setCurrent(one)}
                    aria-label={`Open the entry from ${when(one.at)}`}
                  >
                    <span className="entry__when">{when(one.at)}</span>
                    {/* First line only. A list of full entries is a wall nobody rereads,
                        and the opening line is how people find the one they mean. */}
                    <span className="entry__peek">{one.entry.split('\n')[0]}</span>
                  </button>
                  <button
                    type="button"
                    className="entry__forget"
                    onClick={() => void forget(one)}
                    aria-label={`Delete the entry from ${when(one.at)}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </section>
    </MoodAurora>
  )
}
