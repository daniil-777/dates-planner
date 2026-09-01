import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { describeError } from '../../api/client'
import { useScanReceipt } from '../../api/hooks'
import { MAX_UPLOAD_BYTES } from './constants'
import { formatBytes, prepareImage } from './imageProcessing'
import { PHASE_CEILING } from './phases'
import type { ScanPhase, ScanQueueItem } from './types'

/** How long the busy card lingers on each label before moving on. */
const EXTRACTING_AFTER_MS = 450
const CLASSIFYING_AFTER_MS = 2100
const TICK_MS = 140

function newId(): string {
  const random = globalThis.crypto
  if (random && typeof random.randomUUID === 'function') return random.randomUUID()
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function isBusy(phase: ScanPhase): boolean {
  return phase !== 'queued' && phase !== 'done' && phase !== 'error'
}

export interface ScanQueue {
  items: ScanQueueItem[]
  /** The draft the confirm card is showing, if any. */
  active: ScanQueueItem | null
  /** The receipt currently in the pipeline, if any. */
  inFlight: ScanQueueItem | null
  /** Receipts scanned but not yet posted or discarded, excluding `active`. */
  queuedBehind: number
  addFiles: (files: File[]) => void
  retry: (id: string) => void
  remove: (id: string) => void
  markHandled: (id: string) => void
  reset: () => void
}

/**
 * A batch of receipts, processed one at a time.
 *
 * Sequential on purpose: Document AI is the slow step, a phone is usually on a
 * single bar of signal, and a card that says "Extracting…" for one named file is
 * more honest than four spinners racing.
 */
export function useScanQueue(): ScanQueue {
  const [items, setItems] = useState<ScanQueueItem[]>([])
  const scan = useScanReceipt()
  const scanAsync = scan.mutateAsync

  // Kept in refs so the pump is not re-created on every state change.
  const filesRef = useRef(new Map<string, File>())
  const pendingRef = useRef<string[]>([])
  const pumpingRef = useRef(false)
  const itemsRef = useRef<ScanQueueItem[]>([])
  itemsRef.current = items

  const patch = useCallback((id: string, next: Partial<ScanQueueItem>) => {
    setItems(prev => prev.map(item => (item.id === id ? { ...item, ...next } : item)))
  }, [])

  /** Phase changes never resurrect an item that already finished or failed. */
  const advance = useCallback((id: string, phase: ScanPhase) => {
    setItems(prev =>
      prev.map(item => (item.id === id && isBusy(item.phase) ? { ...item, phase } : item)),
    )
  }, [])

  const processItem = useCallback(
    async (id: string) => {
      const file = filesRef.current.get(id)
      if (!file) {
        patch(id, { phase: 'error', error: 'That photo is no longer available on this device.' })
        return
      }

      patch(id, { phase: 'preparing', progress: 2, error: null, result: null })

      let blob: Blob
      let fileName: string
      try {
        const prepared = await prepareImage(file)
        blob = prepared.blob
        fileName = prepared.fileName
      } catch (error) {
        patch(id, { phase: 'error', progress: 100, error: describeError(error) })
        return
      }

      if (blob.size > MAX_UPLOAD_BYTES) {
        patch(id, {
          phase: 'error',
          progress: 100,
          error: `This photo is ${formatBytes(blob.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
        })
        return
      }

      patch(id, { phase: 'uploading', uploadBytes: blob.size })

      const timers = [
        window.setTimeout(() => advance(id, 'extracting'), EXTRACTING_AFTER_MS),
        window.setTimeout(() => advance(id, 'classifying'), CLASSIFYING_AFTER_MS),
      ]

      try {
        const result = await scanAsync({ file: blob, fileName })
        patch(id, { phase: 'done', progress: 100, result, error: null })
      } catch (error) {
        patch(id, { phase: 'error', progress: 100, error: describeError(error) })
      } finally {
        for (const timer of timers) window.clearTimeout(timer)
      }
    },
    [advance, patch, scanAsync],
  )

  const pump = useCallback(async () => {
    if (pumpingRef.current) return
    pumpingRef.current = true
    try {
      for (;;) {
        const next = pendingRef.current.shift()
        if (next === undefined) break
        await processItem(next)
      }
    } finally {
      pumpingRef.current = false
    }
  }, [processItem])

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      const added = files.map<ScanQueueItem>(file => {
        const id = newId()
        filesRef.current.set(id, file)
        return {
          id,
          fileName: file.name || 'receipt.jpg',
          previewUrl: URL.createObjectURL(file),
          uploadBytes: null,
          phase: 'queued',
          progress: 0,
          result: null,
          error: null,
          handled: false,
        }
      })
      pendingRef.current.push(...added.map(item => item.id))
      setItems(prev => [...prev, ...added])
      void pump()
    },
    [pump],
  )

  const retry = useCallback(
    (id: string) => {
      if (!filesRef.current.has(id)) return
      patch(id, { phase: 'queued', progress: 0, error: null, result: null })
      pendingRef.current.push(id)
      void pump()
    },
    [patch, pump],
  )

  const remove = useCallback((id: string) => {
    pendingRef.current = pendingRef.current.filter(pending => pending !== id)
    filesRef.current.delete(id)
    setItems(prev => {
      const target = prev.find(item => item.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter(item => item.id !== id)
    })
  }, [])

  const markHandled = useCallback((id: string) => {
    filesRef.current.delete(id)
    setItems(prev => prev.map(item => (item.id === id ? { ...item, handled: true } : item)))
  }, [])

  const reset = useCallback(() => {
    pendingRef.current = []
    filesRef.current.clear()
    setItems(prev => {
      for (const item of prev) URL.revokeObjectURL(item.previewUrl)
      return []
    })
  }, [])

  // Ease the bar towards the ceiling of the current phase. There is no upload
  // progress event behind an OData action, so this is a paced estimate, never a
  // claim: it stops short of 100 until the server actually answers.
  const busy = items.some(item => isBusy(item.phase))
  useEffect(() => {
    if (!busy) return
    const handle = window.setInterval(() => {
      setItems(prev =>
        prev.map(item => {
          if (!isBusy(item.phase)) return item
          const ceiling = PHASE_CEILING[item.phase]
          if (item.progress >= ceiling) return item
          const step = Math.max(0.5, (ceiling - item.progress) * 0.12)
          return { ...item, progress: Math.min(ceiling, item.progress + step) }
        }),
      )
    }, TICK_MS)
    return () => window.clearInterval(handle)
  }, [busy])

  // Object URLs outlive React unless we say otherwise.
  useEffect(
    () => () => {
      for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl)
    },
    [],
  )

  const unhandled = useMemo(
    () => items.filter(item => !item.handled && item.phase === 'done'),
    [items],
  )

  return {
    items: items.filter(item => !item.handled),
    active: unhandled[0] ?? null,
    inFlight: items.find(item => isBusy(item.phase)) ?? null,
    queuedBehind: Math.max(0, unhandled.length - 1),
    addFiles,
    retry,
    remove,
    markHandled,
    reset,
  }
}
