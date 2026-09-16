/**
 * The application entry point (SPEC-004 §1; EP-005 M1).
 *
 * WHAT IT DOES: mounts the router and the query client onto a single element. WHAT IT DELIBERATELY DOES NOT DO: it
 * installs no analytics, no error-reporting beacon, no session-recording script and no third-party tag — SPEC-004 §12
 * and VG-UI-090…093 forbid trackers in the browser, and the cheapest way to comply is to have nothing to remove. A
 * later milestone that needs a first-party telemetry call must add it here, where a reviewer will see it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { router } from './router.ts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // NO RETRY ON FAILURE BY DEFAULT, and the reason is a product rule rather than a preference: a retry is a second
      // request, and a mutation retry is exactly what VG-ACTION-001's at-most-once rule forbids. A query that fails is
      // a state the UI shows, not one it hides behind a loop.
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById('root');
if (container === null) {
  throw new Error('the application root element is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
