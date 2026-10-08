/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // GitHub's shared runners are 2–3× slower than a dev machine; the heavier
    // RTL suites (Race Week, Race Day, Settings) can take more than 5 s there.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/services/**', 'src/data/**'],
      reporter: ['text', 'html'],
    },
  },
});
