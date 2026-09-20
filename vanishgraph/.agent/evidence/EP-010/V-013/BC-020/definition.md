## BC-020 -- Differential Fuzzing

Identify two implementations, versions, clients, compilers, reference models, or execution modes expected to be equivalent. Feed identical generated inputs and transaction sequences to both, then compare return values, reverts, events, gas-sensitive semantics where relevant, storage, balances, and final state. Normalize documented nondeterminism only. Every divergence must be explained or treated as a finding. A pass requires a defined equivalence contract and no unresolved divergence.

