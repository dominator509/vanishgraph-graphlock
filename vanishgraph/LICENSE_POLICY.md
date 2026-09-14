# License policy

## Our licence

VanishGraph is **Apache-2.0** (`LICENSE`, ADR-014). Apache-2.0 was chosen for the
explicit patent grant in §3 — a security tool that others are asked to trust should
not leave patent risk unresolved — and because it is licence-compatible with every
component in the stack (`ARCHITECTURE.md` §4).

Consequences that bind contributors:

- Modified files must carry a prominent change notice (Apache-2.0 §4b).
- A distributed `NOTICE` file must be preserved and reproduced (§4d).
- The copyright holder name in `NOTICE` is **not yet recorded**; it requires the
  owner's decision and must be set before any public release (`DECISIONS.md` §5).

## Third-party code and data

Every dependency must be pinned to an exact revision and carry:

1. SPDX identifier and full licence text;
2. provenance (upstream URL, revision, retrieval date);
3. attribution and NOTICE obligations;
4. security review of the pinned revision;
5. confirmation of commercial **and** open-source compatibility.

An SBOM is generated for every release (EP-009) and must reconcile against the
lockfile. A licence finding at any gate blocks the release (`DOD-021`).

### Compatibility

| Licence | Verdict |
|---|---|
| Apache-2.0, MIT, BSD-2/3-Clause, ISC, PostgreSQL, MPL-2.0 | **Permitted.** MPL-2.0 only as an unmodified separate service or library, never as copy-pasted source. |
| CC0-1.0, CC BY 4.0 (data) | **Permitted with attribution.** |
| CC BY-NC-SA 4.0 (data or code) | **FORBIDDEN.** Non-commercial and ShareAlike terms are incompatible with this project's open-source distribution and with any commercial self-hosting. |
| AGPL-3.0, SSPL, BUSL, "fair source", Elastic Licence | **FORBIDDEN for incorporation.** May only be operated as a separate network service, and only after explicit review of the network-copyleft obligation. |
| No licence stated / "all rights reserved" | **FORBIDDEN.** Public visibility on a hosting platform is not permission to reuse. |

### Specifically forbidden sources

Unchanged by the move to Apache-2.0 — **an open-source licence for our code grants no
rights to anyone else's data**:

- `optery/optery-data-brokers-directory` — CC BY-NC-SA 4.0.
- `DrCaiola/optout` — CC BY-NC-SA, itself derived from a non-commercial ShareAlike source.
- `Enthropic-Data-LLC/data-removal` — README states private, all rights reserved.

### Permitted research inputs

- `Persprotect/data-broker-opt-out-list` — CC BY 4.0, commercial adaptation permitted
  **with attribution**. Usable as bootstrap seed data, but every actionable row must
  still be revalidated against current official controller pages and regulator
  registries before use (`PROJECT_RESEARCH_BRIEF.md` §5). Attribution must appear in
  `NOTICE`.
- `Olli0103/rightout` (MIT), `txssseal/broker-scrub` (MIT),
  `moderatedan/DataBrokerOptOut` (MIT) — acceptable as design references. Reuse of
  code requires the provenance and review steps above; low project maturity means
  reuse is discouraged in favour of independent implementation.

### First-party content

The embedded security test source library under
`.agent/verification/source-library/` is first-party generated pack content. Its
provenance and licence status must be confirmed before it is redistributed in a
public release, because it embeds material derived from third-party test prompt
collections.

## Enforcement

- `python3 scripts/anti-gaming-scan.py .` runs in every verification pass.
- Dependency and licence scanning is a mandatory gate (`scripts/dependency-audit.sh`),
  currently a loud-fail placeholder and implemented in EP-001/EP-009.
- An unreviewed dependency is a release blocker, not a follow-up item.
