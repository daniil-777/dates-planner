/**
 * Bundled Document AI job results used by the mock client.
 *
 * They are imported rather than read from disk so that they survive `cds build`
 * and any bundling step — a mock that only works from the source tree would be a
 * mock that breaks in production, which is exactly where we still want it.
 */
import type { DocAiJobResult } from '../types'
import hotelInvoice from './hotel-invoice.json'
import migrosReceipt from './migros-receipt.json'
import restaurantReceipt from './restaurant-receipt.json'

export interface DocAiFixtures {
  migros: DocAiJobResult
  restaurant: DocAiJobResult
  hotel: DocAiJobResult
}

export const fixtures: DocAiFixtures = {
  migros: migrosReceipt,
  restaurant: restaurantReceipt,
  hotel: hotelInvoice,
}

/**
 * Fixture selection is by file name keyword (CONTRACTS.md §6) so a developer can
 * steer the mock simply by naming the photo they upload.
 */
export function pickFixture(fileName: string): DocAiJobResult {
  const name = typeof fileName === 'string' ? fileName.toLowerCase() : ''
  if (name.includes('migros')) return fixtures.migros
  if (name.includes('hotel')) return fixtures.hotel
  return fixtures.restaurant
}
