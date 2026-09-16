#!/usr/bin/env node
/**
 * The OpenAPI 3.1 document, generated from the route registry (SPEC-003 §6, §5; EP-004 M8).
 *
 * WHAT THIS DOCUMENT IS, AND WHAT IT HONESTLY IS NOT.
 *
 * It is generated from `ROUTES` and `WEBHOOK_ROUTES` — the same declarations the server registers handlers from and
 * the gates assert against — so it cannot drift from the routes that exist: a path in the document is a path with a
 * handler, and a scope in the document is the scope `beginHandler` enforces.
 *
 * It is NOT a complete description of the request and response BODIES. MEASURED: this codebase declares no JSON
 * Schemas at all — `schema:` appears in `src/http` only in prose and in the query parser's parameter name, because
 * bodies are parsed and validated by hand at the boundary. A document that invented body schemas would be a SECOND
 * source of truth for shapes the handlers enforce, and the second source is the one that drifts. What the document
 * carries instead is the part that IS declared: paths, methods, the required scopes and step-up, the idempotency
 * requirement, the success status, and the QUERY parameters where a `QuerySchema` exists.
 *
 * THE VOCABULARY GATE SCANS THIS DOCUMENT AND THE DECLARATIONS BESIDE IT, which is why a partial document is still
 * useful: the tokens a caller sees are path segments, parameter names, scope names and enum values, and every one of
 * those is present here. Body FIELD names live in the DTO declarations the gate also scans.
 */

import { ROUTES, SCOPES, WEBHOOK_ROUTES, type RouteDefinition } from './registry.ts';
import {
  AUDIT_EVENTS_QUERY,
  CASES_QUERY,
  CANDIDATE_RECORDS_QUERY,
  COVERAGE_REPORTS_QUERY,
  EXPOSURES_QUERY,
  REAPPEARANCES_QUERY,
  RECIPES_QUERY,
  REMOVAL_EFFECTIVENESS_QUERY,
  SOURCES_QUERY,
  SUBJECTS_QUERY,
} from '../query/filters.ts';
import type { QuerySchema } from '../query/strict.ts';

/** The query declaration for a route, where one exists. A route with none has no query surface. */
const QUERY_SCHEMAS: Readonly<Record<string, QuerySchema>> = {
  '5.1.2': SUBJECTS_QUERY,
  '5.4.4': CANDIDATE_RECORDS_QUERY,
  '5.5.1': EXPOSURES_QUERY,
  '5.7.2': CASES_QUERY,
  '5.11.2': REAPPEARANCES_QUERY,
  '5.15.1': AUDIT_EVENTS_QUERY,
  '5.16.1': COVERAGE_REPORTS_QUERY,
  '5.16.3': REMOVAL_EFFECTIVENESS_QUERY,
  '5.3.2': SOURCES_QUERY,
  '5.3.8': RECIPES_QUERY,
};

/** A route path in OpenAPI form: `:param` becomes `{param}`, which is what the registry already uses. */
function openApiPath(route: RouteDefinition): string {
  return route.path;
}

function queryParameters(schema: QuerySchema | undefined): readonly Record<string, unknown>[] {
  if (schema === undefined) return [];
  const parameters: Record<string, unknown>[] = [];
  for (const [name, spec] of Object.entries(schema.parameters) as [string, QuerySchema['parameters'][string]][]) {
    parameters.push({
      name,
      in: 'query',
      required: false,
      schema: {
        type: spec.type === 'integer' || spec.type === 'number' ? 'number' : 'string',
        ...(spec.values === undefined ? {} : { enum: [...spec.values] }),
      },
    });
  }
  if (schema.paginated) {
    for (const name of ['limit', 'cursor']) {
      if (!parameters.some((parameter) => parameter['name'] === name)) {
        parameters.push({ name, in: 'query', required: false, schema: { type: 'string' } });
      }
    }
  }
  if (schema.sortFields.length > 0) {
    parameters.push({
      name: 'sort',
      in: 'query',
      required: false,
      schema: { type: 'string', enum: schema.sortFields.flatMap((field) => [`${field}:asc`, `${field}:desc`]) },
    });
  }
  if (schema.timeFilterable) {
    for (const name of ['from', 'to']) {
      parameters.push({ name, in: 'query', required: schema.requireTimeRange === true, schema: { type: 'string' } });
    }
  }
  return parameters;
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: Record<string, unknown>;
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: Record<string, unknown>;
}

export function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const path = openApiPath(route);
    const method = route.method.toLowerCase();
    paths[path] = {
      ...(paths[path] ?? {}),
      [method]: {
        operationId: route.id,
        summary: `${route.id} — ${route.group}`,
        // The scopes and the step-up requirement are what `beginHandler` enforces from this same row, so a client
        // reading them is reading the rule rather than a description of it.
        security: [{ bearerAuth: [...route.scopes] }],
        'x-vg-step-up': route.stepUp ?? false,
        'x-vg-idempotency': route.idempotency,
        'x-vg-serves': [...route.serves],
        ...(route.conditional === undefined ? {} : { 'x-vg-conditional': route.conditional }),
        parameters: queryParameters(QUERY_SCHEMAS[route.id]),
        responses: {
          [String(route.successStatus)]: { description: `${route.id} success` },
          default: { description: 'Error envelope (SPEC-003 §8)' },
        },
      },
    };
  }
  for (const route of WEBHOOK_ROUTES) {
    const path = route.path;
    paths[path] = {
      ...(paths[path] ?? {}),
      [route.method.toLowerCase()]: {
        operationId: route.id,
        summary: `${route.id} — webhook ingress`,
        // NO `security`: §6's ingress is authenticated by signature and a capability, not by a bearer scope, and
        // emitting a scope here would advertise a credential no token can carry (§3.3 keeps `vg.webhooks.ingest` out
        // of the vocabulary on purpose).
        'x-vg-authentication': 'signature+capability',
        responses: { '202': { description: 'accepted' }, default: { description: 'Error envelope' } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'VanishGraph',
      version: '0.1.0',
      description:
        'Generated from the route registry. Body schemas are deliberately absent: this codebase validates request ' +
        'bodies by hand, and a generated schema would be a second source of truth for shapes the handlers enforce.',
    },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: `Scopes are the closed §3.3 vocabulary: ${SCOPES.join(', ')}`,
        },
      },
    },
  };
}

/** Printed when this module is run directly, so `scripts/copy-lint-gate.sh` can scan the artefact. */
if (import.meta.filename === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
}
