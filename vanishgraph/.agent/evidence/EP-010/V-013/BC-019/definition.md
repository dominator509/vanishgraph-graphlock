## BC-019 -- Stateful Fuzzing

Model the contract system as a state machine and generate long sequences across multiple users, contracts, blocks, prices, and roles. Include deposits, withdrawals, transfers, liquidations, upgrades, governance, pauses, retries, and reentrant/malicious callbacks as applicable. Verify invariants after each transition and shrink failing sequences. A pass requires reproducible sequence traces and no unexplained state corruption across the completed campaign.

