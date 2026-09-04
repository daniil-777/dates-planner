/**
 * Touch maps — CONTRACTS.md §13.
 *
 * Everyone in the household gets a tab; yours is editable and theirs is not. The page owns
 * the loading and the writes, and `TouchMapCard` owns the drawing, which keeps the one
 * component that pulls in three.js free of data-fetching concerns.
 *
 * ## Your map is created when you first mark something
 *
 * Not on first visit. Opening a page should not write a row, and a household where
 * everybody has an empty map is indistinguishable from one where nobody has looked —
 * which matters here, because "they have not filled this in" is something a partner can
 * see. So the map row appears with the first mark, and `ensureMap` is what threads that
 * through the first save.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BusyIndicator, MessageStrip } from '@ui5/webcomponents-react'

import { usePeople } from '@/api/hooks'
import { session, type Session } from '@/api/auth'
import { HintLamp } from '@/components/HintLamp'
import { TouchMapCard } from './intimacy/TouchMapCard'
import {
  addMark,
  clearMark,
  createTouchMap,
  listTouchMaps,
  setForm,
  setMarkLevel,
  type TouchMap,
} from './intimacy/api'
import type { BodyForm, Level, ZoneCode } from './intimacy/zones'
import './intimacy/intimacy.css'

export function IntimacyPage() {
  const people = usePeople()
  const [me, setMe] = useState<Session | null>(null)
  const [maps, setMaps] = useState<TouchMap[] | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void Promise.all([session(), listTouchMaps()])
      .then(([who, loaded]) => {
        if (!live) return
        setMe(who)
        setMaps(loaded)
        setViewing(current => current ?? who.personId)
      })
      .catch((cause: unknown) => {
        if (live) setProblem(cause instanceof Error ? cause.message : 'This could not be loaded.')
      })
    return () => {
      live = false
    }
  }, [])

  const roster = useMemo(() => people.data ?? [], [people.data])
  const mine = me?.personId ?? null
  const shown = viewing ?? mine
  const map = maps?.find(row => row.personId === shown) ?? null
  const editable = shown !== null && shown === mine

  /**
   * The caller's map as the server currently has it, created if this is their first mark.
   *
   * It re-reads rather than trusting `maps`, and that is the whole point. A save is queued
   * as a closure at the moment of the tap, so it carries the state from *that* render — by
   * the time it runs, an earlier save in the queue may have added the very row it is about
   * to decide does not exist. Reading here costs one small request per save and means the
   * decision is made against what is actually stored.
   */
  const ensureMap = useCallback(async (): Promise<TouchMap> => {
    if (mine === null) throw new Error('There is no roster row for this session yet.')
    const current = await listTouchMaps()
    setMaps(current)
    const existing = current.find(row => row.personId === mine)
    if (existing !== undefined) return existing
    const created = await createTouchMap(mine, 'neutral')
    setMaps([...current, created])
    return created
  }, [mine])

  /**
   * Saves run one at a time, in the order they were asked for.
   *
   * Each one decides what to write by looking at the marks it can see, so two overlapping
   * saves can both read the state from before either of them — and two taps on the same
   * region then both conclude it is unmarked and insert a row. Chaining onto the previous
   * save costs nothing at this scale (a tap is not a hot loop) and removes the whole class
   * of problem rather than narrowing the window. The server refuses a duplicate region
   * independently, which is what covers the same two taps arriving from two devices.
   */
  const queue = useRef<Promise<void>>(Promise.resolve())

  const guard = useCallback((work: () => Promise<void>): Promise<void> => {
    const next = queue.current.then(async () => {
      setBusy(true)
      setProblem(null)
      try {
        await work()
      } catch (cause) {
        setProblem(cause instanceof Error ? cause.message : 'That could not be saved.')
      } finally {
        setBusy(false)
      }
    })
    // The chain must not be broken by a rejection, and `work`'s errors are already
    // handled above; this only guards against a throw from the bookkeeping itself.
    queue.current = next.catch(() => undefined)
    return next
  }, [])

  const onSetLevel = useCallback(
    (zone: ZoneCode, level: Level | null) =>
      void guard(async () => {
        // `target` is freshly read, so `existing` reflects what is stored right now
        // rather than what was on screen when the tap happened.
        const target = await ensureMap()
        const existing = target.marks.find(mark => mark.zone === zone)

        if (level === null) {
          if (existing === undefined) return
          await clearMark(existing.id)
        } else if (existing === undefined) {
          await addMark(target.id, zone, level)
        } else {
          await setMarkLevel(existing.id, level)
        }

        // Re-read rather than patch in place: the row ids come from the server, and a
        // household where both people are marking at once should converge on what is
        // actually stored rather than on whichever client rendered last.
        setMaps(await listTouchMaps())
      }),
    [ensureMap, guard],
  )

  const onChangeForm = useCallback(
    (form: BodyForm) =>
      void guard(async () => {
        const target = await ensureMap()
        await setForm(target.id, form)
        setMaps(current =>
          (current ?? []).map(row => (row.id === target.id ? { ...row, form } : row)),
        )
      }),
    [ensureMap, guard],
  )

  if (problem !== null && maps === null) {
    return (
      <div className="intimacy">
        <MessageStrip design="Negative" hideCloseButton>
          {problem}
        </MessageStrip>
      </div>
    )
  }

  if (maps === null || people.isPending) {
    return (
      <div className="intimacy intimacy--loading">
        <BusyIndicator active delay={0} />
      </div>
    )
  }

  return (
    <div className="intimacy">
      <header className="intimacy__head">
        <h1 className="intimacy__title">Between us</h1>
        {/*
          The whole answer to "what is this and who sees it", above every control.

          It used to say only that "the people in this household can see it" — immediately
          followed by five name chips, so the first thing a newcomer learned about the most
          private screen in the app was that four other people have tabs on it. The half that
          reassures ("never sent to a language model") was the last element on the page,
          roughly two thousand pixels down, under nineteen rows of unanswered questions.
        */}
        <p className="intimacy__sub">
          Colour in where you like being touched, and where you would rather not. Only this
          household can open it — never a machine, never a notification.
        </p>

        {/*
          The second layer, and only the second layer. What a screen asks you to do belongs on
          the screen; the lamp holds what people wonder — see HintLamp's own header for why
          that split is the rule rather than a preference.
        */}
        <HintLamp
          id="intimacy"
          label="What people ask"
          hints={[
            'Only you can change your own. Everyone here can see everyone’s, which is the point of it.',
            'Nothing is ever sent to a language model, and none of it appears in a statement, a memory or a notification.',
            'The figure is a drawing, not a likeness. Pick whichever shape is easiest to point at — it changes the picture and nothing else.',
            'There is no finishing this. Mark one thing or twenty, and change any of it whenever you like.',
          ]}
        />
      </header>

      {problem !== null && (
        <MessageStrip design="Negative" hideCloseButton>
          {problem}
        </MessageStrip>
      )}

      {roster.length > 1 && (
        <nav className="intimacy__people" aria-label="Whose map">
          {roster.map(person => (
            <button
              key={person.ID}
              type="button"
              className="intimacy__person"
              aria-pressed={person.ID === shown}
              onClick={() => setViewing(person.ID)}
            >
              <span
                className="intimacy__dot"
                style={{ background: person.colour }}
                aria-hidden="true"
              />
              {person.ID === mine ? 'You' : person.name}
            </button>
          ))}
        </nav>
      )}

      <TouchMapCard
        personName={
          shown === mine ? 'You' : (roster.find(person => person.ID === shown)?.name ?? 'They')
        }
        form={map?.form ?? 'neutral'}
        marks={map?.marks ?? []}
        editable={editable}
        busy={busy}
        onChangeForm={onChangeForm}
        onSetLevel={onSetLevel}
      />

      {/* The reassurance has moved up into the lede and the lamp, where it is read before
          anybody decides whether to start rather than after they have finished. */}
    </div>
  )
}

export default IntimacyPage
