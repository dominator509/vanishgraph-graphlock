#!/usr/bin/env sh
# EP-001 M1(a) discovery inventory. Run from the repo root.
# Real output only: every line below is produced by an executed command.
set -u
cd "$(dirname "$0")/../../.."

echo "== repository =="
git rev-parse --show-toplevel
git status --porcelain=v1

echo "== toolchain =="
node --version
npm --version
git --version
docker --version
psql --version
python3 --version

echo "== lockfile =="
git ls-files --error-unmatch package-lock.json && echo "lockfile: TRACKED"
node -e "const c=require('node:crypto'),f=require('node:fs');console.log('lockfile sha256:',c.createHash('sha256').update(f.readFileSync('package-lock.json')).digest('hex'))"

echo "== scripts =="
ls -1 scripts/*.sh scripts/*.mjs | sort

echo "== graph =="
sh scripts/ledger.sh status EP-000
