## BC-009 -- Runtime Verification

Derive explicit safety and liveness properties from specifications, tests, and contract logic. Instrument local executions or use runtime-verification tooling to evaluate those properties on every transaction and state transition. Include balance conservation, authorization, monotonic counters, collateralization, supply bounds, escrow rules, pause semantics, and forbidden states. Force property violations in a controlled mutation to prove monitors detect them. A pass requires the properties to hold under the executed corpus and the monitor to detect seeded violations.

