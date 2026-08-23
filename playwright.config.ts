import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/electron-runtime-global-setup.cjs',
  timeout: 30_000
})
