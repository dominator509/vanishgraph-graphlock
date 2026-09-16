/**
 * The declared route table (SPEC-004 §1, VG-UI-004).
 *
 * WHAT THIS FILE IS: the ONE place a route's existence is declared in code. `scripts/emit-route-manifest.ts` walks
 * `ui/src/routes/**` and derives the manifest from the FILES, and `tests/contract/route-manifest.test.ts` compares that
 * manifest against the 25 rows of SPEC-004 §1 **parsed from the specification file** — so a route added here without a
 * spec row fails, and a spec row without a page file fails, in both directions.
 *
 * WHY THE SURFACE IS DECLARED BESIDE THE PATH: VG-UI-001 says a job belongs to exactly one surface, and the surface is
 * what a later milestone's route-and-control inventory checks. Keeping it here means the inventory has a declared
 * source rather than inferring it from a path prefix.
 */

/** The four surfaces of SPEC-004 §1. */
export const SURFACES = ['portal', 'console', 'admin', 'auditor'] as const;

export type Surface = (typeof SURFACES)[number];

/**
 * The surface that owns a path.
 *
 * DERIVED FROM THE FIRST SEGMENT, and asserted against the specification's own table by the contract suite: §1 gives
 * every one of the 25 routes a surface, and every surface is exactly one first segment. A route whose prefix and
 * declared surface disagreed would be a job reachable from the wrong place (VG-UI-001).
 */
export function surfaceOf(path: string): Surface {
  const segment = path.split('/')[1] ?? '';
  if ((SURFACES as readonly string[]).includes(segment)) return segment as Surface;
  throw new Error(`route ${path} is not under a declared surface`);
}
