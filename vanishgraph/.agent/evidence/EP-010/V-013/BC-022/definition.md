## BC-022 -- Mutation-Based Fuzzing

Seed the fuzzer with valid transactions, calldata, signatures, proofs, configuration, and serialized state. Apply controlled bit, byte, field, length, ordering, value, and structure mutations. Include domain-aware mutations for selectors, offsets, nonces, chain IDs, amounts, addresses, and signatures. Verify malformed inputs fail closed and do not partially mutate state. Track mutation operators, corpus evolution, coverage, and minimized failures. A pass requires all critical operators to execute and every crash/divergence to be triaged.

