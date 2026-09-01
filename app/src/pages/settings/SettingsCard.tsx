/**
 * The section wrapper every settings block sits in.
 *
 * A plain element rather than `Card` + `CardHeader`: these sections carry forms, tables and
 * a colour picker, and the card component's header slot is built for a title and a number,
 * not for a paragraph of explanation. The styling in `settings.css` is Horizon's, taken
 * from the same theme parameters the real component uses.
 */
import type { ReactNode } from 'react'
import { Icon, Title } from '@ui5/webcomponents-react'

export interface SettingsCardProps {
  title: string
  subtitle?: string
  /** SAP icon name; the collection is registered in `main.tsx`. */
  icon?: string
  /** Anchor target, so onboarding can hand the user straight to a section. */
  id?: string
  children: ReactNode
}

export function SettingsCard({ title, subtitle, icon, id, children }: SettingsCardProps) {
  return (
    <section className="twm-card" id={id} aria-label={title}>
      <header className="twm-card-head">
        {icon === undefined ? null : <Icon name={icon} aria-hidden="true" />}
        <div className="twm-card-headtext">
          <Title level="H4">{title}</Title>
          {subtitle === undefined ? null : <span className="twm-card-subtitle">{subtitle}</span>}
        </div>
      </header>
      <div className="twm-card-body">{children}</div>
    </section>
  )
}

export default SettingsCard
