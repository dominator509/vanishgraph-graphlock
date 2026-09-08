# GraphLock v3.1 Failure-Proof Bundle

Use `6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md` as the controlling master prompt.

This version hardens v3 Verified against the failure mode where lower-tier or mid-tier LLMs code around gate passage, fake closure, or hack tests instead of delivering real software.

## Main files

- `6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md` - primary master prompt.
- `GRAPHLOCK_v3_1_BOOTSTRAP_LAUNCHER.md` - launcher for agents.
- `validate_graphlock_v3_1.py` - structural validator for the upgraded master prompt.
- `scripts/validate-generated-pack.py` - validator for a generated project pack.
- `scripts/anti-gaming-scan.py` - repository scan for bypass/gate-gaming patterns.
- `scripts/validate-hash-ledger.py` - validates hash-chained JSONL ledger records.
- `schemas/blocked-node.schema.json` - required shape for CLOSED_BLOCKED records.
- `schemas/anti-gaming-review.schema.json` - required shape for anti-gaming closure review.

## Validate this bundle

```sh
python3 validate_graphlock_v3_1.py 6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md
```

Expected result includes:

```text
valid: true
```

## Core v3.1 doctrine

Hacking a gate is worse than failing a gate. Failing a gate preserves truth and enables remediation. Hacking a gate destroys release integrity and poisons every downstream decision.

## This customized project bundle

This copy has been specialized for **VanishGraph Privacy Removal OS**.

Start with:

1. `PROJECT_CUSTOMIZATION_SUMMARY.md` - what was changed and how to use this pack.
2. `PROJECT_RESEARCH_BRIEF.md` - dated market/legal/provider/open-source research that informed the inputs.
3. `GRAPHLOCK_v3_1_BOOTSTRAP_LAUNCHER.md` - customized launcher, intentionally set to `FORGE_ONLY` so the next agent generates/validates the blueprint without beginning application construction unless the operator explicitly changes mode.
4. `6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md` - controlling master prompt with the complete `# 1. INPUTS` section filled for this project.

The original v3 source archive under `archive_original_v3/` remains untouched. The v3.1 verification registry and Definition of Done remain structurally intact.
