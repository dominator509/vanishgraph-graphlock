/**
 * The SSRF target classifier and the only outbound fetch path (SPEC-000 VG-SEC-003/004; SPEC-006 §7.1 rows 21–23; EP-006 M9).
 *
 * **EVERY RESOLVED ADDRESS IS CLASSIFIED, AND ONE BAD ADDRESS REFUSES THE TARGET.** Classifying only the first address is
 * how a DNS name with two records — one public, one loopback — passes a check: the resolver's order is not a security
 * property, so a name that resolves to ANY refused address is refused entirely.
 *
 * THE SCHEME IS A CLOSED ALLOWLIST, and the check happens before resolution: a `file:` or `gopher:` URL has no host to
 * classify, and refusing it after trying to resolve a host would be a check that cannot run.
 *
 * THE CLOUD METADATA ADDRESSES ARE NAMED RATHER THAN RELIED ON: `169.254.169.254` is link-local and would be caught by the
 * range rule, but naming it means the refusal says what it was, which is what an operator needs when a workload starts
 * asking for instance credentials.
 */

export type TargetClass =
  | 'PUBLIC'
  | 'LOOPBACK'
  | 'PRIVATE'
  | 'LINK_LOCAL'
  | 'MULTICAST'
  | 'UNSPECIFIED'
  | 'CARRIER_GRADE_NAT'
  | 'CLOUD_METADATA';

export type SsrfRefusal = 'SCHEME_NOT_ALLOWED' | 'TARGET_REFUSED' | 'RESOLUTION_FAILED' | 'HOST_MISSING';

export interface SsrfDecision {
  readonly allow: boolean;
  readonly code?: SsrfRefusal;
  readonly detail: string;
  /** The classification of each resolved address, so a refusal can name every reason. */
  readonly classifications: readonly { readonly address: string; readonly targetClass: TargetClass }[];
  /** The number of connection attempts this decision produced. A refusal is always zero. */
  readonly connectionAttempts: number;
}

/** The schemes an external fetch may use. `http` is absent: a fetch carries credentials or content, never plaintext. */
export const ALLOWED_SCHEMES: readonly string[] = Object.freeze(['https:']);

/** The cloud metadata addresses, named so a refusal can say which one was asked for. */
export const CLOUD_METADATA_ADDRESSES: readonly string[] = Object.freeze([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
]);

/** Parse an IPv4 address into its four octets, or `undefined`. */
function ipv4Octets(address: string): readonly number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return undefined;
  return octets;
}

/** Classify one address. IPv6 forms are matched textually, which is enough for the ranges that matter here. */
export function classifyAddress(address: string): TargetClass {
  const normalised = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (CLOUD_METADATA_ADDRESSES.includes(normalised)) return 'CLOUD_METADATA';

  const octets = ipv4Octets(normalised);
  if (octets !== undefined) {
    const [first = 0, second = 0] = octets;
    if (first === 127) return 'LOOPBACK';
    if (first === 10) return 'PRIVATE';
    if (first === 172 && second >= 16 && second <= 31) return 'PRIVATE';
    if (first === 192 && second === 168) return 'PRIVATE';
    if (first === 169 && second === 254) return 'LINK_LOCAL';
    if (first === 100 && second >= 64 && second <= 127) return 'CARRIER_GRADE_NAT';
    if (first >= 224 && first <= 239) return 'MULTICAST';
    if (first === 0) return 'UNSPECIFIED';
    if (first >= 240) return 'UNSPECIFIED';
    return 'PUBLIC';
  }

  // IPv6: loopback, unspecified, link-local, unique-local and multicast are the ranges that matter.
  if (normalised === '::1' || normalised === '0:0:0:0:0:0:0:1') return 'LOOPBACK';
  if (normalised === '::' || normalised === '0:0:0:0:0:0:0:0') return 'UNSPECIFIED';
  if (normalised.startsWith('fe80:')) return 'LINK_LOCAL';
  if (normalised.startsWith('fc') || normalised.startsWith('fd')) return 'PRIVATE';
  if (normalised.startsWith('ff')) return 'MULTICAST';
  // An IPv4-mapped address is classified by the address it maps to, since that is what a connection would use.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (mapped?.[1] !== undefined) return classifyAddress(mapped[1]);
  return 'PUBLIC';
}

/** The classes that may never be fetched. `PUBLIC` is the only class that may. */
export function isRefusedClass(targetClass: TargetClass): boolean {
  return targetClass !== 'PUBLIC';
}

export interface TargetResolver {
  /** Resolve a hostname to every address it currently maps to. An empty list means the name did not resolve. */
  resolve(hostname: string): readonly string[];
}

export interface ClassifyOptions {
  readonly url: string;
  readonly resolver: TargetResolver;
  /** Whether a redirect may be followed. The default is NO, and the caller must opt in (the plan's rule). */
  readonly followRedirects?: boolean | undefined;
}

/** The host of a URL, or `undefined` when it has none. */
function hostOf(url: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(url);
  if (match === null) return undefined;
  const authority = match[2] ?? '';
  const withoutUserInfo = authority.includes('@') ? (authority.split('@').pop() ?? '') : authority;
  const host = withoutUserInfo.startsWith('[')
    ? (withoutUserInfo.slice(1, withoutUserInfo.indexOf(']')) || undefined)
    : (withoutUserInfo.split(':')[0] || undefined);
  return host;
}

/** The scheme of a URL, with its colon, or `undefined`. */
function schemeOf(url: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return match === null ? undefined : `${(match[1] ?? '').toLowerCase()}:`;
}

/**
 * Classify a target before any connection.
 *
 * THE ORDER IS: scheme, then host, then resolution, then EVERY address. A refusal at any step produces zero connection
 * attempts, and the classifications are returned even on success so a caller can log what it was allowed to reach.
 */
export function classifyTarget(options: ClassifyOptions): SsrfDecision {
  const scheme = schemeOf(options.url);
  if (scheme === undefined || !ALLOWED_SCHEMES.includes(scheme)) {
    return {
      allow: false,
      code: 'SCHEME_NOT_ALLOWED',
      detail: `${options.url} does not use an allowed scheme (${ALLOWED_SCHEMES.join(', ')}); the scheme is checked before resolution because a URL with no host has nothing to classify`,
      classifications: [],
      connectionAttempts: 0,
    };
  }
  const host = hostOf(options.url);
  if (host === undefined) {
    return { allow: false, code: 'HOST_MISSING', detail: `${options.url} has no host`, classifications: [], connectionAttempts: 0 };
  }

  // A LITERAL ADDRESS IS CLASSIFIED WITHOUT RESOLUTION; a name is resolved and every address classified.
  const literal = classifyAddress(host);
  const addresses = ipv4Octets(host) !== undefined || host.includes(':') || CLOUD_METADATA_ADDRESSES.includes(host.toLowerCase())
    ? [host]
    : options.resolver.resolve(host);
  if (addresses.length === 0) {
    return {
      allow: false,
      code: 'RESOLUTION_FAILED',
      detail: `${host} did not resolve, and a target that cannot be classified cannot be fetched`,
      classifications: [],
      connectionAttempts: 0,
    };
  }
  void literal;

  const classifications = addresses.map((address) => ({ address, targetClass: classifyAddress(address) }));
  const refused = classifications.filter((entry) => isRefusedClass(entry.targetClass));
  if (refused.length > 0) {
    return {
      allow: false,
      code: 'TARGET_REFUSED',
      detail: `${host} resolves to ${refused.map((entry) => `${entry.address} (${entry.targetClass})`).join(', ')}; one refused address refuses the target, because the resolver's order is not a security property`,
      classifications,
      connectionAttempts: 0,
    };
  }
  return { allow: true, detail: `${host} resolves only to public addresses`, classifications, connectionAttempts: 1 };
}
