/**
 * The one thing about the camera that can be checked without a camera.
 *
 * `camera.ts` loads its WebAssembly runtime from a CDN at a pinned version, and the first pin
 * was a version that had never been published — jsdelivr answered 404 for every file under
 * it, so the Dance chapter's camera could not start on any device. It shipped, and nothing
 * noticed, because every test of that chapter reaches the demonstration figure, which is
 * drawn from keyframes and never loads MediaPipe.
 *
 * A URL cannot be verified offline. What can be verified is the property whose violation
 * caused it: that the version we ask the CDN for is the version we actually installed.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { WASM_VERSION } from './camera'

describe('the MediaPipe runtime version', () => {
  it('matches the installed package exactly', () => {
    // The loader JS comes from node_modules and the WASM from the CDN. They are two halves of
    // one runtime, and a mismatched pair fails on a real device rather than in CI — which is
    // the quiet version of the bug that already happened once.
    const installed = JSON.parse(
      readFileSync('node_modules/@mediapipe/tasks-vision/package.json', 'utf8'),
    ) as { version: string }

    expect(
      WASM_VERSION,
      'camera.ts asks the CDN for a different version than package.json installed — the ' +
        'loader and the WASM must be the same release.',
    ).toBe(installed.version)
  })

  it('is a real, fully-qualified version rather than a range or a tag', () => {
    // jsdelivr does not resolve ranges or dist-tags for file paths: `@latest` and `^1.0.0`
    // both 404 the same way the unpublished pin did.
    expect(WASM_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  })
})
