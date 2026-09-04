import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { buildStamp } from './vite/buildStamp.ts'

/**
 * Where the CAP server is.
 *
 * Configurable so the end-to-end suite can stand up its own pair of servers on other ports
 * while a dev server is still running. It used to be a constant, and the cost of that was
 * that `npm run e2e` refused to start whenever `npm run dev` was up — which is most of the
 * time somebody would want to run it.
 */
const CAP = process.env.TWM_CAP_URL ?? 'http://localhost:4004'

/**
 * The `72` faces UI5 bakes absolute jsdelivr URLs for, rewritten to `public/fonts`.
 *
 * `@ui5/webcomponents` emits its `@font-face` rules into the theme CSS at build time with
 * the CDN host hard-coded, and helmet's `font-src 'self' data:` in `srv/server.ts` blocks
 * every one of them. It does not show up in `npm run dev`, where the SPA comes from Vite
 * and only API calls pass through helmet; it shows up the moment CAP serves `app/dist`,
 * which is every deployment, as 38 console violations and the browser's fallback font.
 *
 * Rewriting to a local copy is the fix that keeps `font-src` tight rather than widening it
 * to a third party. It also means the service worker precaches the faces, so an installed
 * PWA renders in the right font offline — which widening the CSP would not have bought.
 *
 * The version is matched loosely so a `@sap-theming/theming-base-content` bump does not
 * silently reintroduce the CDN; keep `public/fonts` in step with the package when it moves.
 */
const UI5_FONT_CDN =
  /https:\/\/cdn\.jsdelivr\.net\/npm\/@sap-theming\/theming-base-content@[^/]+\/content\/Base\/baseLib\/baseTheme\/fonts\//g

function bundleUi5Fonts(): Plugin {
  return {
    name: 'twm-bundle-ui5-fonts',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') {
          file.code = file.code.replace(UI5_FONT_CDN, '/fonts/')
        } else if (typeof file.source === 'string') {
          file.source = file.source.replace(UI5_FONT_CDN, '/fonts/')
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    bundleUi5Fonts(),
    buildStamp({
      packageJsonPath: fileURLToPath(new URL('../package.json', import.meta.url)),
      cwd: fileURLToPath(new URL('.', import.meta.url)),
    }),
    VitePWA({
      // `prompt`, not `autoUpdate`: a new build waits until somebody taps Reload
      // (`src/update/`), instead of reloading the page underneath a half-typed posting or a
      // receipt that is mid-scan. What the phone is running is always visible in Settings.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'Two-Way Match',
        short_name: '2WM',
        description: 'Household date management',
        theme_color: '#0070F2',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // `prompt` mode leaves both of these off. `skipWaiting` must stay off — that is what
        // makes the new worker wait for the tap. `clientsClaim` must be on: without it the
        // worker that just took over after SKIP_WAITING controls nothing until the next
        // navigation, workbox-window never sees `controlling`, and the plugin never reloads
        // the page — only the store's fallback timer would.
        clientsClaim: true,
        skipWaiting: false,
        // No `.json`: `build.json` is the one file that must be read fresh from the server,
        // because it is the server's answer to "which build are you serving".
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/health/],
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/[^/]+\/api\/ledger\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'ledger-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: CAP, changeOrigin: true },
      '/health': { target: CAP, changeOrigin: true },
    },
  },
  /*
   * MapLibre resolves its own web worker with `new URL('./maplibre-gl-worker.mjs',
   * import.meta.url)`. Vite's dependency pre-bundling rewrites the entry into
   * `node_modules/.vite/deps/` and does not carry the worker with it, so `import.meta.url`
   * resolves to a directory the worker is not in and the request 404s. There is no error in
   * the console — the map mounts, the attribution renders, and no tile ever appears, which
   * reads as a broken tile source rather than a missing file.
   *
   * Excluding it from pre-bundling makes Vite serve the package from its real location, with
   * the worker beside it. Only affects `npm run dev`; the production build resolves it
   * through Rollup and was always correct.
   */
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
