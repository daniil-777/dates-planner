import {
  Button,
  Card,
  CardHeader,
  MessageStrip,
  ObjectStatus,
  Text,
} from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/camera.js'
import '@ui5/webcomponents-icons/dist/journey-arrive.js'
import { MoneyText } from '../../components/MoneyText'
import { formatDate } from '../../theme'
import type { Expense } from '../../api/types'
import type { PostedInfo } from './types'

interface PostedCardProps {
  posted: PostedInfo
  duplicates: Expense[]
  onScanAnother: () => void
  onOpenLedger: () => void
}

/**
 * The receipt after the posting. Deadpan on purpose: a document number, and —
 * if the ledger already knows this purchase — a request to verify rather than a
 * refusal, because sometimes you really did go twice.
 */
export function PostedCard({ posted, duplicates, onScanAnother, onOpenLedger }: PostedCardProps) {
  const documentLine =
    posted.documentNumber === null
      ? 'Posted to the ledger'
      : `Posted as document #${posted.documentNumber}`

  return (
    <Card
      className="scan-card"
      data-testid="scan-posted-card"
      header={<CardHeader titleText={documentLine} subtitleText={posted.merchant} />}
    >
      <div className="scan-posted">
        <ObjectStatus state="Positive" showDefaultIcon large>
          <MoneyText amount={posted.amount} currency={posted.currency} bold />
        </ObjectStatus>

        {posted.memorySaved ? <Text className="scan-hint">Also filed in Memories.</Text> : null}

        {posted.warnings.map(warning => (
          <MessageStrip key={warning} design="Information" hideCloseButton>
            {warning}
          </MessageStrip>
        ))}

        {duplicates.length > 0 ? (
          <>
            <MessageStrip design="Critical" hideCloseButton data-testid="scan-duplicate-warning">
              Verify — the ledger already has {duplicates.length === 1 ? 'a posting' : 'postings'}{' '}
              that look like this one.
            </MessageStrip>
            <ul className="scan-dupe-list">
              {duplicates.map(duplicate => (
                <li className="scan-dupe" key={duplicate.ID}>
                  <span>
                    {duplicate.merchantRaw}
                    <br />
                    <span className="scan-dupe-meta">
                      {formatDate(duplicate.date)}
                      {duplicate.documentNumber === null
                        ? ' · draft'
                        : ` · document #${duplicate.documentNumber}`}
                    </span>
                  </span>
                  <MoneyText amount={duplicate.amount} currency={duplicate.currency} />
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <div className="scan-actions">
          <Button
            className="scan-actions-grow"
            design="Emphasized"
            icon="camera"
            accessibleName="Scan another receipt"
            onClick={onScanAnother}
          >
            Scan another
          </Button>
          <Button
            design="Transparent"
            icon="journey-arrive"
            accessibleName="Open the ledger"
            onClick={onOpenLedger}
          >
            Open ledger
          </Button>
        </div>
      </div>
    </Card>
  )
}
