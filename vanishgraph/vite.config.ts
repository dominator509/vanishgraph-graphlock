/**
 * Vite configuration (EP-005 M1, ADR-007).
 *
 * THE BUILD OUTPUT IS A STATIC BUNDLE, and nothing here proxies to the API: the portal is served as files and talks to
 * `/v1` over the network, so a development proxy would be a configuration the production deployment does not have.
 * Where the API lives is a deployment concern (a reverse proxy, a same-origin path), not a build-time constant.
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // THE SOURCE MAPS ARE OFF, and that is a privacy decision rather than a size one: a production source map ships the
    // application's own source to whoever loads it, and this application's source describes how a data-subject record is
    // handled. A reviewer who wants to debug a build can produce one deliberately.
    sourcemap: false,
  },
  server: {
    // A dev server is for development only; `scripts/test-e2e.sh` runs against the BUILT output, never this
    // (SPEC-008 VG-SHIP-021/022).
    port: 5173,
  },
});
