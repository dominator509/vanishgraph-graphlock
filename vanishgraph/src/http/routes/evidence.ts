/**
 * Evidence artifacts (SPEC-003 §5.12).
 *
 * TWO OF THE FIVE ROUTES READ, AND THE OTHER THREE NAME WHAT THEY ARE MISSING. That split is the honest state of
 * this repository, and each refusal is stated in the handler rather than left as an absent route so an operator gets
 * a dependency name instead of a 404:
 *
 *   * **§5.12.2 (metadata + `linkedTraceability`) and §5.12.5 (a case's artifacts)** are implemented. Both are reads
 *     over `evidence_artifact`, whose rows other nodes already reference by foreign key.
 *   * **§5.12.1 (upload)** needs TWO things this repository does not have: a multipart parser (§5.12.1's content
 *     type is `multipart/form-data`, and Fastify 5 does not parse it without a plugin — hand-rolling a multipart
 *     boundary parser for identity documents is not a thing to improvise) and an `EvidenceStore`
 *     implementation.
 *   * **§5.12.3 (content download)** needs the `EvidenceStore`, and it also cannot be made tenant-safe with the port
 *     as declared (see below).
 *   * **§5.12.4 (integrity check)** needs the `EvidenceStore` to recompute a digest over the stored bytes.
 *
 * THE `EvidenceStore` PORT HAS NO TENANT PARAMETER, AND THAT IS A FINDING RATHER THAN A DETAIL. Its declaration is
 * `put(content, digest)`, `get(digest)`, `verify(digest)` — content-addressed by digest alone. Two tenants that
 * upload identical bytes produce the SAME digest, so a store keyed only by digest cannot distinguish them: a
 * `get` for one tenant would return the other's object, and nothing in the port would notice. VG-TENANT-002 requires
 * tenant isolation to hold independently at each layer, so implementing this port as declared would put evidence
 * behind a cross-tenant read that the DATABASE RLS cannot cover, because the bytes are not in the database.
 * Extending the port (a tenant on every operation, or a tenant-namespaced digest) is a domain change with a
 * security consequence, and it is recorded in ASSUMPTIONS §3.38 for the node that owns the KMS/evidence story
 * rather than made quietly here.
 *
 * `redactionState` IS RETURNED VERBATIM. The column's CHECK admits `NONE|SCRUBBED|DENIED`; §5.12.1 declares
 * `UNREDACTED|DLP_SCRUBBED`. Translating here would hide the disagreement, so the route reports what is stored and
 * the conflict is recorded.
 */

import type { FastifyInstance } from 'fastify';

import type { EvidenceQueries } from '../../application/contracts/evidence-queries.ts';
import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam } from './handler-context.ts';
import { idempotentWrite } from './idempotent-write.ts';

export interface EvidenceRouteOptions {
  readonly queries: EvidenceQueries;
}

export function evidenceRoutes(app: FastifyInstance, options: EvidenceRouteOptions): void {
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.12.1 POST /v1/evidence-artifacts — upload. REFUSED: no multipart parser and no store.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/evidence-artifacts', async (request, reply) => {
    const h = beginHandler(request, reply);
    return idempotentWrite(h, async () => {
      void reply;
      throw apiError('DEPENDENCY_UNAVAILABLE', {
        reason:
          'artifact upload requires a multipart/form-data parser (Fastify 5 does not parse multipart without a plugin) and an EvidenceStore implementation; neither is present',
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.12.2 GET /v1/evidence-artifacts/{evidenceArtifactId} — metadata and the traceability chain.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/evidence-artifacts/:evidenceArtifactId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const evidenceArtifactId = uuidParam(request, 'evidenceArtifactId');

    return h.withTenant(async (tx) => {
      const artifact = await queries.getEvidenceArtifact(tx, evidenceArtifactId);
      // Absent and another tenant's artifact reach this same branch by construction (SPEC-006 H-9).
      if (artifact === undefined) throw apiError('RESOURCE_NOT_FOUND');
      // The digest is the entity's identity, and it is what a client caches against: an ETag derived from it
      // changes exactly when the artifact's content would, which for an immutable artifact is never.
      reply.header('etag', `"${artifact.digest}"`);
      return reply.code(200).send(artifact);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.12.3 GET /v1/evidence-artifacts/{evidenceArtifactId}/content — download. REFUSED: no store.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/evidence-artifacts/:evidenceArtifactId/content', async (request, reply) => {
    const h = beginHandler(request, reply);
    uuidParam(request, 'evidenceArtifactId');
    return h.withTenant(async () => {
      void reply;
      // The scope and step-up are enforced by `beginHandler` from the registry (vg.evidence.read_content +
      // step-up), so a caller reaching this line was authorised to ask. What cannot happen is the effect: reading
      // the bytes requires an `EvidenceStore`, and none exists — see the file header for why implementing the port
      // as declared would also open a cross-tenant read that the database cannot police.
      throw apiError('DEPENDENCY_UNAVAILABLE', {
        reason:
          'artifact content requires an EvidenceStore implementation, and the port as declared carries no tenant scope, so a digest-keyed store could not isolate tenants',
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.12.4 POST /v1/evidence-artifacts/{evidenceArtifactId}/integrity-checks — REFUSED: no store.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/evidence-artifacts/:evidenceArtifactId/integrity-checks', async (request, reply) => {
    const h = beginHandler(request, reply);
    const evidenceArtifactId = uuidParam(request, 'evidenceArtifactId');
    return idempotentWrite(h, async (tx) => {
      void reply;
      const artifact = await queries.getEvidenceArtifact(tx, evidenceArtifactId);
      // The artifact is resolved FIRST so a caller learns that it does not exist (404) rather than being told a
      // dependency is missing for a row that was never there.
      if (artifact === undefined) throw apiError('RESOURCE_NOT_FOUND');
      throw apiError('DEPENDENCY_UNAVAILABLE', {
        reason:
          'a fresh digest verification requires an EvidenceStore to recompute SHA-256 over the stored bytes; no store is configured, and reporting the STORED digest as "recomputed" would be a verification that verified nothing',
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.12.5 GET /v1/cases/{caseId}/evidence-artifacts — the artifacts bound to a case, never content.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/cases/:caseId/evidence-artifacts', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    return h.withTenant(async (tx) => {
      const rows = await queries.listCaseEvidenceArtifacts(tx, caseId);
      // `undefined` means the CASE does not resolve; `[]` means it does and has no artifacts. They are different
      // statements and are answered differently (SPEC-006 H-9).
      if (rows === undefined) throw apiError('RESOURCE_NOT_FOUND');
      return reply.code(200).send({ data: rows.map((row) => ({ ...row })) });
    });
  });
}
