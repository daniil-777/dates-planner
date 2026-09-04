/*
 * Mood — a glance, not a survey.
 *
 * Two ways in, one table out:
 *
 *  - **Say it with the weather.** One slider, 0…100. The face above it morphs from
 *    miserable to delighted as the thumb travels, and the sky behind it goes from a
 *    thunderstorm to a clear noon. An optional sentence, then save.
 *  - **Let the camera guess.** A selfie goes to `detectMood`, which answers with a
 *    *suggestion* — level, a word for it, the model's own confidence, one warm sentence.
 *    Nothing is saved until the person agrees; the suggestion *glides the slider* to its
 *    reading rather than committing it, because the human is the authority on their own
 *    mood and the model is a mirror, not a judge.
 *
 * ## 0…100 in front of a 1…5 table
 *
 * `Moods.level` is still the five-point scale `db/schema.cds` pins with
 * `@assert.range: [1, 5]`, and the service still refuses anything else. The slider is not
 * a change to what is stored — it is resolution in the *gesture*. Dragging a face through
 * a hundred intermediate expressions says "this is a continuum and you are somewhere on
 * it" in a way five buttons cannot, and then it rounds, once, at the moment of saving.
 * `sky.ts` owns that mapping and the dial states the resolved level on screen, so nothing
 * about it is hidden. The ribbon, the history and every row already in the table are
 * untouched.
 *
 * The photograph is analysed and discarded — the server stores no image (`detectMood` in
 * `srv/ledger-service.ts` deliberately ends in no INSERT), and this page never puts it in
 * state that outlives the request. The saved row is four small fields.
 *
 * Without an LLM key the server answers 501 and this page simply keeps the manual picker —
 * the feature degrades to its honest half rather than to a canned "reading".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, MessageStrip, Text, Title } from '@ui5/webcomponents-react'
import { useCreateMood, useDetectMood, useMoods } from '@/api/hooks'
import type { Mood, MoodSuggestion } from '@/api/types'
import { useActivePerson } from '@/components/AppShell'
import { useI18n } from '@/i18n'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { attribute } from './mood/attribution'
import { MoodFace } from './mood/MoodFace'
import { MoodRibbon } from './mood/MoodRibbon'
import { MoodSky } from './mood/MoodSky'
import { MoodSlider } from './mood/MoodSlider'
import { levelForValue, valueForLevel, wordForValue } from './mood/sky'
import { ApiError } from '@/api/client'
import './mood/mood.css'
import './mood/sky.css'

/** The scale. Index = level - 1. Faces, because that is how the question is asked. */
const LEVELS = [
  { level: 1, face: '😞', word: 'Rough' },
  { level: 2, face: '😕', word: 'Low' },
  { level: 3, face: '😐', word: 'Okay' },
  { level: 4, face: '🙂', word: 'Good' },
  { level: 5, face: '😄', word: 'Great' },
] as const

const NOTE_LIMIT = 280

/**
 * Where the slider rests before anybody has answered.
 *
 * The midpoint, and deliberately so. Any other opening position is the app guessing at the
 * answer before it has been asked — a slider that starts sunny is a leading question, and
 * one that starts in the storm is worse. Nothing is saved from this position until the
 * person moves it, which `touched` below is what guards.
 */
const RESTING_VALUE = 50

/** How long a value the *app* set takes to arrive. A value the person set is immediate. */
const GLIDE_MS = 850

function faceFor(level: number): string {
  return LEVELS[Math.min(5, Math.max(1, level)) - 1].face
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function MoodPage(): ReactElement {
  const moods = useMoods()
  const createMood = useCreateMood()
  const detect = useDetectMood()
  const { person } = useActivePerson()
  const { t } = useI18n()

  /*
   * The slider's 0…100, and whether it means anything yet.
   *
   * Two pieces of state rather than one nullable number, because a slider has to be
   * *somewhere* — there is no position that renders "no answer". `touched` is what carries
   * the fact that nobody has said anything, and it is what the Save button is disabled on.
   */
  const [value, setValue] = useState(RESTING_VALUE)
  const [touched, setTouched] = useState(false)
  const [note, setNote] = useState('')
  const [suggestion, setSuggestion] = useState<MoodSuggestion | null>(null)
  const [scanProblem, setScanProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)

  /*
   * Moving the slider on somebody's behalf.
   *
   * When the camera reads a face it answers with a level, and dropping the thumb there
   * instantly would throw the weather from a storm to a noon in one frame — the most
   * expressive thing on this screen, spent. Gliding it takes most of a second and turns
   * the reading into the thing the person watches arrive, which is also the moment they
   * get to disagree with it.
   *
   * The frame loop is owned by a ref so that a second reading, or leaving the page,
   * cancels the first rather than letting two loops fight over one value.
   */
  const glideRef = useRef<number | null>(null)

  const glideTo = useCallback((target: number) => {
    if (glideRef.current !== null) cancelAnimationFrame(glideRef.current)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target)
      return
    }
    // Read the start from the setter rather than from `value`, so the callback does not
    // need `value` as a dependency and cannot capture a stale one mid-glide.
    let from = target
    setValue(current => {
      from = current
      return current
    })
    const started = performance.now()
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / GLIDE_MS)
      // Ease-out cubic: quick to leave, slow to settle, which is how weather arrives.
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(from + (target - from) * eased))
      if (t < 1) glideRef.current = requestAnimationFrame(step)
      else glideRef.current = null
    }
    glideRef.current = requestAnimationFrame(step)
  }, [])

  useEffect(
    () => () => {
      if (glideRef.current !== null) cancelAnimationFrame(glideRef.current)
    },
    [],
  )

  /** 501 means "no key configured" — a fact about the deployment, not about this photo. */
  const detectionUnavailable =
    detect.error instanceof ApiError && (detect.error as ApiError).status === 501

  const rows: Mood[] = useMemo(() => moods.data ?? [], [moods.data])

  // The "saved" banner shows for a moment and goes; the timer is owned by an effect so
  // that leaving the page mid-moment clears it instead of firing into an unmounted tree.
  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 2500)
    return () => window.clearTimeout(timer)
  }, [saved])

  const save = useCallback(
    (chosen: number) => {
      // Whose answer it was is decided by AGREEMENT, not by whether a scan happened — see
      // `attribution.ts` for the bug that forced the distinction out into its own module.
      const whose = attribute(suggestion, chosen)
      createMood.mutate(
        {
          personId: person?.ID ?? null,
          level: chosen,
          note: note.trim() === '' ? null : note.trim().slice(0, NOTE_LIMIT),
          ...whose,
        },
        {
          onSuccess: () => {
            setValue(RESTING_VALUE)
            setTouched(false)
            setNote('')
            setSuggestion(null)
            setSaved(true)
          },
        },
      )
    },
    [createMood, note, person, suggestion],
  )

  const onPhoto = useCallback(
    (files: FileList | null) => {
      const file = files?.[0]
      if (file === undefined) return
      setScanProblem(null)
      setSuggestion(null)
      detect.mutate(file, {
        onSuccess: reading => {
          setSuggestion(reading)
          // The camera's answer lands on the centre of that level's band, which is the
          // only position on a 0…100 control that means exactly the level it was given.
          glideTo(valueForLevel(reading.level))
          setTouched(true)
        },
        onError: cause => {
          setScanProblem(
            cause instanceof ApiError
              ? cause.message
              : 'The photo could not be analysed. Try again in better light.',
          )
        },
      })
      // The same file twice should trigger change twice.
      if (cameraRef.current !== null) cameraRef.current.value = ''
    },
    [detect, glideTo],
  )

  return (
    <div className="mood-page">
      <Title level="H2">{t('mood.title', 'Mood')}</Title>
      <Text className="mood-hint">
        {person === null
          ? t(
              'mood.hint.today',
              'How is today going? Move the slider — or let the camera have a guess.',
            )
          : t(
              'mood.hint.named',
              'How is {name} doing? Move the slider — or let the camera have a guess.',
              {
                name: person.name,
              },
            )}
      </Text>

      {/* ------------------------------------------------ the picker */}
      <section className="mood-panel" aria-label="How are you feeling?">
        <MoodSky value={value}>
          <p className="sky__prompt" id="mood-prompt">
            {t('mood.prompt', 'How is it, right now?')}
          </p>

          <MoodFace value={value} />

          <MoodSlider
            value={value}
            labelledBy="mood-prompt"
            onChange={next => {
              setValue(next)
              setTouched(true)
            }}
          />

          <div className="sky__panel">
            {suggestion === null ? null : (
              <MessageStrip design="Information" hideCloseButton className="mood-suggestion">
                {suggestion.observation} — reads as <b>{suggestion.label}</b>
                {` (${Math.round(suggestion.confidence * 100)}% sure). `}
                Move the slider if it got you wrong; you are the authority here.
              </MessageStrip>
            )}

            <textarea
              className="mood-note"
              placeholder={t(
                'mood.note.placeholder',
                'A sentence about it, if you want (optional)',
              )}
              maxLength={NOTE_LIMIT}
              value={note}
              onChange={event => setNote(event.target.value)}
              rows={2}
            />

            <div className="sky__actions">
              <Button
                design="Emphasized"
                disabled={!touched || createMood.isPending}
                onClick={() => touched && save(levelForValue(value))}
              >
                {createMood.isPending
                  ? t('mood.saving', 'Saving…')
                  : touched
                    ? t('mood.save.word', 'Save “{word}”', { word: wordForValue(value) })
                    : t('mood.save', 'Save mood')}
              </Button>

              {detectionUnavailable ? null : (
                <Button
                  design="Transparent"
                  icon="camera"
                  disabled={detect.isPending}
                  onClick={() => cameraRef.current?.click()}
                >
                  {detect.isPending
                    ? t('mood.scanning', 'Looking…')
                    : t('mood.scan', 'Scan my face')}
                </Button>
              )}
              <input
                ref={cameraRef}
                data-testid="mood-camera-input"
                type="file"
                accept="image/*"
                capture="user"
                hidden
                onChange={event => onPhoto(event.target.files)}
              />
            </div>
          </div>
        </MoodSky>

        {detectionUnavailable ? (
          <MessageStrip design="Information" hideCloseButton>
            {t(
              'mood.detection.off',
              'Face scanning is off — the server has no AI key configured. The picker above works without it.',
            )}
          </MessageStrip>
        ) : (
          <p className="mood-privacy">
            {t(
              'mood.privacy',
              'The photo is analysed and immediately discarded — it is never stored, only the reading is.',
            )}
          </p>
        )}

        {scanProblem === null ? null : (
          <MessageStrip design="Negative" hideCloseButton>
            {scanProblem}
          </MessageStrip>
        )}
        {saved ? (
          <MessageStrip design="Positive" hideCloseButton>
            {t('mood.saved', 'Saved. Come back whenever the weather changes.')}
          </MessageStrip>
        ) : null}
      </section>

      {/* ------------------------------------------------ the record */}
      <section className="mood-card" aria-label="Recent moods">
        <Title level="H4">{t('mood.lately', 'Lately')}</Title>
        {/* The shape first, the entries under it. Nobody wants "what did I put on Tuesday";
            they want to know whether this has been a bad fortnight, and a list is the worst
            possible way to see that. */}
        <MoodRibbon entries={rows.map(entry => ({ at: entry.at, level: entry.level }))} />
        {moods.isPending ? (
          <LoadingSkeleton rows={3} />
        ) : moods.isError ? (
          <ErrorState error={moods.error} onRetry={() => void moods.refetch()} />
        ) : rows.length === 0 ? (
          <Text className="mood-empty">
            {t(
              'mood.empty',
              'Nothing yet. The first entry takes about two seconds; the chart of your year takes three hundred of them.',
            )}
          </Text>
        ) : (
          <ul className="mood-list">
            {rows.map(entry => (
              <li key={entry.ID} className="mood-list__row">
                <span className="mood-list__emoji" aria-hidden="true">
                  {faceFor(entry.level)}
                </span>
                <span className="mood-list__body">
                  <span className="mood-list__when">{formatWhen(entry.at)}</span>
                  <span className="mood-list__text">
                    {entry.note ??
                      (entry.source === 'face' && entry.detected !== null
                        ? t('mood.camera.read', 'Camera read: {label}', { label: entry.detected })
                        : t(`mood.level.${entry.level}`, LEVELS[entry.level - 1]?.word ?? ''))}
                  </span>
                </span>
                {entry.source === 'face' ? (
                  <span className="mood-list__badge" title="Detected from a face scan">
                    AI
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default MoodPage
