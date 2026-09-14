#!/usr/bin/env sh
set -eu
python3 -c "
import sys
import os

print('Running EP-000 Discovery Oracle...')

required_files = [
    'rust-toolchain.toml',
    'package.json',
    '.python-version',
    'TOOLCHAIN_PINS.md',
    'INTEGRATION_MATRIX.md'
]

missing = []
for f in required_files:
    if not os.path.exists(f):
        missing.append(f)

if missing:
    print('EP-000 Oracle FAILED: Missing required discovery deliverables:', missing, file=sys.stderr)
    sys.exit(1)

with open('TOOLCHAIN_PINS.md', 'r') as f:
    content = f.read()
    if 'latest' in content.lower():
        print('EP-000 Oracle FAILED: Found forbidden \"latest\" in TOOLCHAIN_PINS.md', file=sys.stderr)
        sys.exit(1)

print('EP-000 Oracle PASSED: Discovery deliverables are present and pinned.')
"
