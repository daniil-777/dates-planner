/**
 * Types for the SAP Document AI (Document Information Extraction) integration.
 *
 * Two families live here on purpose: the *wire* types describe what the BTP
 * service actually sends back, so the mapper can narrow an `unknown` payload
 * without reaching for `any`; the *domain* types are the receipt shape the
 * ledger works with, fixed by CONTRACTS.md §6.
 */
import type { Buffer } from 'node:buffer'

/* ------------------------------------------------------------------ wire */

/** Normalised bounding box of an extracted field, 0..1 relative to the page. */
export interface DocAiCoordinates {
  x: number
  y: number
  w: number
  h: number
}

/** A single extracted field. `confidence` is absent on some models, hence optional. */
export interface DocAiField {
  name: string
  value: string | number | boolean | null
  /** 'header' for header fields, 'details' for line-item fields. */
  category?: string
  type?: string
  page?: number
  confidence?: number
  coordinates?: DocAiCoordinates
  [key: string]: unknown
}

export interface DocAiExtraction {
  headerFields?: DocAiField[]
  /** One inner array per detected line item. */
  lineItems?: DocAiField[][]
}

/**
 * Job states we act on — `ERROR` is not documented by the service but is cheap to
 * treat as terminal. The job itself carries `status` as a plain string because the
 * service is free to add states; compare against these after upper-casing.
 */
export type DocAiJobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'DELETING' | 'ERROR'

export interface DocAiJobResult {
  id: string
  status: string
  fileName?: string
  fileType?: string
  documentType?: string
  clientId?: string
  schemaId?: string
  schemaName?: string
  country?: string
  created?: string
  finished?: string
  processedTime?: number | string
  extraction?: DocAiExtraction
  [key: string]: unknown
}

/** The `options` part of the multipart submit request. */
export interface DocAiSubmitOptions {
  extraction: {
    headerFields: string[]
    lineItemFields: string[]
  }
  clientId: string
  documentType: string
  schemaName?: string
}

/* ---------------------------------------------------------------- domain */

export interface ReceiptLineItem {
  description: string
  quantity: number | null
  netAmount: number | null
}

export interface ExtractedReceipt {
  merchantRaw: string | null
  date: string | null
  time: string | null
  amount: number | null
  currency: string
  place: string | null
  lineItems: ReceiptLineItem[]
  confidence: Record<string, number>
  rawFields: Record<string, unknown>
}

/* ---------------------------------------------------------------- client */

export interface DocAiClient {
  submitJob(image: Buffer, mimeType: string, fileName: string): Promise<string>
  getJob(jobId: string): Promise<unknown>
  pollJob(jobId: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<unknown>
  readonly mode: 'live' | 'mock'
}
