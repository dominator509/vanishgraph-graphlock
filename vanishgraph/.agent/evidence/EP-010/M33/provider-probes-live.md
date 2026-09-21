# Provider probes measured against the operator's declared provider file (EP-010 M33)

All measurements are from this session, on the current workspace. No probe output contains a credential value.

## The live results

    stripe (real key, read-only)   exit=0  STRIPE_SECRET_KEY: ok - the provider accepted a read-only GET /v1/balance (HTTP 200)
    postal: LOB bogus (live)       exit=1  LOB_API_KEY is present and the provider REFUSED it (HTTP 401)
    search_api_key                 exit=1  (declared name unset - see the name mismatch below)

`api.stripe.com` and `api.lob.com` both ANSWERED from this environment, so outbound provider transport works and both
probes are discriminating: Stripe returned 200 for a valid credential and LOB returned 401 for a bogus one. The stripe
probe is now the FIRST of the ten that has proved a real provider end to end, and it did so with a read-only request that
writes nothing (`GET /v1/balance`, the action recorded in scripts/probes/stripe.sh).

## The postal dispatch, fixed and measured as a matrix

`scripts/probes/postal_api.sh` serves three declared credentials, and one probe serving three credentials has to say
which state it is in. Measured after the fix:

    nothing declared        exit=1  LOB_API_KEY is unset (the stable PREFLIGHT.md naming)
    CLICK2MAIL empty        exit=1  the declared postal credential(s) CLICK2MAIL_API_KEY are present with an EMPTY value; an empty
                                    value is not a credential - NOTE: CLICK2MAIL and POSTGRID also have NO transport declared
    CLICK2MAIL non-empty    exit=2  the credential is present, but no transport endpoint for this provider is declared
    POSTGRID non-empty      exit=2  the same, named for POSTGRID
    LOB non-empty           live    200/405 -> REACHABLE, 401/403 -> refused, 404 -> the recorded path is wrong

BEFORE the fix, an operator whose file carries `CLICK2MAIL_API_KEY=` (present and empty) was told `LOB_API_KEY is
unset` - a DIFFERENT credential than the one their environment declares, which sends them to provision something they
already have. That is the state `C:\tmp\vanishgraph-providers.env` is actually in.

## The search credential is provisioned under a DIFFERENT NAME than the contract declares

The operator's file carries a non-empty `SERPAPI_API_KEY` (the vendor's name) while `config/environment/schema.json` and
PREFLIGHT.md declare `SEARCH_API_KEY`. The probe reports the mismatch rather than silently accepting an alias:

    SEARCH_API_KEY unset, SERPAPI_API_KEY present   exit=1  ... the credential contract declares SEARCH_API_KEY and this probe
                                                             reads ONLY the declared name ... Either provision SEARCH_API_KEY or
                                                             amend the declared contract deliberately
    SEARCH_API_KEY present                          exit=2  no search-provider endpoint is declared anywhere in this repository

A probe that accepted the vendor alias would make the contract unenforceable, and the fix is a decision for the owner:
rename the provisioned variable, or declare the alias in the contract deliberately.

## A trap in my own measurement harness, recorded because it produced a false reading

`[System.Environment]::SetEnvironmentVariable($name, $null, 'Process')` SETS AN EMPTY STRING on this host rather than
deleting the variable. The first run of the dispatch matrix therefore reported every postal credential as
present-and-empty, and the "nothing declared" case - which should print the stable `LOB_API_KEY is unset` - printed the
empty-value message instead. Verified directly: with a variable truly unset, `eval "D=\${X+set}"` yields empty, and for
an empty value it yields `set`. The harness now uses `Remove-Item Env:NAME`, and the matrix above is the corrected
reading. The probe logic was right and the measurement was wrong, which is the direction that wastes the most time if it
is not stated.

## The ingest half of workstream C, re-proven in this session

`sh .agent/evidence/EP-010/M12/signoff-mechanism-test.sh` -> exit 0: a valid fixture registered as SIGNED, a
stale-digest fixture REFUSED with both digests named, a missing-evidence fixture REFUSED with the path named, then the
fixtures removed and the committed store re-read as `external gates status: 0/5 signed` with 0 blockers and 0 bytes.
No sign-off has been RETURNED by anyone, so nothing has been ingested from a human; the path that would ingest one is
proven working.

## A stale claim found in the registry, and the fix that was NOT taken unilaterally

The five STRIPE rows in epoch FORGE-SPEC-12 (HIPAA-011, HIPAA-077, HIPAA-106, HIPAA-111, HIPAA-113) carry
`BLOCKED_CREDENTIALS` with the reason "this environment has not provisioned: STRIPE_SECRET_KEY". That was true of the
environment the ladder ran in - nothing sources the operator's provider file - but it is now misleading as a standing
statement: the credential IS provisioned on this machine and its probe returns HTTP 200. The same applies to the two
CLICK2MAIL rows (HIPAA-083, HIPAA-119), whose credential is present-but-EMPTY and whose transport is undeclared in any
case.

The one-line fix would be to source a declared provider state file the way `scripts/smoke-test.sh` already sources the
database, Keycloak and object-store state files. IT WAS NOT TAKEN, deliberately: it would make every future ladder run
contact a live payment provider automatically, and whether an automated gate may spend a real provider credential is the
owner's judgement rather than mine. It is recorded here as a decision with its exact shape, not as an oversight.

## Effect on the artifact and the epoch

None, and measured: `scripts/**` is not in the package's `files` allowlist, so the artifact is unchanged at
`sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57` and the epoch remains FORGE-SPEC-12.
