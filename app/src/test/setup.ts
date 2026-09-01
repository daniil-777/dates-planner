import '@testing-library/jest-dom/vitest'

// UI5 Web Components register custom elements that jsdom does not implement.
// These shims keep component rendering from throwing during unit tests.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// jsdom ships no canvas implementation, so the client-side receipt downscaler
// (pages/scan/imageProcessing.ts) floods the test output with "Not implemented"
// noise. Stub just enough of the 2D context for that code path to run.
if (
  typeof HTMLCanvasElement !== 'undefined' &&
  !HTMLCanvasElement.prototype.getContext.toString().includes('stub')
) {
  HTMLCanvasElement.prototype.getContext = function stub() {
    return {
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
      clearRect: () => {},
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
    cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }))
  }
}
