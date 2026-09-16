/**
 * Playwright configuration (EP-005 M4/M7/M8; M1 creates it).
 *
 * IT RUNS AGAINST THE BUILT APPLICATION, NEVER A DEV SERVER. SPEC-008 VG-SHIP-021/022: acceptance is asserted against
 * the artefact that would ship. The web server below serves `ui/dist`, so a suite that passes here has passed against
 * the bundle — and `scripts/test-e2e.sh` refuses to run at all when that bundle is missing.
 *
 * TWO PROJECTS, and the split is the point: `ui` is the functional suite, `a11y` is the axe-core pass. A single project
 * would let an accessibility failure be reported as a functional one, and the milestone that owns accessibility
 * (VG-UI-060…064) needs its own signal.
 *
 * NO TRACES, NO VIDEOS, NO SCREENSHOTS BY DEFAULT. A trace of a run through this application contains whatever the
 * page rendered — which is a data subject's record. They are enabled only through the environment variable a developer
 * sets deliberately while debugging.
 */

import { defineConfig, devices } from '@playwright/test';

const BUILT_APP = 'ui/dist';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: process.env['CI'] !== undefined && process.env['CI'] !== '',
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: process.env['VG_E2E_TRACE'] === '1' ? 'on' : 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'ui',
      testIgnore: /a11y\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'a11y',
      testMatch: /a11y\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // A STATIC SERVER OVER THE BUILD OUTPUT. `vite preview` is the same bundler's server for the artefact it produced,
  // so nothing here can serve code the build did not emit.
  webServer: {
    command: `npx --no-install vite preview --outDir ${BUILT_APP} --port 4173 --strictPort`,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
