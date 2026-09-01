import { useRef, useState } from 'react'
import { Button, MessageStrip } from '@ui5/webcomponents-react'
import { toBlob } from 'html-to-image'
import type { Settlement } from '@/api/types'
import { formatDate, formatMoney, formatPeriod } from '@/theme'
import './icons'

export interface ClearingDocumentCardProps {
  settlement: Settlement
  currency: string
  marking: boolean
  onMarkClosed: () => void
}

const STAMP_LINE_A = 'Approved by'
const STAMP_LINE_B = 'CEO of the household'

/**
 * The clearing document a period close files.
 *
 * It states what the month totalled and nothing else — no positions, no debt (CONTRACTS.md
 * §9). Deliberately plain HTML, because html-to-image copies computed styles element by
 * element and UI5 web components would come out unstyled.
 */
export function ClearingDocumentCard({
  settlement,
  currency,
  marking,
  onMarkClosed,
}: ClearingDocumentCardProps) {
  const documentRef = useRef<HTMLDivElement>(null)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string | undefined>(undefined)

  const closed = settlement.status === 'settled'
  const documentNumber = settlement.clearingDocument || `CLR-${settlement.period}`
  const approvedBy = settlement.approvedBy?.trim()
  const showsApprover = approvedBy && approvedBy.toLowerCase() !== STAMP_LINE_B.toLowerCase()
  const headline = `${formatPeriod(settlement.period)} · ${formatMoney(settlement.grandTotal, currency)}`

  const share = async () => {
    const node = documentRef.current
    if (!node) return
    setSharing(true)
    setShareError(undefined)
    try {
      const background = getComputedStyle(node).backgroundColor
      const blob = await toBlob(node, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: background === 'rgba(0, 0, 0, 0)' ? '#ffffff' : background,
      })
      if (!blob) throw new Error('The document could not be rendered.')
      const file = new File([blob], `${documentNumber}.png`, { type: 'image/png' })
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: documentNumber, text: headline })
      } else {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = file.name
        link.rel = 'noopener'
        document.body.appendChild(link)
        link.click()
        link.remove()
        // Safari can still be reading the blob when the click returns.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setShareError(cause instanceof Error ? cause.message : 'Could not share the document.')
    } finally {
      setSharing(false)
    }
  }

  return (
    <div className="clearing">
      <div className="clearing-doc" ref={documentRef}>
        <div className="clearing-doc__head">
          <div>
            <div className="clearing-doc__eyebrow">Clearing document</div>
            <div className="clearing-doc__number">{documentNumber}</div>
          </div>
          <div
            className={`clearing-doc__status clearing-doc__status--${closed ? 'settled' : 'open'}`}
          >
            {closed ? 'Closed' : 'Open'}
          </div>
        </div>

        <dl className="clearing-doc__rows">
          <dt>Period</dt>
          <dd>{formatPeriod(settlement.period)}</dd>

          <dt>Total posted</dt>
          <dd data-testid="clearing-total">{formatMoney(settlement.grandTotal, currency)}</dd>

          {closed && settlement.settledAt && (
            <>
              <dt>Closed on</dt>
              <dd>{formatDate(settlement.settledAt.slice(0, 10))}</dd>
            </>
          )}
        </dl>

        <p className="clearing-doc__total">{headline}</p>

        <div className="clearing-doc__stamp">
          <span>{STAMP_LINE_A}</span> <span>{STAMP_LINE_B}</span>
          {showsApprover && <small>{approvedBy}</small>}
        </div>

        <div className="clearing-doc__foot">
          Two-Way Match · posted against period {settlement.period}
        </div>
      </div>

      <div className="clearing__actions">
        {!closed && (
          <Button
            className="ledger-touch"
            design="Emphasized"
            icon="accept"
            disabled={marking}
            onClick={onMarkClosed}
          >
            {marking ? 'Closing…' : 'Mark as closed'}
          </Button>
        )}
        <Button className="ledger-touch" icon="share" disabled={sharing} onClick={share}>
          {sharing ? 'Rendering…' : 'Share as image'}
        </Button>
      </div>

      {shareError && (
        <MessageStrip design="Negative" onClose={() => setShareError(undefined)}>
          {shareError}
        </MessageStrip>
      )}
    </div>
  )
}
