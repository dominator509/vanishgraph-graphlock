# Assumptions

| assumption | reason | risk if wrong | how to verify | blocks implementation |
|---|---|---|---|---|
| Initial launch is US managed cloud | supplied target | residency or cost mismatch | PREFLIGHT cloud ADR | yes |
| Cloud provider is undecided | no credentials supplied | deployment path changes | score providers in PREFLIGHT | yes |
| Human validators are unavailable at generation | runtime unknown | external gates remain open | provision before GA | no |
| Google consumer subscription transport is not assumed | dated research brief | adapter may remain disabled | revalidate official docs | no |
