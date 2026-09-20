## BC-017 -- Invariant Testing

Define state invariants that must hold across arbitrary sequences: supply/balance conservation, collateral ratios, escrow conservation, role constraints, accounting equality, one-time initialization, pause restrictions, and forbidden ownership states. Run stateful invariant campaigns with multiple actors and malicious helper contracts. Check invariants after every operation and after failure/revert paths. Seed a broken contract mutation to validate the harness. A pass requires stable invariants and demonstrated detector sensitivity.

