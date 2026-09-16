/**
 * The page shell every route renders (SPEC-004 §1, VG-UI-004; EP-005 M1).
 *
 * WHAT IT IS FOR, AND WHAT IT DELIBERATELY IS NOT. It states the route's SURFACE, its PATH and its declared PURPOSE —
 * the three facts SPEC-004 §1 fixes — and it renders **no control of any kind**. That is the honest foundation this
 * milestone can build: a page that exists, is reachable from the manifest, and promises nothing the surface milestones
 * have not yet delivered. A placeholder button here would be a control a later inventory test could find and could not
 * explain.
 *
 * THE NON-GOALS ARE NOT REPEATED PER PAGE. Each surface's non-goals live in SPEC-004 §1 and in the route modules'
 * headers; rendering them on every page would be a second copy to drift, and the page a user reads is not the place a
 * reviewer checks a rule.
 */

export interface PageShellProps {
  readonly surface: string;
  readonly path: string;
  readonly purpose: string;
}

export function PageShell({ surface, path, purpose }: PageShellProps): React.JSX.Element {
  return (
    <main>
      {/* `h1` carries the PATH, not the purpose: the path is what the user navigated to and what a support call can
          repeat, and it is stable while a purpose statement may be reworded. */}
      <h1>{path}</h1>
      <dl>
        <dt>Surface</dt>
        <dd>{surface}</dd>
        <dt>Purpose</dt>
        <dd>{purpose}</dd>
      </dl>
      <p>
        This surface is declared by SPEC-004 §1 and its pages arrive with the milestones that own them. No control is
        rendered here yet, and nothing on this page advances a truth state.
      </p>
    </main>
  );
}
