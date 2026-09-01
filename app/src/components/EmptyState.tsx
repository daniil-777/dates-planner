import '@ui5/webcomponents-fiori/dist/illustrations/NoData.js'
import '@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js'
import '@ui5/webcomponents-fiori/dist/illustrations/EmptyList.js'
import '@ui5/webcomponents-fiori/dist/illustrations/NoActivities.js'
import '@ui5/webcomponents-fiori/dist/illustrations/NoFilterResults.js'
import '@ui5/webcomponents-fiori/dist/illustrations/NoChartData.js'
import '@ui5/webcomponents-fiori/dist/illustrations/UploadCollection.js'
import '@ui5/webcomponents-fiori/dist/illustrations/BalloonSky.js'
import '@ui5/webcomponents-fiori/dist/illustrations/Tent.js'
import '@ui5/webcomponents-fiori/dist/illustrations/SimpleEmptyDoc.js'
import '@ui5/webcomponents-fiori/dist/illustrations/AddPeople.js'
import '@ui5/webcomponents-fiori/dist/illustrations/SearchEarth.js'
import '@ui5/webcomponents-fiori/dist/illustrations/EmptyCalendar.js'
import '@ui5/webcomponents-fiori/dist/illustrations/SuccessScreen.js'
import type { ReactNode } from 'react'
import { IllustratedMessage } from '@ui5/webcomponents-react'

export interface EmptyStateProps {
  /**
   * Either an illustration name (`'NoEntries'`) or the SAP icon a caller would have used
   * for this screen (`'receipt'`) — both are accepted and mapped to a bundled illustration.
   */
  icon?: string
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

/** The illustrations bundled above. Anything outside this set would render as a blank box. */
const BUNDLED = new Set([
  'NoData',
  'NoEntries',
  'EmptyList',
  'NoActivities',
  'NoFilterResults',
  'NoChartData',
  'UploadCollection',
  'BalloonSky',
  'Tent',
  'SimpleEmptyDoc',
  'AddPeople',
  'SearchEarth',
  'EmptyCalendar',
  'SuccessScreen',
])

/**
 * Callers think in SAP icons, because that is what the rest of the app is drawn with.
 * Illustrations are a different, much smaller vocabulary, so the icon a page would have
 * reached for is translated into the closest illustration that is actually loaded.
 */
const ICON_TO_ILLUSTRATION: Record<string, string> = {
  receipt: 'UploadCollection',
  camera: 'UploadCollection',
  'add-photo': 'UploadCollection',
  'attachment-photo': 'UploadCollection',
  'upload-to-cloud': 'UploadCollection',
  list: 'NoEntries',
  'money-bills': 'NoEntries',
  'travel-expense': 'NoEntries',
  'payment-approval': 'NoEntries',
  wallet: 'NoEntries',
  heart: 'BalloonSky',
  favorite: 'BalloonSky',
  present: 'BalloonSky',
  flight: 'Tent',
  'travel-itinerary': 'Tent',
  'document-text': 'SimpleEmptyDoc',
  newspaper: 'SimpleEmptyDoc',
  'bar-chart': 'NoChartData',
  'line-chart': 'NoChartData',
  'pie-chart': 'NoChartData',
  filter: 'NoFilterResults',
  search: 'NoFilterResults',
  group: 'AddPeople',
  customer: 'AddPeople',
  map: 'SearchEarth',
  world: 'SearchEarth',
  calendar: 'EmptyCalendar',
  accept: 'SuccessScreen',
}

function illustrationFor(icon: string | undefined): string {
  if (!icon) return 'NoData'
  if (BUNDLED.has(icon)) return icon
  return ICON_TO_ILLUSTRATION[icon] ?? 'NoData'
}

/**
 * What a list shows when it has nothing to show. Never a blank screen — FRONTEND-CONTRACT §7.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={className ? `twm-empty ${className}` : 'twm-empty'} data-testid="empty-state">
      <IllustratedMessage
        name={illustrationFor(icon)}
        titleText={title}
        subtitleText={description}
        design="Auto"
      >
        {action}
      </IllustratedMessage>
    </div>
  )
}

export default EmptyState
