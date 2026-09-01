/**
 * Public surface of the Document AI subsystem (CONTRACTS.md §6).
 *
 * Consumers should import from here rather than from the individual modules, so
 * the split between client, mapper and fixtures stays an implementation detail.
 */
export type {
  DocAiClient,
  DocAiCoordinates,
  DocAiExtraction,
  DocAiField,
  DocAiJobResult,
  DocAiJobStatus,
  DocAiSubmitOptions,
  ExtractedReceipt,
  ReceiptLineItem,
} from './types'

export { DocAiError, MOCK_DELAY_MS, getDocAiClient } from './client'
export { mapDocAiResult, mapJobResult, parseAmount, parseDate, parseTime } from './mapper'
export { fixtures, pickFixture } from './fixtures'
