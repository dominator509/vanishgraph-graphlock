#!/usr/bin/env python3
"""Structural and integrity validator for GraphLock v3 Verified master prompt."""
from __future__ import annotations

from collections import Counter
from pathlib import Path
import base64
import csv
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
import tempfile

PROMPT = Path(sys.argv[1] if len(sys.argv) > 1 else "6Layer-MasterPrompt-v3-GRAPHLOCK-VERIFIED.md")
text = PROMPT.read_text(encoding="utf-8")
errors: list[str] = []
warnings: list[str] = []


def exact_block(start: str, end: str) -> str:
    pattern = re.escape(start) + r"\n(.*?)\n" + re.escape(end)
    matches = re.findall(pattern, text, flags=re.S)
    if len(matches) != 1:
        errors.append(f"expected exactly one block {start}..{end}; found {len(matches)}")
        return ""
    return matches[0]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# Core identity and non-negotiable architecture.
required_tokens = [
    '# 6LAYER MASTER PROMPT -- v3 "GRAPHLOCK VERIFIED"',
    "RULE-BECAUSE-OR-ELSE LAW",
    "CANDIDATE EPOCH LAW",
    "NON-CASCADING FAILURE LAW",
    "NO ARBITRARY CAMPAIGN CUTOFF",
    "EXACT ARTIFACT LAW",
    "TEST COLLECTION GUARD",
    "HUMAN/EXTERNAL HONESTY",
    "CAMPAIGN CONTINUES AFTER NO-GO",
    "BLOCKED_PREREQUISITE",
    "BLOCKED_ENVIRONMENT",
    "BLOCKED_CAPABILITY",
    "definition of done: ok",
    "zero unaccounted",
    ".agent/DONE_LAW.md",
    "materialize-atomic-sources.sh",
]
for token in required_tokens:
    if token.lower() not in text.lower():
        errors.append(f"missing required token: {token}")

# Control punctuation must remain ASCII. Intentional Unicode test payloads are allowed,
# but smart punctuation and arrows are never allowed in the control prompt.
for forbidden, name in [("—", "em dash"), ("–", "en dash"), ("“", "left smart quote"),
                        ("”", "right smart quote"), ("’", "smart apostrophe"), ("→", "arrow")]:
    if forbidden in text:
        errors.append(f"forbidden control typography remains: {name}")

# Registry.
registry_text = exact_block("MASTER-TEST-REGISTRY-CSV-BEGIN", "MASTER-TEST-REGISTRY-CSV-END")
registry_rows = list(csv.DictReader(io.StringIO(registry_text))) if registry_text else []
if len(registry_rows) != 484:
    errors.append(f"registry count {len(registry_rows)} != 484")
registry_ids = [r.get("test_id", "") for r in registry_rows]
if len(set(registry_ids)) != len(registry_ids):
    errors.append("duplicate registry IDs")
prefix_counts = {prefix: sum(tid.startswith(prefix + "-") for tid in registry_ids)
                 for prefix in ["GEN", "HIPAA", "BC", "E2E", "SUP"]}
expected_prefix_counts = {"GEN": 122, "HIPAA": 125, "BC": 202, "E2E": 20, "SUP": 15}
if prefix_counts != expected_prefix_counts:
    errors.append(f"bad registry prefix counts: {prefix_counts}")
status_counts = Counter(r.get("source_body_status", "") for r in registry_rows)
expected_source_status = {
    "embedded-original-source": 434,
    "embedded-reconstructed-source": 15,
    "embedded-suite": 20,
    "embedded-supplemental": 15,
}
if dict(status_counts) != expected_source_status:
    errors.append(f"bad source-body provenance counts: {dict(status_counts)}")
for r in registry_rows:
    if r.get("must_account") != "true":
        errors.append(f"{r.get('test_id')} is not marked must_account=true")

# DOD registry.
dod_text = exact_block("DOD-REGISTRY-CSV-BEGIN", "DOD-REGISTRY-CSV-END")
dod_rows = list(csv.DictReader(io.StringIO(dod_text))) if dod_text else []
if len(dod_rows) != 42:
    errors.append(f"DOD count {len(dod_rows)} != 42")
dod_ids = [r.get("dod_id", "") for r in dod_rows]
if len(set(dod_ids)) != len(dod_ids):
    errors.append("duplicate DOD IDs")
for index, row in enumerate(dod_rows, start=1):
    expected = f"DOD-{index:03d}"
    if row.get("dod_id") != expected:
        errors.append(f"DOD order mismatch at {index}: {row.get('dod_id')} != {expected}")
    for field in ["scope", "rule", "because", "required_evidence", "or_else", "must_account"]:
        if not row.get(field):
            errors.append(f"{row.get('dod_id')} missing {field}")
    # Human-readable clause must also exist with all five labels.
    clause_pattern = (rf"## {re.escape(expected)}\n"
                      rf"SCOPE: .+?\nRULE: .+?\nBECAUSE: .+?\n"
                      rf"REQUIRED EVIDENCE: .+?\nOR ELSE: .+?(?:\n\n|\Z)")
    if not re.search(clause_pattern, text, flags=re.S):
        errors.append(f"{expected} missing or malformed human-readable Rule/Because/Evidence/Or-Else clause")

# Verify the user's original 28 concepts remain represented without weakening.
original_dod_concepts = {
    "DOD-001": ["stable requirement ID", "acceptance test"],
    "DOD-002": ["clean checkout", "frozen/locked dependency"],
    "DOD-003": ["production distribution artifact"],
    "DOD-004": ["exact production artifact digest", "smoke and E2E"],
    "DOD-005": ["ephemeral clean environment"],
    "DOD-006": ["skipped", "disabled", "xfailed"],
    "DOD-007": ["zero tests", "expected manifest"],
    "DOD-008": ["semantic results", "boundaries", "invariants"],
    "DOD-009": ["production-type databases", "queues", "caches"],
    "DOD-010": ["Mocks", "sole proof"],
    "DOD-011": ["Black-box", "public user-facing interfaces"],
    "DOD-012": ["independently verified", "second connection"],
    "DOD-013": ["unpredictable canary"],
    "DOD-014": ["Wrong credentials", "fail-closed"],
    "DOD-015": ["full process and container restart"],
    "DOD-016": ["empty database", "prior released schema"],
    "DOD-017": ["Duplicate", "concurrent", "idempotency"],
    "DOD-018": ["controlled defect or mutation", "must fail"],
    "DOD-019": ["Placeholder", "stub", "hard-coded-success"],
    "DOD-020": ["Production mode", "mock", "in-memory adapters"],
    "DOD-021": ["static analysis", "type checking", "secret scanning"],
    "DOD-022": ["automated pass/fail thresholds"],
    "DOD-023": ["README commands", "executed exactly as published"],
    "DOD-024": ["continue-on-error", "ignored exit codes", "swallowed exceptions"],
    "DOD-025": ["Raw commands", "artifact hashes", "preserved"],
    "DOD-026": ["unmet condition", "exact taxonomy"],
    "DOD-027": ["fabricated success response", "acceptance criteria"],
    "DOD-028": ["verified behavior", "unverified assumptions", "remaining limitation"],
}
dod_by_id = {r.get("dod_id"): r for r in dod_rows}
for did, concepts in original_dod_concepts.items():
    row_blob = " ".join(str(v) for v in dod_by_id.get(did, {}).values()).lower()
    for concept in concepts:
        if concept.lower() not in row_blob:
            errors.append(f"{did} no longer contains original concept: {concept}")

# Verification graph: exact nodes, topological order, acyclic dependencies.
graph_text = exact_block("VERIFICATION-GRAPH-TABLE-BEGIN", "VERIFICATION-GRAPH-TABLE-END")
graph_rows: list[tuple[str, list[str]]] = []
for line in graph_text.splitlines():
    m = re.fullmatch(r"STAGE (V-\d{3}) DEPS (.+)", line)
    if not m:
        errors.append(f"malformed verification graph line: {line}")
        continue
    sid = m.group(1)
    deps = [] if m.group(2) == "-" else m.group(2).split(",")
    graph_rows.append((sid, deps))
expected_stage_ids = [f"V-{i:03d}" for i in range(22)]
actual_stage_ids = [sid for sid, _ in graph_rows]
if actual_stage_ids != expected_stage_ids:
    errors.append(f"verification stages are not exactly V-000..V-021 in order: {actual_stage_ids}")
seen: set[str] = set()
for sid, deps in graph_rows:
    for dep in deps:
        if dep not in seen:
            errors.append(f"{sid} depends on non-earlier or missing stage {dep}")
    seen.add(sid)

# Embedded canonical atomic-source archive.
metadata = exact_block("ATOMIC-SOURCE-ARCHIVE-METADATA-BEGIN", "ATOMIC-SOURCE-ARCHIVE-METADATA-END")
meta: dict[str, str] = {}
for line in metadata.splitlines():
    if ": " in line:
        key, value = line.split(": ", 1)
        meta[key] = value
payload_text = exact_block("ATOMIC-SOURCE-PACK-BASE64-BEGIN", "ATOMIC-SOURCE-PACK-BASE64-END")
archive_data = b""
source_counts: dict[str, int] = {}
source_hashes: dict[str, str] = {}
try:
    archive_data = base64.b64decode(payload_text.encode("ascii"), validate=False)
except Exception as exc:
    errors.append(f"atomic source payload base64 decode failed: {exc}")
if archive_data:
    if sha256(archive_data) != meta.get("ARCHIVE_SHA256"):
        errors.append("atomic source archive SHA-256 mismatch")
    if sha256((payload_text + "\n").encode("ascii")) != meta.get("BASE64_PAYLOAD_SHA256"):
        errors.append("atomic source base64 payload SHA-256 mismatch")
    expected_names = [
        "security/blockchain-security-testing-prompts.md",
        "security/general-dev-security-testing-prompts.md",
        "security/hipaa-software-dev-security-testing-prompts.md",
    ]
    try:
        with tarfile.open(fileobj=io.BytesIO(archive_data), mode="r:gz") as tar:
            file_members = [m for m in tar.getmembers() if m.isfile()]
            names = sorted(m.name for m in file_members)
            if names != sorted(expected_names):
                errors.append(f"atomic source archive names mismatch: {names}")
            for member in file_members:
                if member.name.startswith("/") or ".." in Path(member.name).parts:
                    errors.append(f"unsafe archive path: {member.name}")
                    continue
                fh = tar.extractfile(member)
                if fh is None:
                    errors.append(f"unable to read archive member: {member.name}")
                    continue
                data = fh.read()
                source_hashes[member.name] = sha256(data)
                source = data.decode("utf-8")
                numbered = re.findall(r"^#{2,4}\s+(\d{3})\s+[^\n]*$", source, flags=re.M)
                source_counts[member.name] = len(numbered)
                # Every numbered body must contain a complete AGENTIC_PROMPT pair before the next numbered body.
                matches = list(re.finditer(r"^#{2,4}\s+(\d{3})\s+[^\n]*$", source, flags=re.M))
                for idx, match in enumerate(matches):
                    body = source[match.end(): matches[idx + 1].start() if idx + 1 < len(matches) else len(source)]
                    if "<AGENTIC_PROMPT>" not in body or "</AGENTIC_PROMPT>" not in body:
                        errors.append(f"{member.name} numbered prompt {match.group(1)} lacks a complete AGENTIC_PROMPT pair")
    except Exception as exc:
        errors.append(f"atomic source archive validation failed: {exc}")

expected_source_hashes = {
    "security/general-dev-security-testing-prompts.md": meta.get("GENERAL_SOURCE_SHA256"),
    "security/hipaa-software-dev-security-testing-prompts.md": meta.get("HIPAA_SOURCE_SHA256"),
    "security/blockchain-security-testing-prompts.md": meta.get("BLOCKCHAIN_SOURCE_SHA256"),
}
for name, expected_hash in expected_source_hashes.items():
    if source_hashes.get(name) != expected_hash:
        errors.append(f"source SHA-256 mismatch for {name}")
expected_body_counts = {
    "security/general-dev-security-testing-prompts.md": 122,
    "security/hipaa-software-dev-security-testing-prompts.md": 125,
    "security/blockchain-security-testing-prompts.md": 187,
}
if source_counts != expected_body_counts:
    errors.append(f"atomic source numbered-body counts mismatch: {source_counts}")
if sum(source_counts.values()) != 434:
    errors.append(f"supplied original body total {sum(source_counts.values())} != 434")

# Materializer script exists, is syntactically valid, and contains the same hashes.
materializer = exact_block("=== SKELETON scripts/materialize-atomic-sources.sh ===", "=== END SKELETON ===")
for expected_hash in [meta.get("ARCHIVE_SHA256"), meta.get("GENERAL_SOURCE_SHA256"),
                      meta.get("HIPAA_SOURCE_SHA256"), meta.get("BLOCKCHAIN_SOURCE_SHA256")]:
    if expected_hash and expected_hash not in materializer:
        errors.append(f"materializer missing declared hash {expected_hash}")
if materializer:
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, encoding="utf-8") as tmp:
        tmp.write(materializer + "\n")
        temp_path = Path(tmp.name)
    try:
        proc = subprocess.run(["sh", "-n", str(temp_path)], text=True, capture_output=True, check=False)
        if proc.returncode != 0:
            errors.append(f"materializer is not POSIX-shell syntax clean: {proc.stderr.strip()}")
    finally:
        temp_path.unlink(missing_ok=True)

# Embedded suite/source completeness.
e2e_library = exact_block("E2E-SUITE-LIBRARY-BEGIN", "E2E-SUITE-LIBRARY-END")
e2e_ids = re.findall(r"^# (E2E-\d{3}) SOURCE:", e2e_library, flags=re.M)
if e2e_ids != [f"E2E-{i:03d}" for i in range(1, 21)]:
    errors.append(f"E2E source IDs are incomplete/out of order: {e2e_ids}")
supplemental = exact_block("SUPPLEMENTAL-GATES-BEGIN", "SUPPLEMENTAL-GATES-END")
sup_ids = re.findall(r"^## (SUP-\d{3}) --", supplemental, flags=re.M)
if sup_ids != [f"SUP-{i:03d}" for i in range(1, 16)]:
    errors.append(f"supplemental gate IDs are incomplete/out of order: {sup_ids}")
reconstructed = exact_block("BLOCKCHAIN-RECONSTRUCTED-BEGIN", "BLOCKCHAIN-RECONSTRUCTED-END")
bc_recon_ids = re.findall(r"^## (BC-\d{3}) --", reconstructed, flags=re.M)
if bc_recon_ids != [f"BC-{i:03d}" for i in range(8, 23)]:
    errors.append(f"reconstructed Blockchain IDs are incomplete/out of order: {bc_recon_ids}")

# Important contradiction guards.
if "verify.sh runs, in order: preflight, lint, format-check, typecheck, unit, integration, e2e, build" in text.lower():
    errors.append("verify order still places final E2E before build")
if "artifact-bound E2E" not in text:
    errors.append("artifact-bound final E2E requirement missing")
if "A declared long-duration verification dwell" not in text:
    errors.append("long-duration dwell exception to ordinary milestone budget is missing")
if "all 484 tests as BLOCKED_CAPABILITY" in text:
    warnings.append("phrase mentions blanket blocking; ensure it appears only as a forbidden/self-test example")

result = {
    "valid": not errors,
    "errors": errors,
    "warnings": warnings,
    "file": PROMPT.name,
    "bytes": PROMPT.stat().st_size,
    "lines": text.count("\n") + 1,
    "words": len(text.split()),
    "sha256": sha256(PROMPT.read_bytes()),
    "registry_count": len(registry_rows),
    "prefix_counts": prefix_counts,
    "registry_source_status_counts": dict(status_counts),
    "dod_count": len(dod_rows),
    "verification_stages": len(graph_rows),
    "embedded_original_prompt_bodies": sum(source_counts.values()),
    "embedded_source_body_counts": source_counts,
    "embedded_archive_sha256": sha256(archive_data) if archive_data else None,
    "e2e_suite_count": len(e2e_ids),
    "supplemental_gate_count": len(sup_ids),
    "reconstructed_blockchain_count": len(bc_recon_ids),
}
print(json.dumps(result, indent=2, ensure_ascii=False))
sys.exit(0 if not errors else 1)
