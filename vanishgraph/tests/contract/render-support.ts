/**
 * A render harness for the UI components (EP-005 M3).
 *
 * WHY A HARNESS IS NEEDED AT ALL. `node --test` strips TypeScript types natively, which is why the API suites need no
 * build step — but JSX is not an erasable type feature, so a `.tsx` module cannot be imported by the test runner
 * directly. The plan's fallback is explicit: assert the properties against the components' RENDERED OUTPUT in a
 * Node-based render harness rather than weakening the assertion to a source-text grep, because "a source grep is not an
 * oracle (SPEC-004 §0.2)".
 *
 * HOW IT WORKS, AND WHY IT IS THIS SHAPE. The TypeScript compiler API — already a pinned devDependency, the same one
 * `tsc -p tsconfig.ui.json` uses — transpiles `ui/src/**` into a mirror directory, which is then imported and rendered
 * with `react-dom/server` under JSDOM. Three measured constraints fixed the details:
 *
 *   1. THE MIRROR CANNOT LIVE UNDER `node_modules`. MEASURED: Node refuses type stripping below `node_modules`
 *      (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and the mirror must not live outside the project either, or the
 *      components' bare imports (`react/jsx-runtime`) would not resolve. It sits at `.cache-ui-render/` in the project
 *      root: ignored by git, outside the copy-lint gate's scanned surface (`ui/src` and `ui/dist`), and inside the
 *      resolution path of `node_modules`.
 *   2. THE EMITTED JAVASCRIPT KEEPS TYPESCRIPT SPECIFIERS. The components import `'../../copy/truth-state.ts'`, so every
 *      relative specifier is rewritten to `.js` in the mirror. The rewrite is exact rather than approximate because this
 *      codebase requires explicit extensions on every relative import (`allowImportingTsExtensions`).
 *   3. THE ROOT TSCONFIG HAS NO DOM LIB, AND THAT IS DELIBERATE. `tsconfig.json` covers `tests/**` with `lib: ["ES2023"]`
 *      so the API layer cannot see browser globals. This harness therefore declares the SLICE OF THE DOM IT USES
 *      structurally, and loads JSDOM/React through `createRequire` rather than an import declaration, instead of widening
 *      the API's type environment for a test's convenience.
 *
 * WHAT THIS HARNESS DOES NOT VERIFY, STATED PLAINLY: it does not type-check the props it passes. Component prop types are
 * checked by `tsc -p tsconfig.ui.json` in `sh scripts/gate-ui.sh`; this harness verifies BEHAVIOUR — what the components
 * render for a given input — and every value it passes is asserted in the rendered output, so a mistyped prop name shows
 * up as a missing value rather than as a silent pass.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const UI_SRC = join(PROJECT_ROOT, 'ui', 'src');
const MIRROR = join(PROJECT_ROOT, '.cache-ui-render', 'ui-src');

const require = createRequire(import.meta.url);

/** The DOM surface this oracle uses, declared structurally (see note 3 above). */
export interface RenderedElement {
  readonly parentElement: RenderedElement | null;
  readonly textContent: string | null;
  readonly tagName: string;
  readonly children: ArrayLike<RenderedElement>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selectors: string): RenderedElement | null;
  matches(selectors: string): boolean;
  querySelector(selectors: string): RenderedElement | null;
  querySelectorAll(selectors: string): ArrayLike<RenderedElement>;
}

export interface RenderedTextNode {
  readonly nodeValue: string | null;
  readonly parentElement: RenderedElement | null;
}

export interface RenderedDocument {
  readonly body: RenderedElement;
  querySelector(selectors: string): RenderedElement | null;
  querySelectorAll(selectors: string): ArrayLike<RenderedElement>;
  createTreeWalker(root: RenderedElement, whatToShow: number): { nextNode(): RenderedTextNode | null };
}

type ElementFactory = (
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: readonly unknown[]
) => unknown;

const react = require('react') as { createElement: ElementFactory };

/** Build an element tree with the real React runtime, so the components render exactly as they do in the browser. */
export function h(
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: readonly unknown[]
): unknown {
  return react.createElement(type, props, ...children);
}

const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  // The UI sources mark type-only imports with `import type` (verbatimModuleSyntax is on), so eliding them here is the
  // same decision the real build makes rather than a test-only relaxation.
  verbatimModuleSyntax: false,
  isolatedModules: true,
};

/** Rewrite `'./x.ts'` / `'./x.tsx'` to `'./x.js'`, for both static and dynamic imports. */
function rewriteSpecifiers(code: string): string {
  return code.replace(/((?:from|import)\s*\(?\s*['"][^'"]+)\.tsx?(['"])/g, '$1.js$2');
}

function transpiled(absolutePath: string): string {
  const source = readFileSync(absolutePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: TRANSPILE_OPTIONS,
    fileName: absolutePath,
  });
  const first = output.diagnostics?.[0];
  if (first !== undefined) {
    throw new Error(
      `render harness: ${absolutePath} did not transpile: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`,
    );
  }
  return rewriteSpecifiers(output.outputText);
}

/** Mirror `ui/src/**` into a directory Node can load: `.ts`/`.tsx` in, `.js` out. */
export function buildMirror(): string {
  rmSync(MIRROR, { recursive: true, force: true });
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      const target = join(MIRROR, full.slice(UI_SRC.length + 1)).replace(/\.tsx?$/, '.js');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, transpiled(full));
    }
  };
  walk(UI_SRC);
  return MIRROR;
}

/** Load one component module from the mirror. `relative` is a path under `ui/src`, e.g. `components/truth/X.tsx`. */
export async function loadComponent<T>(relative: string): Promise<T> {
  if (statSync(MIRROR, { throwIfNoEntry: false }) === undefined) buildMirror();
  const target = join(MIRROR, relative).replace(/\.tsx?$/, '.js');
  return (await import(`file:///${target.replace(/\\/g, '/')}`)) as T;
}

/** Render an element tree to static markup. */
export function renderToHtml(element: unknown): string {
  const { renderToStaticMarkup } = require('react-dom/server') as {
    renderToStaticMarkup: (input: unknown) => string;
  };
  return renderToStaticMarkup(element);
}

/** Parse rendered markup into a document whose APIs the assertions can query. */
export function renderToDocument(element: unknown): RenderedDocument {
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => { window: { document: RenderedDocument } } };
  return new JSDOM(`<!doctype html><html><body>${renderToHtml(element)}</body></html>`).window.document;
}

/** All elements matching `selectors`, as an array (JSDOM returns an array-like NodeList). */
export function all(root: RenderedDocument | RenderedElement, selectors: string): RenderedElement[] {
  return Array.from(root.querySelectorAll(selectors) as ArrayLike<RenderedElement>);
}

export function one(root: RenderedDocument | RenderedElement, selectors: string): RenderedElement {
  const found = root.querySelector(selectors);
  if (found === null) throw new Error(`render harness: nothing matches ${selectors}`);
  return found;
}

/**
 * Every text node in the document, in DOM order, with the element that holds it.
 *
 * This is the primitive the coverage assertions are built on: VG-UI-018 is a statement about TEXT NODES, not about
 * attributes, and a scan that read only element text content could not tell a percentage rendered inside a metric figure
 * from one written by hand in a paragraph.
 */
export function textNodes(doc: RenderedDocument): readonly { readonly text: string; readonly parent: RenderedElement }[] {
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const out: { text: string; parent: RenderedElement }[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null) continue;
    out.push({ text: node.nodeValue ?? '', parent });
  }
  return out;
}

/** The accessible text of a subtree, as a screen reader would read it: text nodes joined, whitespace normalised. */
export function accessibleText(element: RenderedElement | null): string {
  if (element === null) return '';
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}
