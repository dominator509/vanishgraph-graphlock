# Reconstructed Blockchain Prompt Bodies -- Entries 008-022

The supplied Blockchain index lists entries 008-022, but the corresponding full prompt file omits their bodies. These replacements are master-harness reconstructions based on the indexed titles. They are clearly marked as reconstructed rather than attributed to the original source.

All entries inherit the master authorization, sandbox, evidence, reporting, and completion rules. They apply only when the repository contains relevant smart contracts, chain clients, transaction processing, on-chain monitoring, or blockchain-facing components.

---

## BC-008 -- Smart Contract Dynamic Analysis

Deploy the contracts to an isolated local chain or authorized fork. Exercise every externally reachable state transition using representative actors, balances, permissions, call values, and transaction orderings. Capture traces, emitted events, storage diffs, revert reasons, gas, external calls, and final invariants. Test successful and reverting behavior, fallback/receive paths, proxy routing, and unexpected token callbacks where applicable. A pass requires observable runtime evidence for all critical contract workflows and no unexplained state divergence.

## BC-009 -- Runtime Verification

Derive explicit safety and liveness properties from specifications, tests, and contract logic. Instrument local executions or use runtime-verification tooling to evaluate those properties on every transaction and state transition. Include balance conservation, authorization, monotonic counters, collateralization, supply bounds, escrow rules, pause semantics, and forbidden states. Force property violations in a controlled mutation to prove monitors detect them. A pass requires the properties to hold under the executed corpus and the monitor to detect seeded violations.

## BC-010 -- Runtime Monitoring

Map security-relevant events, traces, state changes, errors, admin actions, upgrades, pauses, mint/burn activity, oracle updates, and anomalous gas/revert behavior. Run an isolated chain workload and confirm monitoring rules ingest, correlate, alert, and retain the expected signals without exposing secrets. Seed known suspicious activity and verify alert fidelity, deduplication, severity, and recovery clearing. Code-only review is partial; actual production monitoring requires access to the deployed telemetry stack.

## BC-011 -- Transaction Monitoring

Generate valid, invalid, duplicated, replayed, reordered, high-value, privileged, and anomalous transactions in an authorized environment. Verify ingestion from submission through mempool/receipt/finality, sender/nonce/value decoding, event correlation, reorg handling, replacement transactions, and alerting. Reconcile transaction counts and value movement against chain state. A pass requires no dropped or double-counted transactions and correct handling of pending, reverted, replaced, and reorganized activity.

## BC-012 -- Anomaly Detection

Establish a documented baseline of normal account, contract, gas, timing, value, call-graph, and event behavior. Create labeled anomalous scenarios such as sudden privilege use, abnormal transfer concentration, repeated reverts, unusual call depth, oracle deviation, bot bursts, and governance spikes. Evaluate precision, recall, false-positive rate, false-negative rate, latency, and drift. A pass requires threshold performance against the approved evaluation set; mere presence of an anomaly model is not a pass.

## BC-013 -- Behavioral Analysis

Model expected behaviors for users, operators, validators, contracts, bots, and privileged roles. Execute sequences that follow and violate those models, including unusual ordering, dormant-account activation, permission changes, and correlated multi-account actions. Confirm that behavior analytics distinguish suspicious deviations without treating every rare event as malicious. Record explainable features and limitations. Production claims require representative live or replayed telemetry.

## BC-014 -- On-Chain Monitoring

Validate indexing and monitoring across blocks, transactions, logs, traces, contract upgrades, token transfers, governance, oracle data, and reorgs. Use an isolated chain, testnet, or authorized fork; simulate chain reorganization and provider interruption. Compare indexed state to canonical chain state at each finality depth. A pass requires deterministic reconciliation, reorg correction, gap detection, backfill, and alerting when providers or indexers fall behind.

## BC-015 -- Smart Contract Fuzzing

Build a contract-specific fuzz harness using the repository's native framework where possible. Generate randomized call sequences, actors, values, calldata, token behaviors, and environmental variables. Define explicit invariants and oracles before execution. Preserve seeds, corpus, coverage, crashes, minimal reproductions, and state snapshots. Run a bounded CI campaign and, where required, a persistent campaign. A clean bounded run is evidence for that campaign, not proof of absence of vulnerabilities.

## BC-016 -- Property-Based Testing

Translate contract requirements into quantified properties over broad input domains. Generate values at boundaries and across valid/invalid partitions, shrink failures, and test both individual functions and transaction sequences. Include algebraic properties, conservation rules, access-control properties, round trips, monotonicity, idempotency, and revert expectations. A pass requires every property to have a documented oracle, executed input distribution, reproducible seed, and no unresolved counterexample.

## BC-017 -- Invariant Testing

Define state invariants that must hold across arbitrary sequences: supply/balance conservation, collateral ratios, escrow conservation, role constraints, accounting equality, one-time initialization, pause restrictions, and forbidden ownership states. Run stateful invariant campaigns with multiple actors and malicious helper contracts. Check invariants after every operation and after failure/revert paths. Seed a broken contract mutation to validate the harness. A pass requires stable invariants and demonstrated detector sensitivity.

## BC-018 -- Coverage-Guided Fuzzing

Instrument the applicable contract/compiler/runtime and feed coverage feedback into input generation. Track line, branch, opcode, state-transition, and call-sequence coverage where supported. Maintain and minimize the corpus; investigate coverage plateaus and unreachable code. Do not equate high coverage with correctness. A pass requires documented campaign duration, environment, seeds, coverage progression, unresolved crashes, and rationale for critical unvisited paths.

## BC-019 -- Stateful Fuzzing

Model the contract system as a state machine and generate long sequences across multiple users, contracts, blocks, prices, and roles. Include deposits, withdrawals, transfers, liquidations, upgrades, governance, pauses, retries, and reentrant/malicious callbacks as applicable. Verify invariants after each transition and shrink failing sequences. A pass requires reproducible sequence traces and no unexplained state corruption across the completed campaign.

## BC-020 -- Differential Fuzzing

Identify two implementations, versions, clients, compilers, reference models, or execution modes expected to be equivalent. Feed identical generated inputs and transaction sequences to both, then compare return values, reverts, events, gas-sensitive semantics where relevant, storage, balances, and final state. Normalize documented nondeterminism only. Every divergence must be explained or treated as a finding. A pass requires a defined equivalence contract and no unresolved divergence.

## BC-021 -- Grammar-Based Fuzzing

Derive grammars from ABI, transaction, signature, serialization, RPC, proof, metadata, or domain-specific formats. Generate syntactically structured but semantically hostile inputs, including nesting, length boundaries, duplicate fields, invalid encodings, alternate canonical forms, and truncated messages. Exercise parsers and state transitions, preserve minimal reproductions, and verify safe rejection without partial mutation. A pass requires coverage of each grammar production and no unresolved crash or inconsistent parse.

## BC-022 -- Mutation-Based Fuzzing

Seed the fuzzer with valid transactions, calldata, signatures, proofs, configuration, and serialized state. Apply controlled bit, byte, field, length, ordering, value, and structure mutations. Include domain-aware mutations for selectors, offsets, nonces, chain IDs, amounts, addresses, and signatures. Verify malformed inputs fail closed and do not partially mutate state. Track mutation operators, corpus evolution, coverage, and minimized failures. A pass requires all critical operators to execute and every crash/divergence to be triaged.
