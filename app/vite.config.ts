import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

const CAP = 'http://localhost:4004'

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
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'Two-Way Match',
        short_name: '2WM',
        description: 'Household spend management',
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
