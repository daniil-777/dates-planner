/**
 * Settings — master data, the planner, the importer, and the system.
 *
 * Also the home of first launch: when `twm.onboarded` is missing from `localStorage` the
 * wizard takes the screen before anything else is rendered, asks who is on the ledger,
 * shows Document #1, and offers the bank import. The flag is written here, when the wizard
 * says it is finished, so an interrupted introduction starts again rather than being lost.
 */
import { useCallback, useState } from 'react'
import { MessageStrip, Title } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/group.js'
import '@ui5/webcomponents-icons/dist/world.js'
import { usePeople } from '@/api/hooks'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { formatDateTime } from '@/theme'
import { BankImport } from './settings/BankImport'
import { OnboardingWizard } from './settings/OnboardingWizard'
import { AddPerson, PersonEditor } from './settings/PeopleSettings'
import { PlannerCard } from './settings/PlannerCard'
import { HouseholdCard } from './settings/HouseholdCard'
import { LanguageCard } from './settings/LanguageCard'
import { SessionCard } from './settings/SessionCard'
import { SettingsCard } from './settings/SettingsCard'
import { SystemCard } from './settings/SystemCard'
import { VersionCard } from './settings/VersionCard'
import { clearOnboarded, isOnboarded, markOnboarded, onboardedAt } from './settings/onboarding'
import './settings/settings.css'

/** The anchor the wizard hands the user to when they choose to import straight away. */
const IMPORT_ANCHOR = 'bank-import'

export function SettingsPage() {
  const people = usePeople()
  const [wizardOpen, setWizardOpen] = useState(() => !isOnboarded())
  const [introducedAt, setIntroducedAt] = useState<string | null>(() => onboardedAt())

  const finishWizard = useCallback((next: 'import' | 'done') => {
    markOnboarded()
    setIntroducedAt(onboardedAt())
    setWizardOpen(false)
    if (next === 'import') {
      // After the overlay is gone, not before, or the element is not laid out yet.
      window.requestAnimationFrame(() => {
        document.getElementById(IMPORT_ANCHOR)?.scrollIntoView({ behavior: 'smooth' })
      })
    }
  }, [])

  const replayOnboarding = useCallback(() => {
    clearOnboarded()
    setIntroducedAt(null)
    setWizardOpen(true)
  }, [])

  // Seeded rows first, then alphabetically: the household above the guests.
  const rows = [...(people.data ?? [])].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      <OnboardingWizard open={wizardOpen} onFinish={finishWizard} />

      <div className="twm-settings">
        <div>
          <Title level="H3">Settings</Title>
          <p className="twm-settings-intro">
            Company code 001 · one ledger · no approval workflow, because everybody on it lives in
            the same flat.
          </p>
        </div>

        <HouseholdCard />

        <SettingsCard
          icon="group"
          title="People"
          subtitle="Master data. Every posting points at one of these rows, and so does every event."
        >
          {people.isPending ? (
            <LoadingSkeleton rows={2} />
          ) : people.isError ? (
            <ErrorState error={people.error} onRetry={() => void people.refetch()} />
          ) : (
            <>
              {rows.map(person => (
                <PersonEditor key={person.ID} person={person} removable={rows.length > 1} />
              ))}
              <AddPerson people={rows} />
              <MessageStrip design="Information" hideCloseButton>
                Add as many people as the flat, the trip or the dinner needs. There is nothing to
                square up here: a posting records who paid, and a colour is how you tell them apart
                on a chart. Anyone with postings stays on the roster.
              </MessageStrip>
            </>
          )}
        </SettingsCard>

        <PlannerCard />

        <BankImport id={IMPORT_ANCHOR} />

        <LanguageCard />

        <SessionCard />

        <VersionCard />

        <SystemCard onReplayOnboarding={replayOnboarding} />

        <p className="twm-settings-intro">
          {introducedAt === null
            ? 'This browser has not been introduced yet.'
            : `This browser was introduced on ${formatDateTime(introducedAt)}.`}
        </p>
      </div>
    </>
  )
}

export default SettingsPage
