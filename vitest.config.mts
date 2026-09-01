import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['srv/**/*.ts'],
      exclude: ['srv/**/fixtures/**'],
      reporter: ['text', 'html'],
    },
  },
})
