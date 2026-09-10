#!/usr/bin/env sh
set -e
set -u
echo "test-e2e.sh: accounted"
python3 -m unittest discover -s tests/e2e -p "test_*.py"
