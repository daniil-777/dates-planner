/*
 * Mood — a glance, not a survey.
 *
 * Two ways in, one table out:
 *
 *  - **Tap it in.** Five faces, an optional sentence, save. The level is the whole scale
 *    (1 rough … 5 great), because anything finer turns a two-second check-in into a form.
 *  - **Let the camera guess.** A selfie goes to `detectMood`, which answers with a
 *    *suggestion* — level, a word for it, the model's own confidence, one warm sentence.
 *    Nothing is saved until the person agrees; the suggestion pre-selects the face and can
 *    be overruled with one tap, because the human is the authority on their own mood and
 *    the model is a mirror, not a judge.
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
import { MoodAurora } from './mood/MoodAurora'
import { MoodRibbon } from './mood/MoodRibbon'
import { ApiError } from '@/api/client'
import './mood/mood.css'

/** The scale. Index = level - 1. Faces, because that is how the question is asked. */
const LEVELS = [
  { level: 1, face: '😞', word: 'Rough' },
  { level: 2, face: '😕', word: 'Low' },
  { level: 3, face: '😐', word: 'Okay' },
  { level: 4, face: '🙂', word: 'Good' },
  { level: 5, face: '😄', word: 'Great' },
] as const

const NOTE_LIMIT = 280

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

  const [level, setLevel] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [suggestion, setSuggestion] = useState<MoodSuggestion | null>(null)
  const [scanProblem, setScanProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  /*
   * A level being considered but not chosen.
   *
   * The aurora previews it, so you can see what "Good" looks like before committing to
   * having had one. It is the one thing this does that a decorative field cannot, and it
   * turns a five-way radio group into something worth touching.
   */
  const [hovered, setHovered] = useState<number | null>(null)

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
    (chosen: number, source: 'manual' | 'face') => {
      const fromScan = source === 'face' && suggestion !== null
      createMood.mutate(
        {
          personId: person?.ID ?? null,
          level: chosen,
          note: note.trim() === '' ? null : note.trim().slice(0, NOTE_LIMIT),
          source,
          detected: fromScan ? suggestion.label : null,
          confidence: fromScan ? suggestion.confidence : null,
        },
        {
          onSuccess: () => {
            setLevel(null)
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
          setLevel(reading.level)
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
    [detect],
  )

  return (
    <div className="mood-page">
      <Title level="H2">{t('mood.title', 'Mood')}</Title>
      <Text className="mood-hint">
        {person === null
          ? t('mood.hint.today', 'How is today going? Tap a face — or let the camera have a guess.')
          : t(
              'mood.hint.named',
              'How is {name} doing? Tap a face — or let the camera have a guess.',
              {
                name: person.name,
              },
            )}
      </Text>

      {/* ------------------------------------------------ the picker */}
      <section className="mood-panel" aria-label="How are you feeling?">
        <MoodAurora level={level} preview={hovered}>
          <p className="aurora__prompt">{t('mood.prompt', 'How is it, right now?')}</p>
          <div className="mood-scale" role="radiogroup" aria-label="Mood level">
            {LEVELS.map(entry => (
              <button
                key={entry.level}
                type="button"
                role="radio"
                aria-checked={level === entry.level}
                className={
                  level === entry.level
                    ? 'mood-scale__face mood-scale__face--active'
                    : 'mood-scale__face'
                }
                onPointerEnter={() => setHovered(entry.level)}
                onPointerLeave={() => setHovered(null)}
                onFocus={() => setHovered(entry.level)}
                onBlur={() => setHovered(null)}
                onClick={() => setLevel(entry.level)}
              >
                <span className="mood-scale__emoji" aria-hidden="true">
                  {entry.face}
                </span>
                <span className="mood-scale__word">
                  {t(`mood.level.${entry.level}`, entry.word)}
                </span>
              </button>
            ))}
          </div>

          <div className="aurora__glass">
            {suggestion === null ? null : (
              <MessageStrip design="Information" hideCloseButton className="mood-suggestion">
                {suggestion.observation} — reads as <b>{suggestion.label}</b>
                {` (${Math.round(suggestion.confidence * 100)}% sure). `}
                Adjust the face above if it got you wrong; you are the authority here.
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

            <div className="aurora__actions">
              <Button
                design="Emphasized"
                disabled={level === null || createMood.isPending}
                onClick={() =>
                  level !== null && save(level, suggestion === null ? 'manual' : 'face')
                }
              >
                {createMood.isPending ? t('mood.saving', 'Saving…') : t('mood.save', 'Save mood')}
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
        </MoodAurora>

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
