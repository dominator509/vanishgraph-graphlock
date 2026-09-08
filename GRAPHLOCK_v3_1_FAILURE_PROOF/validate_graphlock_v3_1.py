#!/usr/bin/env python3
"""Structural validator for GraphLock v3.1 Failure-Proof master prompt."""
from __future__ import annotations
import csv, io, json, re, sys, hashlib
from pathlib import Path
p = Path(sys.argv[1] if len(sys.argv) > 1 else '6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md')
text = p.read_text('utf-8')
errors=[]; warnings=[]
def need(s):
    if s.lower() not in text.lower(): errors.append(f'missing token: {s}')
def block(a,b):
    m = re.findall(re.escape(a)+r"\n(.*?)\n"+re.escape(b), text, re.S)
    if len(m)!=1:
        errors.append(f'expected one block {a}..{b}; found {len(m)}'); return ''
    return m[0]
for forbidden,name in [("—","em dash"),("–","en dash"),("“","left smart quote"),("”","right smart quote"),("’","smart apostrophe"),("→","arrow")]:
    if forbidden in text: errors.append(f'forbidden control typography remains: {name}')
for token in [
    '# 6LAYER MASTER PROMPT -- v3.1 "GRAPHLOCK FAILURE PROOF"',
    'The why behind the anti-gaming imperative',
    'Gate gaming is the most epic failure possible',
    'MODE=FORGE_AND_EXECUTE',
    'CLOSED_BLOCKED means',
    'A blocked node is closed for scheduling, not closed as success',
    'Fatal integrity violation',
    'Functional proof matrix law',
    'Generated pack validation law',
    'Test-first transcription law',
    'Architecture drift gate',
    'Real dependency proof law',
    'Credential lane law',
    'Worktree and role isolation law',
    'Hash-chained evidence ledger law',
    'Could a non-functional or fake implementation pass this gate?',
    'RUN_BLOCKED',
    'scripts/validate-generated-pack.py',
    'schemas/blocked-node.schema.json',
    'schemas/anti-gaming-review.schema.json'
]: need(token)
reg = block('MASTER-TEST-REGISTRY-CSV-BEGIN','MASTER-TEST-REGISTRY-CSV-END')
rows=list(csv.DictReader(io.StringIO(reg))) if reg else []
if len(rows)!=484: errors.append(f'registry count {len(rows)} != 484')
dod=block('DOD-REGISTRY-CSV-BEGIN','DOD-REGISTRY-CSV-END')
drows=list(csv.DictReader(io.StringIO(dod))) if dod else []
if len(drows)!=42: errors.append(f'DOD count {len(drows)} != 42')
graph=block('VERIFICATION-GRAPH-TABLE-BEGIN','VERIFICATION-GRAPH-TABLE-END')
stages=[]; deps={}
for line in graph.splitlines():
    m=re.fullmatch(r'STAGE (V-\d{3}) DEPS (.+)', line.strip())
    if not m: errors.append(f'malformed verification graph line: {line}'); continue
    sid=m.group(1); stages.append(sid); deps[sid]=[] if m.group(2)=='-' else m.group(2).split(',')
if stages != [f'V-{i:03d}' for i in range(22)]: errors.append('verification stages are not V-000..V-021')
for sid, ds in deps.items():
    for d in ds:
        if d not in deps: errors.append(f'{sid} depends on missing stage {d}')
vis=set(); stack=set()
def dfs(n):
    if n in stack: errors.append(f'cycle at {n}'); return
    if n in vis: return
    stack.add(n)
    for d in deps.get(n,[]): dfs(d)
    stack.remove(n); vis.add(n)
for s in stages: dfs(s)
if 'STAGE V-013 DEPS V-004,V-006' not in graph: errors.append('DAG branch dependency for V-013 missing')
# Ensure old fatal terminal scheduler wording is gone.
for bad in ['BLOCKED <id> -> the run is terminally halted', 'blocked=$(awk']:
    if bad in text: errors.append(f'old deadlocking scheduler residue remains: {bad}')
result={
  'valid': not errors,
  'errors': errors,
  'warnings': warnings,
  'file': p.name,
  'bytes': p.stat().st_size,
  'lines': text.count('\n')+1,
  'words': len(text.split()),
  'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
  'registry_count': len(rows),
  'dod_count': len(drows),
  'verification_stages': len(stages)
}
print(json.dumps(result, indent=2))
sys.exit(0 if not errors else 1)
