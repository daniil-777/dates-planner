import { useState } from 'react'
import { Button, BusyIndicator } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/pdf-attachment.js'
import '@ui5/webcomponents-icons/dist/inspect.js'
import './howItWorks.css'

/**
 * The engineering write-up, served in-app.
 *
 * The article is a complete, self-contained HTML document in `public/how-it-works.html`
 * with its own typography, palette and diagrams. Rendering it inside an iframe rather
 * than porting it into React is deliberate: its styles would otherwise collide with the
 * UI5 theme in both directions, and an iframe keeps the two design systems from fighting
 * while still giving the reader the app's own header and a way back.
 *
 * It is a static asset, so the service worker caches it with the rest of the shell and it
 * stays readable offline.
 */
const ARTICLE = '/how-it-works.html'
const PDF = '/teaching-a-ledger-to-read.pdf'

export function HowItWorksPage() {
  const [loaded, setLoaded] = useState(false)

  return (
    <div className="hiw">
      <header className="hiw-bar">
        <div className="hiw-titles">
          <h1 className="hiw-title">How it works</h1>
          <p className="hiw-sub">
            The model that reads your receipts — written for people who have never trained one
          </p>
        </div>
        <div className="hiw-actions">
          <Button
            design="Transparent"
            icon="inspect"
            onClick={() => window.open(ARTICLE, '_blank', 'noopener,noreferrer')}
          >
            Full page
          </Button>
          <Button
            design="Emphasized"
            icon="pdf-attachment"
            onClick={() => window.open(PDF, '_blank', 'noopener,noreferrer')}
          >
            PDF
          </Button>
        </div>
      </header>

      <div className="hiw-frame-wrap">
        {!loaded && (
          <div className="hiw-busy">
            <BusyIndicator active size="M" text="Opening the notebook…" />
          </div>
        )}
        <iframe
          className="hiw-frame"
          src={ARTICLE}
          title="Teaching a Ledger to Read — how the classifier works"
          loading="eager"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  )
}

export default HowItWorksPage
