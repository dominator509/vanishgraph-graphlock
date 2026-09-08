# Execution DAG

The verification DAG is fixed and non-cascading. V-000 through V-021 are defined in `.agent/verification/GRAPH.md`; registry IDs are owned by exactly one stage. Candidate failures continue independent stages. A prerequisite blocks only explicit dependents. Final accounting emits GO, NO_GO, CONDITIONAL_EXTERNAL_GATES, or INCONCLUSIVE.

Evidence is immutable within a candidate epoch; any product, dependency, configuration, schema, test-oracle, or artifact change creates a new epoch and invalidates affected descendants.
