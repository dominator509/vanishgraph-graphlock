/**
 * The auditor view is read-only, asserted on the modules and on the rendered snapshot (SPEC-004 §10 VG-UI-002; EP-005 M6).
 *
 * THE PLAN REQUIRES BOTH HALVES AND SAYS NEITHER IS SUFFICIENT ALONE: a build-time assertion that no auditor module can
 * write, and an assertion against the running built application. This suite is the first half; `tests/ui/auditor.spec.ts`
 * is the second, and it MEASURES the method matrix rather than assuming it (see the note below).
 *
 * WHAT "READ-ONLY" IS ASSERTED TO MEAN, precisely:
 *   * no module under `ui/src/routes/auditor/**` or `ui/src/components/auditor/**` imports the API's write functions, the
 *     HTTP client, or a mutation hook;
 *   * no module there declares an event handler at all — a read-only surface has nothing to handle;
 *   * the rendered auditor surfaces contain zero controls: no button, no input, no select, no form, and no link that
 *     points at a mutation path.
 *
 * A NOTE ON THE PLAN'S EXPECTED STATUS CODE, MEASURED RATHER THAN REPEATED. The plan says "every `/auditor` route
 * returns `405` for a write method". The built application is a static bundle served by `vite preview`, and MEASURED:
 * `POST`, `PUT`, `PATCH` and `DELETE` to `/auditor/claims` return **404**, not 405, while `GET` returns the SPA document
 * with 200. Reporting 405 would be repeating an expectation instead of a measurement, so the browser suite asserts what
 * the artefact actually does — the write methods are REFUSED with a client error and nothing is mutated — and this suite
 * carries the structural claim that no auditor module could mutate even if a request reached one.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { all, buildMirror, h, loadComponent, renderToDocument } from './render-support.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const UI_SRC = join(PROJECT_ROOT, 'ui', 'src');
const AUDITOR_ROOTS = [join(UI_SRC, 'routes'), join(UI_SRC, 'components', 'auditor')];

buildMirror();

type Component = (props: Record<string, unknown>) => unknown;
const auditor = await loadComponent<{ ClaimResolution: Component; EvidenceBundleList: Component }>(
  'components/auditor/AuditorSurfaces.tsx',
);

/** Every file the auditor view consists of: its route modules and its own components. */
function auditorFiles(): readonly { readonly path: string; readonly text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      // Only the auditor's own files: `components/auditor/**` plus the route modules whose name starts with `auditor.`.
      const isAuditorRoute = dir.endsWith(join('src', 'routes')) && entry.startsWith('auditor.');
      const isAuditorComponent = full.includes(join('components', 'auditor'));
      if (isAuditorRoute || isAuditorComponent) {
        out.push({ path: full.replace(`${PROJECT_ROOT}\\`, '').replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const root of AUDITOR_ROOTS) walk(root);
  return out;
}

describe('no auditor module can mutate anything (VG-UI-002)', () => {
  test('the auditor view consists of the files this suite reads', () => {
    const files = auditorFiles();
    assert.ok(files.length >= 5, `expected the auditor routes and components, found ${String(files.length)}`);
    assert.ok(files.some((file) => file.path.endsWith('routes/auditor.claims.tsx')));
    assert.ok(files.some((file) => file.path.endsWith('components/auditor/AuditorSurfaces.tsx')));
  });

  test('no auditor module imports a write path', () => {
    const offenders: string[] = [];
    for (const { path, text } of auditorFiles()) {
      for (const pattern of [
        /\.assessExposure\s*\(/,
        /\.createAppealEscalation\s*\(/,
        /\bclient\.post\b/,
        /\bportalClient\b/,
        /useMutation\b/,
        /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/,
      ]) {
        if (pattern.test(text)) offenders.push(`${path}: ${String(pattern)}`);
      }
    }
    assert.deepEqual(offenders, [], `an auditor module reaches a write path: ${offenders.join('; ')}`);
  });

  test('no auditor module declares an event handler, because it has nothing to handle', () => {
    const offenders: string[] = [];
    for (const { path, text } of auditorFiles()) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of [/\bon[A-Z][A-Za-z]+\s*=/, /addEventListener\s*\(/, /<form\b/, /type="submit"/]) {
        if (pattern.test(code)) offenders.push(`${path}: ${String(pattern)}`);
      }
    }
    assert.deepEqual(offenders, [], `an auditor module declares a handler or a form: ${offenders.join('; ')}`);
  });
});

describe('the rendered auditor surfaces contain zero controls', () => {
  test('a claim resolution table renders the whole chain and no control', () => {
    const doc = renderToDocument(
      h(auditor.ClaimResolution, {
        rows: [
          {
            claimId: 'cl-1',
            requirementIds: ['VG-EVIDENCE-001'],
            caseIds: ['case-1'],
            evidenceArtifactIds: ['ev-1'],
            digests: ['sha256:abc'],
          },
        ],
      }),
    );
    const text = textOf(doc);
    for (const part of ['cl-1', 'VG-EVIDENCE-001', 'case-1', 'ev-1', 'sha256:abc']) {
      assert.ok(text.includes(part), `the chain is missing ${part}`);
    }
    assert.deepEqual(
      all(doc, 'button, input, select, textarea, form, a[href]').map((control) => control.tagName),
      [],
      'the auditor claim view renders no control at all, not even navigation',
    );
  });

  test('an evidence bundle record list renders no download control', () => {
    const doc = renderToDocument(
      h(auditor.EvidenceBundleList, {
        rows: [
          {
            evidenceBundleId: 'bundle-1',
            actorReference: 'actor:OPAQUE-9',
            recordedAt: '2026-09-12T00:00:00Z',
            state: 'RECORDED',
            scopeDescription: 'one case, two artefacts',
          },
        ],
      }),
    );
    const text = textOf(doc);
    assert.match(text, /bundle-1/);
    assert.match(text, /does not produce a bundle/);
    assert.deepEqual(all(doc, 'button, input, form, a[href]').map((control) => control.tagName), []);
  });

  test('NEGATIVE CASE: an unresolved claim is refused rather than rendered with a blank field', () => {
    assert.throws(
      () =>
        renderDoc(
          h(auditor.ClaimResolution, {
            rows: [
              { claimId: 'cl-2', requirementIds: ['VG-EVIDENCE-001'], caseIds: [], evidenceArtifactIds: ['ev-1'], digests: [] },
            ],
          }),
        ),
      /does not resolve the whole chain/,
    );
  });
});

/** The accessible text of a rendered document. */
function textOf(doc: ReturnType<typeof renderToDocument>): string {
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Render and return the document, used where a throw is the assertion. */
function renderDoc(element: unknown): unknown {
  return renderToDocument(element);
}
