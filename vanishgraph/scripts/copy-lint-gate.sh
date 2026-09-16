#!/usr/bin/env sh
# Vocabulary / copy-lint gate. Sentinel: `copy lint gate: ok`
#
# SPEC-003 VG-API-067 requires the forbidden-synonym rule to be enforced by a COMMAND, and SPEC-004 VG-UI-080
# requires that command to be named in COMMANDS.md before it is used. This is that command: EP-004 M8 adds it for the
# API vocabulary, and EP-005 M2 consumes the same script for the UI copy rules — one gate, one command, not two
# competing scanners.
#
# WHAT IT DOES, in order:
#   1. regenerates the OpenAPI document from the route registry, so the artefact scanned is the routes that EXIST;
#   2. runs the scanner over the document, the registry, the route modules, the DTOs and the application ports;
#   3. fails on a hit with the file, line and token named;
#   4. fails when the allowlist carries an entry with no reason (VG-UI-080), and when the scan read no files at all.
#
# A HIT IS A DEFECT TO FIX, NEVER A BASELINE TO ACCEPT (SPEC-006 §8 row 8).
set -eu
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "copy lint gate: FAIL - node is required but not found" >&2; exit 1; }

# The document is an INPUT to the scan, so it is regenerated first: scanning a stale artefact would let a vocabulary
# regression in the registry pass unnoticed.
node scripts/openapi-document.ts >/dev/null

node scripts/copy-lint-gate.ts
