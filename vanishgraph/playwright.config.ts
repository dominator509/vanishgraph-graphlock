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

export default defineConfig({
  // THE SUITE ROOT IS `tests/ui`, which is where TESTING.md's table and EP-005 M4 both put the browser suites. The
  // `*.spec.ts` extension is what keeps them out of the unit stage, whose runner collects `*.test.ts` only.
  testDir: 'tests/ui',
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
  //
  // `--outDir dist`, NOT `--outDir ui/dist`, and MEASURED: `vite.config.ts` sets `root: 'ui'`, so a preview outDir is
  // resolved relative to that root. The first version of this file passed `ui/dist` and the server refused to start
  // with `The directory "ui/dist" does not exist` — while `ui/dist` plainly did exist. The path was being read as
  // `ui/ui/dist`. M1 wrote this command and no suite ran it until M4, which is why the defect survived: a web server
  // configuration that nothing starts is untested configuration.
  // `--host 127.0.0.1` IS REQUIRED, AND IT WAS MEASURED RATHER THAN GUESSED: with Vite's default host the preview
  // server printed `Local: http://localhost:4173/` and every connection to `http://127.0.0.1:4173` was REFUSED
  // (`No connection could be made because the target machine actively refused it`), because the default binds IPv6
  // loopback only on this machine while `baseURL` below and Playwright's own readiness poll use the IPv4 literal.
  // Passing the host makes the address the suite polls and the address the server binds the same one.
  webServer: {
    command: 'npx --no-install vite preview --outDir dist --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});


