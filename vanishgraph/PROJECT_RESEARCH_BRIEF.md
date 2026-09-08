# VanishGraph Privacy Removal OS - Project Research Brief

Research date: 2026-08-28
Purpose: Dated pre-generation research for the project-specific GraphLock v3.1 input pack. This file informs architecture and scope; volatile facts must be revalidated in PREFLIGHT before a future build begins.

## 1. Executive conclusions

1. The category baseline has moved beyond a static list of opt-out links. Mature competitors advertise hundreds to nearly one thousand sources, recurring rescans, custom removals, search-engine cleanup, proof/screenshots, aliases, family/business plans, and escalation. A defensible new product therefore needs a materially stronger trust and evidence model rather than merely claiming a larger broker count.
2. The core differentiator should be an Identity Exposure Graph plus a deterministic Universal Removal State Machine. Every discovered record is evidence with provenance and confidence. Every removal is a durable case with typed states. "Request sent", "controller says deleted", "source independently absent", and "search result removed" remain distinct.
3. California's DROP is now operational and materially changes the US workflow. It should be a first-class centralized channel but not a substitute for direct removals, non-registered sources, search-index cleanup, or independent verification.
4. Google explicitly distinguishes removal from Search from removal at the source. VanishGraph must track those as separate effects and never collapse them into one success state.
5. Official subscription-backed LLM transports are feasible for some providers, but only through the provider's documented products. OpenAI Codex, Anthropic Claude Code, and xAI Grok Build currently expose supported sign-in plus noninteractive/agent interfaces suitable for an isolated provider-transport layer. This does not create a right to pool/resell consumer subscriptions or call undocumented consumer-chat endpoints.
6. Google changed the consumer CLI landscape in June 2026: Login with Google for Gemini CLI consumer tiers was deprecated. The Google adapter must therefore be discovery-gated rather than treated as guaranteed subscription transport.
7. The open-source landscape contains both useful permissive components and serious licensing traps. Commercial code/data ingestion must be gated by pinned-revision license/provenance checks.
8. CAPTCHA/OTP/access-control bypass is a poor foundation for a durable commercial privacy service. The safer architecture is to detect human/provider gates, pause safely, or choose another official channel such as email, authorized-agent request, centralized portal, or certified mail.
9. Physical certified mail is automatable through multiple commercial providers, but postage/fulfillment is inherently paid. Open-source-first means the document/state/evidence layer remains ours, with pluggable Lob/Click2Mail/PostGrid adapters and a manual print/export fallback.
10. The bug-to-PR loop can be highly autonomous without risking customer privacy if crash evidence is DLP-sanitized before it leaves the production security domain, and if coding agents operate in isolated worktrees with draft-PR-only authority for sensitive changes.

## 2. Market baseline and product gap

### Optery
Publicly advertises broad broker coverage, automated plus custom removals, recurring scanning, before/after evidence, search-engine cleanup, and enterprise controls. Treat this as table-stakes research only; do not copy proprietary recipes/content.
Source: https://www.optery.com/

### DeleteMe
Its public coverage page stated 986 data brokers and was updated 2026-07-30. It also advertises custom removals and established recurring service. Broker count alone is therefore not a sufficient differentiator.
Source: https://joindeleteme.com/sites-we-remove-from/

### Google Results About You
Google supports monitoring/removal requests for certain personal information in Search, but clearly notes that removal from Google Search does not remove the information from the source webpage. VanishGraph must model two separate outcomes.
Source: https://support.google.com/websearch/answer/12719076?hl=en

### Category implication
Required v1 table stakes:
- Continuous/recurring monitoring.
- Aliases and historical identifiers.
- Broad data-broker/people-search coverage.
- Custom URL removals.
- Evidence before/after action.
- Search-engine/index cleanup as a separate lane.
- Household/family authorization.
- Enterprise controls and reporting.
- Reappearance detection and re-removal.

Differentiation target:
- Evidence-first identity matching and provenance.
- Transparent coverage/uncertainty instead of "we scanned the Internet" theater.
- Deterministic action state machine.
- Jurisdiction-aware legal policy layer.
- Multi-channel action selection including certified mail.
- Independent verification after controller acknowledgment.
- Upstream/source-lineage analysis for recurring exposure.
- Provider-permission/TOS matrix and stale-recipe quarantine.
- PII-aware model routing and provider-authorized subscription transports.
- GraphLock-grade bug/remediation and release evidence.

## 3. California DROP and privacy-rights workflow

California Privacy Protection Agency guidance says data brokers must access DROP on the regulator-defined cadence and that brokers began processing deletion requests through DROP on 2026-08-01. This creates a high-leverage channel for California-eligible consumers, but it does not prove that every public page or search result has disappeared.
Source: https://cppa.ca.gov/data_brokers/index.html

Design consequences:
- Model DROP filing/status as an external channel with its own evidence.
- Keep direct source discovery/removal and post-DROP verification running.
- Do not label DROP submission or portal status as independent source deletion proof.
- Version legal effective dates and response windows in a policy data model, not in LLM prompts.
- Support authorized-agent evidence where current law/process permits it, but require actual subject authority.

## 4. LLM provider transport research

### OpenAI Codex
Current OpenAI documentation states that Codex supports "Sign in with ChatGPT for subscription access" as well as API-key usage. Codex CLI supports browser sign-in, cached/refreshing sessions, and enterprise access-token/workload-identity patterns for trusted automation.
Source: https://learn.chatgpt.com/docs/auth

Architecture decision:
- Implement a Codex transporter on an isolated private runner using official Codex auth and documented noninteractive execution/app-server surfaces.
- Never scrape ChatGPT browser cookies or reverse-engineer chat endpoints.
- For shared SaaS workloads, do not assume a consumer subscription can be pooled or resold; use a customer/org-authorized transport, enterprise mechanism, self-hosted model, or paid API.

### Anthropic Claude Code
Claude Code provides a documented CLI with noninteractive execution and supports authenticated Claude account/subscription and enterprise/provider deployment paths.
Source: https://code.claude.com/docs/en/cli-usage

Architecture decision:
- Implement Claude Code as an official CLI/subscription transporter where plan and provider rules authorize it.
- Keep Anthropic API/Bedrock/Vertex as explicit fallbacks, not hidden cost paths.

### xAI Grok Build
xAI documents Grok Build as a coding/agent product with browser authentication, headless scripting/bot use, ACP, and enterprise OIDC/device-code options.
Sources:
- https://docs.x.ai/build/overview
- https://docs.x.ai/build/enterprise

Architecture decision:
- Implement Grok Build via its official auth and headless/ACP interface.
- Treat credentials as isolated provider-runner secrets, not tokens copied into ordinary app databases.

### Google Gemini / Antigravity
Google documented that on 2026-06-18 Gemini Code Assist consumer tiers stopped serving requests through the Gemini CLI/IDE path and Login with Google was no longer available there for consumer accounts, directing users toward Antigravity products. Enterprise Code Assist was not affected in the same way.
Source: https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals

Architecture decision:
- Do not hardcode a Gemini consumer OAuth transporter.
- At build time, discover the then-current supported Antigravity/Enterprise/Vertex mechanism and enable only if entitlement and automation terms are explicit.

### Common Provider Transport Layer rules
Every provider adapter exposes:
- `auth_mode`
- `subscription_or_usage_billing`
- `official_automation_surface`
- `noninteractive_capability`
- `structured_output`
- `MCP_or_tool_support`
- `PII_egress_class`
- `retention/data_control_profile`
- `rate/quota state`
- `health`
- `cost attribution`

Forbidden transport behaviors:
- Browser-cookie/session theft.
- Token extraction from unrelated users.
- Undocumented private chat endpoints.
- CAPTCHA or access-control bypass.
- Consumer subscription pooling/resale unless the provider explicitly authorizes it.
- Sending raw customer PII to a third-party model merely because it is convenient.

## 5. Open-source and licensing research

### Strong infrastructure candidates
- Playwright - Apache-2.0; browser automation.
  https://github.com/microsoft/playwright
- Crawlee - Apache-2.0; crawl/browser orchestration.
  https://github.com/apify/crawlee
- Temporal - MIT server; durable workflow/state/retry/timer engine.
  https://github.com/temporalio/temporal
- pgvector - PostgreSQL License; bounded vector similarity in Postgres.
  https://github.com/pgvector/pgvector
- Keycloak - Apache-2.0; identity and access management.
  https://github.com/keycloak/keycloak
- Valkey - BSD-3-Clause core; ephemeral cache/rate-limit/coordination.
  https://github.com/valkey-io/valkey
- SeaweedFS - Apache-2.0; S3-compatible storage option.
  https://github.com/seaweedfs/seaweedfs
- GlitchTip - MIT backend; Sentry-compatible open-source error/crash option.
  https://gitlab.com/glitchtip/glitchtip-backend
- OpenBao - MPL-2.0; self-hosted secret management if required.
  https://github.com/openbao/openbao

All licenses above must still be rechecked at the exact pinned revision and across bundled dependencies before production incorporation.

### Privacy-removal code/data candidates

PersProtect data-broker-opt-out-list:
- Public dataset of 499 US brokers at research date.
- Declared CC BY 4.0, explicitly permitting commercial adaptation with attribution.
- Good bootstrap data source, but every actionable row should still be revalidated against current official controller pages and regulator registries.
Source: https://github.com/Persprotect/data-broker-opt-out-list

RightOut:
- MIT licensed.
- Strong design ideas around approval boundaries, durable workers, evidence, explicit uncertainty, provider permissions, and no deletion theater.
- Appropriate as a reference/component candidate, not automatically a SaaS shell.
Source: https://github.com/Olli0103/rightout

broker-scrub:
- MIT licensed.
- Useful reference for statutory email requests, reply/deadline tracking, and re-runs.
- Low project maturity and narrower scope mean mandatory audit before any reuse.
Source: https://github.com/txssseal/broker-scrub

DataBrokerOptOut:
- MIT licensed local workflow helper.
- Useful reference for status/recheck concepts, not a production SaaS shell.
Source: https://github.com/moderatedan/DataBrokerOptOut

### Licensing traps / deny-by-default sources

Optery data-brokers directory:
- Public GitHub repository but CC BY-NC-SA 4.0.
- Noncommercial restriction makes it unsuitable as a seed for a commercial SaaS without a separate license.
Source: https://github.com/optery/optery-data-brokers-directory

DrCaiola/optout:
- CC BY-NC-SA and itself notes provenance from a noncommercial ShareAlike source.
- Do not import into commercial product without separate rights.
Source: https://github.com/DrCaiola/optout

Enthropic-Data-LLC/data-removal:
- README states "Private. All rights reserved."
- Public visibility on GitHub is not permission to reuse.
Source: https://github.com/Enthropic-Data-LLC/data-removal

Other license caution:
- AGPL and fair-source components can still be valuable as separately operated services, but embedding/repackaging obligations must be explicitly reviewed. Do not let an agent assume "open source" means commercially frictionless.

## 6. Browser automation and anti-bot policy

Research across privacy-removal tools shows CAPTCHAs, phone verification, email confirmation, and changing DOMs are normal failure points. Several projects use stealth/CAPTCHA solvers, but VanishGraph should not make bypassing service controls part of its core product.

Decision:
- Use Playwright + Crawlee with conservative domain rate limits.
- Detect CAPTCHA/OTP/phone/security-question/ID/payment/access-control gates.
- Emit `HUMAN_REQUIRED` or choose a different official channel.
- Do not use Camoufox/playwright-stealth/CAPTCHA-solving services in the default architecture.
- Treat each recipe's permission/TOS state as runtime policy.
- A stale or legally unclear write recipe auto-disables rather than "trying harder".

This improves durability, reduces legal/TOS risk, and prevents silent automation theater.

## 7. Postal certified mail research

USPS provides Certified Mail and return-receipt services that provide mailing/delivery evidence. VanishGraph should preserve mailing proof and delivery status as case evidence.
USPS source: https://pe.usps.com/text/dmm300/503.htm

Commercial API candidates:

Lob:
- Print/mail API with letters and extra-service support; evaluate current Certified Mail and return-receipt options in sandbox before enabling.
- https://docs.lob.com/

Click2Mail:
- Current developer material describes Certified Mail support and USPS tracking retrieval.
- https://developers.click2mail.com/reference/trackingjob
- https://blog.click2mail.com/2026/04/04/mail-automation-api/

PostGrid:
- Letter API advertises Certified/Registered Mail and documented certified return-receipt options.
- https://www.postgrid.com/letter-api/
- https://docs.postgrid.com/

Decision:
- Own the letter template/version/hash/case/evidence model.
- Make vendors replaceable adapters.
- Use provider idempotency/reconciliation so an ambiguous timeout never creates duplicate certified letters.
- Always provide a manual PDF/print/export fallback.

## 8. Core data model recommendation

Primary entities:
- `Tenant`
- `ProtectedSubject`
- `AuthorityGrant`
- `Alias`
- `Identifier`
- `LocationHistory`
- `Source`
- `SourceCatalogEntry`
- `RemovalRecipe`
- `SourceRecord`
- `Exposure`
- `EvidenceArtifact`
- `Controller`
- `JurisdictionPolicy`
- `RequestCase`
- `ExternalAction`
- `EmailThread`
- `MailPiece`
- `Deadline`
- `ControllerResponse`
- `VerificationObservation`
- `AppealEscalation`
- `Reappearance`
- `PolicyDecision`
- `ProviderTransportRun`
- `AuditEvent`
- `RepairCapsule`

Important invariants:
- Every effect belongs to exactly one protected subject and valid authority scope.
- A source record is not actionable until subject-match confidence meets policy or a human approves it.
- Every external write has one idempotency key and one durable ambiguity/reconciliation path.
- Every "verified removed" state links to independent observation evidence.
- Every recipe has provenance, policy/TOS class, version, freshness, and disable switch.
- Every model run records data-egress class and provider transport without storing unnecessary prompt PII.

## 9. Removal-channel priority model

Suggested policy order, subject to source/jurisdiction:
1. Current official self-service privacy/opt-out form when automation is permitted.
2. Official privacy email/DPO/controller contact.
3. Authorized-agent request with signed authority where needed.
4. Centralized government channel such as California DROP when eligible.
5. Search-engine personal-information/outdated-content/legal removal where independently eligible.
6. Certified postal mail when stronger proof or a mail-only process is appropriate.
7. Appeal/escalation/regulator complaint packet with required human/counsel review.
8. Transparent `NOT_REMOVABLE`/`EXEMPT` outcome when no lawful removal right/path exists.

The policy engine chooses the route; the LLM may recommend but cannot invent a legal basis.

## 10. Bug/crash-to-PR repair architecture

Recommended chain:
1. OTel/GlitchTip receives a production/staging error with release/artifact/trace correlation.
2. DLP scrubber removes names, emails, phones, addresses, cookies, tokens, form values, raw HTML, sensitive screenshots, and secrets.
3. Fingerprinter groups recurring defects and checks existing issues.
4. Reproduction worker attempts a safe synthetic/staging reproduction.
5. Repair Capsule stores only sanitized technical evidence and expected/actual behavior.
6. GitHub App opens/updates an issue.
7. Authorized Codex/Claude/Grok transporter launches in an isolated worktree/branch with minimum repo permissions.
8. Agent adds regression test, implements repair, runs GraphLock-relevant gates, and opens a draft PR.
9. Sensitive-scope detector enforces human review and prohibits auto-merge/deploy for auth, privacy, legal policy, billing, migrations, destructive data code, secret handling, or security controls.
10. A merged release is still bound to ordinary staging/live-fire verification; a PR is never proof that the defect is fixed in production.

## 11. Security architecture priorities

Must-threat-model:
- Cross-tenant PII access.
- Account takeover and fraudulent authorized-agent enrollment.
- Prompt injection from web pages, email, PDFs, and search snippets.
- SSRF and malicious download/browser escape.
- Duplicate or misdirected removal writes.
- Stale recipe selectors writing incorrect data.
- Webhook spoof/replay.
- Model/tool exfiltration.
- Secret leakage into telemetry/issues/PRs.
- Supply-chain/license contamination.
- Support/admin overreach.
- Backup resurrection after customer deletion.

Recommended controls:
- PostgreSQL RLS plus service-level authorization.
- Per-tenant/data-class envelope encryption using cloud KMS.
- Short-lived workload identities.
- Ephemeral non-root browser pods with egress controls.
- Schema-validated typed tools and effect budgets.
- Prompt-injection tainting and untrusted-content boundary.
- Signed/versioned recipes and legal policy.
- DLP before all telemetry/model/dev-agent egress.
- Independent verification before removal success.
- Full append-only audit trail plus immutable build/evidence digests.

## 12. Product truth model

VanishGraph should make these distinctions visible to customers and operators:

- `DISCOVERED_CANDIDATE`: something looks relevant.
- `MATCH_CONFIRMED`: evidence says it belongs to this subject.
- `REQUEST_READY`: valid authority/policy/recipe exists.
- `REQUEST_SUBMITTED`: effect provider/browser/mail accepted the action.
- `ACKNOWLEDGED`: controller/provider acknowledged it.
- `VERIFIED_REMOVED`: independent recheck no longer finds the confirmed record under the recipe's required verification method.
- `SEARCH_DELISTED`: search engine no longer returns the result; does not imply source deletion.
- `VERIFIED_NOT_PRESENT`: no confirmed listing was observed in a valid scan.
- `NOT_REMOVABLE`: legal/public-interest/technical limitations prevent removal.
- `HUMAN_REQUIRED`: a legitimate human/identity/CAPTCHA/legal gate exists.
- `REAPPEARED`: a prior verified removal is observed again.

A product in this category can be dangerous if it optimizes for reassuring labels rather than evidence. This state model is therefore a core commercial and safety differentiator.

## 13. Sources index

Official/regulatory/provider sources:
- OpenAI Codex auth: https://learn.chatgpt.com/docs/auth
- Anthropic Claude Code CLI: https://code.claude.com/docs/en/cli-usage
- xAI Grok Build overview: https://docs.x.ai/build/overview
- xAI Grok Build enterprise auth: https://docs.x.ai/build/enterprise
- Google Gemini consumer CLI deprecation: https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- CPPA Data Brokers / DROP: https://cppa.ca.gov/data_brokers/index.html
- Google Results About You: https://support.google.com/websearch/answer/12719076?hl=en
- USPS additional services: https://pe.usps.com/text/dmm300/503.htm

Market sources:
- Optery: https://www.optery.com/
- DeleteMe coverage: https://joindeleteme.com/sites-we-remove-from/

Commercial mail APIs:
- Lob: https://docs.lob.com/
- Click2Mail tracking: https://developers.click2mail.com/reference/trackingjob
- PostGrid: https://docs.postgrid.com/

Open-source/data sources:
- PersProtect CC BY 4.0 dataset: https://github.com/Persprotect/data-broker-opt-out-list
- RightOut MIT: https://github.com/Olli0103/rightout
- broker-scrub MIT: https://github.com/txssseal/broker-scrub
- DataBrokerOptOut MIT: https://github.com/moderatedan/DataBrokerOptOut
- Optery directory CC BY-NC-SA: https://github.com/optery/optery-data-brokers-directory
- DrCaiola optout CC BY-NC-SA: https://github.com/DrCaiola/optout
- Enthropic Data removal all-rights-reserved: https://github.com/Enthropic-Data-LLC/data-removal
- OpenBao MPL-2.0: https://github.com/openbao/openbao
- Valkey BSD-3-Clause: https://github.com/valkey-io/valkey

## 14. Revalidation rule

Before implementation begins, PREFLIGHT must re-open current official sources and verify:
- Provider OAuth/subscription automation rights and headless interfaces.
- Google/Antigravity status.
- Data-broker laws, DROP timelines, authorized-agent requirements, and jurisdiction effective dates.
- Mail provider certified/return-receipt capabilities and webhook semantics.
- Every source-code/data license at the exact revision being considered.
- Current regulator registries and controller opt-out endpoints.
- Competitor baseline claims used only for market requirements.

If a volatile external fact has changed, the current official source wins over this research brief and the change must be recorded in an ADR/Decision Log.
