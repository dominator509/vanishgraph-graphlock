/**
 * The `SUPPORT` gate: a request carrying the SUPPORT role without an ACTIVE session is refused, and the refusal is
 * audited (SPEC-005 §2 ROLE-2; EP-006 M6).
 *
 * THE ROLE IS NOT THE PERMISSION. Holding `SUPPORT` grants nothing on its own: ROLE-2 makes access just-in-time, so this
 * plugin refuses the request unless a live session exists for THIS tenant — and it refuses at the `preHandler`, before the
 * handler can read anything.
 *
 * A REFUSAL IS AUDITED, WHICH IS THE POINT OF THE REQUIREMENT: an attempt to use support access outside a session is the
 * signal the control exists to produce, and a refusal that left no trace would hide exactly that.
 *
 * IT DOES NOT CALL `done()` AFTER REFUSING. MEASURED in the step-up plugin: calling `done()` continues the chain, so the
 * handler runs on a refused request — which is the "refused after the work was done" failure this gate exists to prevent.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isLive, type AuditEvent, type SupportSession } from '../../application/security/support-access-service.ts';
import type { Clock } from '../../application/security/step-up-policy.ts';

export interface SupportAccessPluginOptions {
  readonly clock: Clock;
  /** The live session for a principal, if one exists. Supplied per request: a cache here would outlive the time box. */
  readonly sessionFor: (tenantId: string, actorIdentity: string) => SupportSession | undefined;
  /** Writes the audit row. Injected so the plugin does not depend on the audit store's implementation. */
  readonly audit: (event: AuditEvent) => void;
  /** How a refusal is written. It MUST send the reply; see the note in the module header. */
  readonly refuse: (request: FastifyRequest, reply: FastifyReply, code: string, detail: string) => void;
  /** Reads the verified identity from the request, defaulting to the identity plugin's own attachment. */
  readonly identityOf?: (request: FastifyRequest) => { readonly tenantId: string; readonly actorIdentity: string; readonly roles: readonly string[] } | undefined;
}

interface SupportClaims {
  readonly tenant_id?: string;
  readonly sub?: string;
  readonly roles?: readonly string[];
}

function defaultIdentity(request: FastifyRequest): SupportIdentity | undefined {
  const claims = (request as unknown as { identityClaims?: SupportClaims }).identityClaims;
  if (claims?.tenant_id === undefined || claims.sub === undefined) return undefined;
  return { tenantId: claims.tenant_id, actorIdentity: claims.sub, roles: claims.roles ?? [] };
}

interface SupportIdentity {
  readonly tenantId: string;
  readonly actorIdentity: string;
  readonly roles: readonly string[];
}

export function installSupportAccess(app: FastifyInstance, options: SupportAccessPluginOptions): void {
  const identityOf = options.identityOf ?? defaultIdentity;
  app.addHook('preHandler', (request, reply, done) => {
    const identity = identityOf(request);
    if (identity === undefined || !identity.roles.includes('SUPPORT')) {
      done();
      return;
    }
    const session = options.sessionFor(identity.tenantId, identity.actorIdentity);
    if (session !== undefined && isLive(session, options.clock)) {
      done();
      return;
    }
    options.audit({
      event: 'support.session.refused',
      actorIdentity: identity.actorIdentity,
      tenantId: identity.tenantId,
      detail:
        session === undefined
          ? 'a SUPPORT request arrived with no session: standing support access does not exist (ROLE-2)'
          : `a SUPPORT request arrived with session ${session.sessionId} in state ${session.state}`,
      at: options.clock() ?? 0,
    });
    options.refuse(
      request,
      reply,
      'SUPPORT_SESSION_REQUIRED',
      'SUPPORT access requires an ACTIVE, just-in-time session for this tenant; standing access does not exist (ROLE-2)',
    );
    // NO done(): continuing the chain would run the handler on a refused request.
    return;
  });
}

/** Whether a path is one a SUPPORT session may reach at all. Kept here so the gate does not depend on the registry. */
export function isSupportReachablePath(path: string): boolean {
  const withoutQuery = path.split('?')[0] ?? path;
  // SUPPORT is scoped to diagnostics: the subject read and the case read, and nothing that writes or exports.
  return withoutQuery.startsWith('/v1/subjects/') || withoutQuery.startsWith('/v1/cases/') || withoutQuery.startsWith('/v1/support/');
}
