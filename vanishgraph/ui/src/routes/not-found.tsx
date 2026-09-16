/**
 * The not-found state (SPEC-004 §1, VG-UI-004's negative case; EP-005 M1).
 *
 * IT MUST NOT DISCLOSE WHETHER A ROUTE EXISTS. A not-found page that said "no such route `/portal/cases/123`" would
 * tell a prober which ids are real and which are not — the browser-side twin of the rule that a foreign resource and an
 * absent one return the same answer (SPEC-006 H-9). The rendered text is therefore the same for every undeclared path,
 * and the path is NOT echoed.
 */

export function NotFound(): React.JSX.Element {
  return (
    <main>
      <h1>Not found</h1>
      <p>This page is not part of the application. No information is available about it.</p>
    </main>
  );
}


