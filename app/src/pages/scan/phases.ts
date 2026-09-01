import type { ScanPhase } from './types'

/** Fiori-deadpan copy for each step of the pipeline. */
const LABELS: Record<ScanPhase, string> = {
  queued: 'Queued',
  preparing: 'Preparing image…',
  uploading: 'Uploading…',
  extracting: 'Extracting… (Document AI)',
  classifying: 'Classifying…',
  done: 'Ready to confirm',
  error: 'Failed',
}

export function phaseLabel(phase: ScanPhase): string {
  return LABELS[phase]
}

/** The steps the busy card lists, in order. */
export const BUSY_STEPS: ScanPhase[] = ['preparing', 'uploading', 'extracting', 'classifying']

/** Progress ceiling each phase eases towards while we wait on the network. */
export const PHASE_CEILING: Record<ScanPhase, number> = {
  queued: 0,
  preparing: 22,
  uploading: 44,
  extracting: 78,
  classifying: 96,
  done: 100,
  error: 100,
}

export function phaseIndex(phase: ScanPhase): number {
  const index = BUSY_STEPS.indexOf(phase)
  if (index >= 0) return index
  return phase === 'queued' ? -1 : BUSY_STEPS.length
}
