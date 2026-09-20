## BC-021 -- Grammar-Based Fuzzing

Derive grammars from ABI, transaction, signature, serialization, RPC, proof, metadata, or domain-specific formats. Generate syntactically structured but semantically hostile inputs, including nesting, length boundaries, duplicate fields, invalid encodings, alternate canonical forms, and truncated messages. Exercise parsers and state transitions, preserve minimal reproductions, and verify safe rejection without partial mutation. A pass requires coverage of each grammar production and no unresolved crash or inconsistent parse.

