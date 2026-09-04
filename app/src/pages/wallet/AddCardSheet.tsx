/**
 * Adding a card.
 *
 * ## The flow has a gap in it, and the design is about the gap
 *
 * A card stored for later use must be authenticated by its owner *now*, while they are here
 * to approve it — that is what strong customer authentication means, and it is why the
 * charge next month is allowed to happen without them. So the browser leaves for the
 * issuer's own screen and comes back, and everything awkward about this component lives in
 * that gap: the person may refresh, background the tab, lose signal, or open a second one.
 *
 * All four land on the same card, because the server treats the setup reference as the lock
 * and returns the same answer to every asker. This component's job is only to keep asking
 * politely and to say something true while it waits — "your bank is checking" is a sentence
 * people will sit through; a spinner with no explanation is one they abandon.
 *
 * ## Why there is no card field on this screen
 *
 * There is not one anywhere in this app. With a real provider the fields are an iframe on
 * the provider's own origin, which our JavaScript cannot read into; in development there are
 * no fields at all, only scenario buttons. That second choice matters more than it looks: a
 * dev form that accepts `4242…` is a form somebody eventually types a real card into, and it
 * is usually the person doing a demo.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Label } from '@ui5/webcomponents-react'

import { wallet, type MockScenario, type SetupResult } from '@/api/wallet'
import { skinFor } from './CardFace'

/** How often to ask what became of a setup, while the issuer has the person. */
const POLL_MS = 900
/** Long enough for a slow bank app, short enough that a dead flow does not hang forever. */
const GIVE_UP_MS = 120_000

type Stage = 'naming' | 'collecting' | 'waiting' | 'done' | 'failed'

export interface AddCardSheetProps {
  scenarios: MockScenario[]
  onClose: () => void
  onAdded: (result: SetupResult) => void
}

export function AddCardSheet({
  scenarios,
  onClose,
  onAdded,
}: AddCardSheetProps): React.ReactElement {
  const [stage, setStage] = useState<Stage>('naming')
  const [label, setLabel] = useState('')
  const [ref, setRef] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const startedAt = useRef<number>(0)

  const mocking = scenarios.length > 0

  const begin = useCallback(async () => {
    setProblem(null)
    try {
      const setup = await wallet.startCardSetup(label.trim() === '' ? null : label.trim())
      setRef(setup.ref)
      setStage('collecting')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not start.')
      setStage('failed')
    }
  }, [label])

  const choose = useCallback(
    async (scenario: string) => {
      if (ref === null) return
      setStage('waiting')
      startedAt.current = Date.now()
      try {
        await wallet.chooseMockScenario(ref, scenario)
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'Could not continue.')
        setStage('failed')
      }
    },
    [ref],
  )

  // The poll. Deliberately here rather than in a query hook: it is a short-lived loop with a
  // deadline, and modelling it as cached server state would mean a stale answer could be
  // served to a flow that has moved on.
  useEffect(() => {
    if (stage !== 'waiting' || ref === null) return

    let live = true
    const tick = async (): Promise<void> => {
      if (!live) return
      try {
        const result = await wallet.finishCardSetup(ref)
        if (!live) return

        if (result.status === 'succeeded') {
          setStage('done')
          onAdded(result)
          return
        }
        if (result.status === 'declined') {
          setProblem(result.reason ?? 'That card was not saved.')
          setStage('failed')
          return
        }
        if (Date.now() - startedAt.current > GIVE_UP_MS) {
          setProblem('That took too long. Nothing was saved — please try again.')
          setStage('failed')
          return
        }
        window.setTimeout(() => void tick(), POLL_MS)
      } catch (error) {
        if (!live) return
        setProblem(error instanceof Error ? error.message : 'Lost contact with the card service.')
        setStage('failed')
      }
    }

    void tick()
    return () => {
      live = false
    }
  }, [stage, ref, onAdded])

  return (
    <div className="addcard" role="dialog" aria-modal="true" aria-label="Add a card">
      <div className="addcard__panel">
        <header className="addcard__head">
          <h2 className="addcard__title">Add a card</h2>
          <button type="button" className="addcard__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {stage === 'naming' && (
          <div className="addcard__body">
            <Label for="card-label">What shall we call it?</Label>
            <Input
              id="card-label"
              value={label}
              placeholder="the joint one"
              maxlength={60}
              onInput={event => setLabel((event.target as unknown as { value: string }).value)}
            />
            {/* Said plainly, because it is the single most reassuring true thing about this
                screen and people are right to want to know it. */}
            <p className="addcard__note">
              Your card number goes straight to our payment provider and never reaches this app. We
              only ever see the last four digits.
            </p>
            <Button design="Emphasized" onClick={() => void begin()}>
              Continue
            </Button>
          </div>
        )}

        {stage === 'collecting' && mocking && (
          <div className="addcard__body">
            {/* Impossible to miss on purpose. Somebody demoing this to a room must not be
                able to mistake it for the real form. */}
            <p className="addcard__testbanner">
              Test mode — no real card can be added here, and there is nowhere to type one.
            </p>
            <p className="addcard__note">Pick what you want to happen:</p>
            <ul className="addcard__scenarios">
              {scenarios.map(scenario => {
                const skin = skinFor(scenario.brand)
                return (
                  <li key={scenario.id}>
                    <button
                      type="button"
                      className="scenario"
                      onClick={() => void choose(scenario.id)}
                      style={
                        { '--card-from': skin.from, '--card-to': skin.to } as React.CSSProperties
                      }
                    >
                      <span className="scenario__swatch" aria-hidden="true" />
                      <span className="scenario__text">
                        <span className="scenario__label">{scenario.label}</span>
                        <span className="scenario__detail">{scenario.detail}</span>
                      </span>
                      <span className="scenario__last4" aria-hidden="true">
                        ···· {scenario.last4}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {stage === 'collecting' && !mocking && (
          <div className="addcard__body">
            {/* The real path mounts the provider's own element here. Kept explicit rather
                than pretending: a screen that silently does nothing is worse than one that
                says what is missing. */}
            <div id="payment-element" className="addcard__element" />
            <p className="addcard__note">
              This deployment uses a live card provider. The fields above belong to it — this app
              cannot read them.
            </p>
          </div>
        )}

        {stage === 'waiting' && (
          <div className="addcard__body addcard__body--waiting">
            <span className="addcard__spinner" aria-hidden="true" />
            {/* Names who is taking the time. People will wait for a bank; they will not wait
                for an unexplained spinner. */}
            <p className="addcard__waiting">Your bank is checking this card…</p>
            <p className="addcard__note">This is safe to leave open. Nothing is charged.</p>
          </div>
        )}

        {stage === 'failed' && (
          <div className="addcard__body">
            <p className="addcard__problem" role="alert">
              {problem}
            </p>
            <Button
              design="Emphasized"
              onClick={() => {
                setProblem(null)
                setStage('naming')
              }}
            >
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
