/**
 * Barrel for the shared widgets of FRONTEND-CONTRACT §5.
 *
 * Pages may import either from here or from the individual modules; both are supported so
 * that a page pulling in one chip does not have to pull in the shell.
 */

export { AppShell, NAV_ITEMS, useActivePerson } from './AppShell'
export type { AppShellProps, ActivePersonValue } from './AppShell'

export { CategoryChip } from './CategoryChip'
export type { CategoryChipProps } from './CategoryChip'

export { ConfirmDialog } from './ConfirmDialog'
export type { ConfirmDialogProps } from './ConfirmDialog'

export { EmptyState } from './EmptyState'
export type { EmptyStateProps } from './EmptyState'

export { ErrorState } from './ErrorState'
export type { ErrorStateProps } from './ErrorState'

export { EventChip } from './EventChip'
export type { EventChipProps } from './EventChip'

export { LoadingSkeleton } from './LoadingSkeleton'
export type { LoadingSkeletonProps } from './LoadingSkeleton'

export { MomentBadge } from './MomentBadge'
export type { MomentBadgeProps } from './MomentBadge'

export { MoneyText } from './MoneyText'
export type { MoneyTextProps } from './MoneyText'

export { PersonAvatar } from './PersonAvatar'
export type { PersonAvatarProps } from './PersonAvatar'

export { PersonPicker } from './PersonPicker'
export type { PersonPickerProps } from './PersonPicker'
