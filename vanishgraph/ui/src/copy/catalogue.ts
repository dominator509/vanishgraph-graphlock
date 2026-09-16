/**
 * The copy catalogue (SPEC-004 §2, §11, §14; EP-005 M2).
 *
 * WHY A CATALOGUE EXISTS AT ALL. VG-UI-080 requires the copy-lint gate to scan "every message template reachable from
 * the UI", and VG-UI-082 requires it to scan page titles and meta descriptions as well as visible body text — the rule
 * exists because a gate that only reads body text misses exactly the places a permanent claim would survive. This module
 * is where those strings are DECLARED, so the gate has one file to read for templates, titles and empty states, and so a
 * later milestone adding a page has an obvious place to put its title rather than writing one inline.
 *
 * IT CONTAINS NO TRUTH-STATE COPY. The eleven labels and qualifiers live in `./truth-state.ts` and nowhere else
 * (VG-UI-007); duplicating even one of them here would create the second mapping the requirement forbids.
 */

/** A page's metadata, as the document head renders it. */
export interface PageMetadata {
  readonly title: string;
  readonly description: string;
}

/**
 * Page titles and meta descriptions, keyed by route.
 *
 * THEY ARE DELIBERATELY PLAIN AND THEY MAKE NO CLAIM ABOUT OUTCOMES. A title is the text a user sees in a browser tab,
 * a bookmark and a search result — the place where a permanent claim would travel furthest after leaving the
 * application — so every one of them names the SURFACE or the ACTION and never a result.
 */
export const PAGE_METADATA: Readonly<Record<string, PageMetadata>> = Object.freeze({
  '/portal': { title: 'Your privacy requests', description: 'Review what was found and what has been done.' },
  '/portal/authority': { title: 'Your authority grants', description: 'Who may act for you, and with what scope.' },
  '/portal/onboarding': { title: 'Getting started', description: 'Verify your identity and set up your request.' },
  '/portal/exposures': { title: 'Records found', description: 'Review each record and confirm or reject the match.' },
  '/portal/alerts': { title: 'New activity', description: 'Records observed again after a verification.' },
  '/portal/requests': { title: 'Ask for a human review', description: 'Escalate a case to a person.' },
  '/portal/limitations': { title: 'What this service can and cannot do', description: 'The limits of the service, stated plainly.' },
  '/console/queue': { title: 'Case queue', description: 'Work the open cases for this tenant.' },
  '/console/gates': { title: 'Human gates', description: 'Cases that need a person to decide.' },
  '/console/recipes': { title: 'Recipes and sources', description: 'Check recipe freshness and source permissions.' },
  '/console/coverage': { title: 'Coverage reports', description: 'What was checked, and what was not.' },
  '/admin/tenant': { title: 'Tenant settings', description: 'Configure this tenant.' },
  '/admin/policy': { title: 'Policy versions', description: 'Which policy applies in which jurisdiction.' },
  '/admin/authority': { title: 'Authority records', description: 'Issue and revoke authority.' },
  '/admin/catalog': { title: 'Source catalogue', description: 'Which sources and recipes are enabled.' },
  '/admin/users': { title: 'Users and roles', description: 'Who can do what in this tenant.' },
  '/admin/metrics': { title: 'Removal-effectiveness metric', description: 'The primary metric, with its denominator and interval.' },
  '/auditor/claims': { title: 'Claim resolution', description: 'Requirement to case to artifact to digest.' },
  '/auditor/exports': { title: 'Evidence bundle requests', description: 'Request a read-only evidence bundle.' },
});

/**
 * The empty states, by collection.
 *
 * AN EMPTY STATE IS A STATEMENT ABOUT A SEARCH, NOT ABOUT THE WORLD. "No records found" is true of a query and false as
 * a claim about a person's data, so every one of these names the SCOPE it is empty within, and the coverage-bearing ones
 * say that the answer is bounded. This is VG-UI-012's rule at the copy layer.
 */
export const EMPTY_STATES: Readonly<Record<string, string>> = Object.freeze({
  'portal.exposures':
    'No records were found in the coverage shown here. Coverage was partial: the Sources that were checked, and those that were not, are listed with this result.',
  'portal.alerts': 'No new activity has been observed for this subject within the window shown.',
  'console.queue': 'No cases are open in this tenant for the filters applied.',
  'console.gates': 'No human gates are waiting for a decision right now.',
  'console.coverage': 'No coverage reports exist for the filters applied.',
  'auditor.claims': 'No claim resolves within the filters applied.',
});
