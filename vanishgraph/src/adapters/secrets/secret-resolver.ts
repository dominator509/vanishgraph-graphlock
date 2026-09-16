/**
 * The workload-identity secret resolver (SPEC-005 §8; EP-006 M8).
 *
 * THE ONLY OUTBOUND CALL IS THE WORKLOAD-IDENTITY EXCHANGE, AND A FAILURE OF THAT EXCHANGE PRODUCES **ZERO** ATTEMPTS AT
 * ANYTHING ELSE. The suite proves it with an attempt counter and with a DECOY: a plaintext map is present and must never
 * be consulted on the failure path. A resolver that fell back to it would pass a test that only checked the returned code.
 *
 * EVERY ACCESS IS LOGGED WITH THE ACCESSING WORKLOAD IDENTITY, including a refusal — the log is where an unexpected
 * request for a secret is visible, and a refusal that left no trace would hide a workload probing for credentials it
 * should not hold.
 *
 * PROVIDER RUNNERS ARE ISOLATED BY PROVIDER AND ENVIRONMENT: a reference carries the provider it belongs to, and a
 * production identity asking for a staging or personal credential is refused rather than served (VG-AUTH-015).
 */

import { assertStaticSecretException } from '../../application/security/egress-gate.ts';
import type {
  SecretAccessLog,
  SecretReference,
  SecretResolution,
  SecretResolver,
  WorkloadIdentity,
} from '../../domain/ports/secret-resolver.ts';

/** The exchange with the workload-identity provider. Returning `undefined` models an unavailable provider. */
export type WorkloadIdentityExchange = (
  reference: string,
  identity: WorkloadIdentity,
) => Promise<{ readonly value: string; readonly expiresAt: string } | undefined>;

export interface WorkloadSecretResolverOptions {
  readonly exchange: WorkloadIdentityExchange;
  readonly now: () => string;
  /** Where access rows go. Injected so a test can assert what was logged. */
  readonly log: (row: SecretAccessLog) => void;
  /**
   * References this deployment knows. A reference outside the map is `SECRET_NOT_CONFIGURED` — the resolver does not
   * invent one, and it does not treat an unknown name as a workload-identity lookup.
   */
  readonly declaredReferences: readonly string[];
  /** Provider and environment each reference belongs to, so the isolation rule can be checked before any exchange. */
  readonly ownership: Readonly<Record<string, { readonly provider: string; readonly environment: string }>>;
  /** The plaintext map a resolver must NEVER fall back to. Present so the failure path can be proven not to touch it. */
  readonly decoyPlaintext?: Readonly<Record<string, string>> | undefined;
}

export class WorkloadSecretResolver implements SecretResolver {
  readonly #options: WorkloadSecretResolverOptions;

  constructor(options: WorkloadSecretResolverOptions) {
    this.#options = options;
  }

  async resolve(reference: SecretReference, identity: WorkloadIdentity): Promise<SecretResolution> {
    const at = this.#options.now();
    type RefusalCode = Extract<SecretResolution, { ok: false }>['code'];
    const refuse = (code: RefusalCode, detail: string): SecretResolution => {
      this.#options.log({ reference: reference.reference, workload: identity.workload, environment: identity.environment, outcome: 'refused', code, at });
      return { ok: false, code, detail };
    };

    if (!this.#options.declaredReferences.includes(reference.reference)) {
      return refuse('SECRET_NOT_CONFIGURED', `"${reference.reference}" is not a reference this deployment declares`);
    }

    if (reference.holding === 'STATIC') {
      try {
        assertStaticSecretException(reference.exception, at);
      } catch (error) {
        return refuse('STATIC_EXCEPTION_REQUIRED', error instanceof Error ? error.message : 'a static secret needs an exception');
      }
    }

    // ISOLATION BEFORE THE EXCHANGE: a production identity may not receive a staging or personal credential, and the
    // check runs here so a misconfigured request never leaves the process.
    const owner = this.#options.ownership[reference.reference];
    if (owner !== undefined && identity.environment === 'production' && owner.environment !== 'production') {
      return refuse(
        'SECRET_NOT_CONFIGURED',
        `"${reference.reference}" belongs to the ${owner.environment} environment, and a production workload identity may not hold it (VG-AUTH-015)`,
      );
    }
    if (owner !== undefined && identity.provider !== undefined && owner.provider !== identity.provider) {
      return refuse(
        'SECRET_NOT_CONFIGURED',
        `"${reference.reference}" belongs to provider ${owner.provider}, and this runner is the ${identity.provider} runner`,
      );
    }

    const resolved = await this.#options.exchange(reference.reference, identity);
    if (resolved === undefined) {
      // NO FALLBACK: the decoy map is deliberately not consulted, and the suite counts the attempts that were made.
      return refuse(
        'DEPENDENCY_UNAVAILABLE',
        'the workload-identity exchange did not return a value; there is no plaintext, .env, empty or cached fallback (VG-ERR-055)',
      );
    }
    this.#options.log({ reference: reference.reference, workload: identity.workload, environment: identity.environment, outcome: 'resolved', at });
    return { ok: true, reference: reference.reference, value: resolved.value, expiresAt: resolved.expiresAt };
  }
}

/**
 * The decoy, for the suite: it returns a value for every reference, and a resolver that consulted it on the failure path
 * would produce a secret where none was available.
 */
export function decoyPlaintext(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze({ ...values });
}

