#!/usr/bin/env sh
# CI pipeline guard (EP-009 M3(b,c); SPEC-008 section 10 no-masking rules). Sentinel: `ci pipeline: ok`
#
# WHAT IT ASSERTS, AND WHY EACH ASSERTION EXISTS:
#   * THE PIPELINE PARSES. A workflow that does not load is a workflow that does not run, and a guard that
#     inspected it as text would happily pass one. It is parsed with PyYAML; if PyYAML is unavailable the guard
#     FAILS rather than falling back to a text scan, because a check that cannot read its subject must not
#     report on it.
#   * THE STAGE LIST EQUALS scripts/verify.sh's, name for name and script for script. A pipeline that runs a
#     different sequence from the local gate is a second, quieter contract; the two drifting apart is exactly
#     how a green pipeline and a red local gate coexist.
#   * THE ORDER IS CONSISTENT WITH verify.sh: no stage may depend on a stage that verify.sh runs after it.
#     The artifact-bound stages must form a chain, because each one consumes the digest the previous one
#     verified.
#   * NO FAILURE IS MASKED: a step allowed to fail without failing the job, an `or-true` suffix, an exit-code
#     override, errexit disabled and never read, a discarded stderr on a gate, a non-failing matrix, or ANY
#     conditional on a gating job are all failures of this guard. A conditional gate is a masked gate. THE
#     PATTERNS THEMSELVES LIVE IN config/ci/masking-patterns.json AND THE REASON IS RECORDED THERE: this
#     repository's own masking scan reads scripts/*.sh, a validator must contain what it searches for, and
#     rather than adding this script to that scan's exclusion list — which is where a real masking construct
#     would hide — the literals are kept as data so that every line of this script stays scannable.
#   * EVERY GATE RUNS THE REAL COMMAND: each stage job must run `sh scripts/<script>.sh`, the script must
#     exist, and COMMANDS.md must declare that command with a sentinel. A job that runs something else is not
#     the stage it claims to be.
#   * THE ARTIFACT IS BOUND BY DIGEST: the upload name must be derived from the digest computed from
#     ARTIFACT_IDENTITY.json, the upload must fail when files are missing, the identity file must travel with
#     the artifact, and a different job must download it under that digest-derived name and verify it.
#
# WHAT IT DOES NOT DO: it does not run the pipeline, and it does not claim a pipeline has run. Remote
# observation needs the GITHUB_APP_* credentials declared in PREFLIGHT.md, and their state is recorded in the
# milestone evidence rather than here.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "ci pipeline: FAIL - $1" >&2; exit 1; }

[ -f .github/workflows/ci.yml ] || fail ".github/workflows/ci.yml is missing; there is no pipeline to validate"
command -v python3 >/dev/null 2>&1 || fail "python3 is required by this guard (PyYAML parse); refusing to validate a pipeline this check cannot read"

python3 - "$@" <<'ENDS_CI_GUARD'
import json
import os
import re
import sys

try:
    import yaml
except Exception as exc:  # noqa: BLE001 - the message is the point
    print(f"ci pipeline: FAIL - this guard requires PyYAML to parse the workflow ({exc}); refusing to report on a pipeline it cannot read")
    sys.exit(1)

ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'
problems = []
notes = []


def problem(code, detail):
    problems.append((code, detail))


def note(message):
    notes.append(message)


def read(relative):
    with open(os.path.join(ROOT, relative), encoding='utf-8') as handle:
        return handle.read()


workflow_path = '.github/workflows/ci.yml'
raw = read(workflow_path)
try:
    document = yaml.safe_load(raw)
except Exception as exc:  # noqa: BLE001
    problem('WORKFLOW_UNPARSEABLE', f'{workflow_path} is not valid YAML: {exc}')
    document = None

if not isinstance(document, dict):
    problem('WORKFLOW_SHAPE_INVALID', 'the workflow does not load as a mapping')
    document = {}

jobs = document.get('jobs')
if not isinstance(jobs, dict) or not jobs:
    problem('WORKFLOW_SHAPE_INVALID', 'the workflow declares no jobs')
    jobs = {}

# -----------------------------------------------------------------------------------------------------------
# The local gate's stage list, read from verify.sh rather than restated.
# -----------------------------------------------------------------------------------------------------------
verify = read('scripts/verify.sh')
block = re.search(r'STAGES="(.*?)"', verify, re.S)
stages = []
if block is None:
    problem('VERIFY_STAGES_UNPARSEABLE', 'scripts/verify.sh declares no STAGES block, so the pipeline cannot be compared with the local gate')
else:
    for line in block.group(1).strip().split('\n'):
        if ':' not in line:
            continue
        name, script = line.split(':', 1)
        stages.append((name.strip(), script.strip()))
if not stages:
    problem('VERIFY_STAGES_UNPARSEABLE', 'no stages could be parsed from scripts/verify.sh')

stage_names = [name for name, _ in stages]
required_jobs = stage_names + ['artifact-build', 'sbom-provenance']

commands = read('COMMANDS.md')
for name, script in stages:
    if name not in jobs:
        problem('JOB_MISSING', f'the pipeline has no job for the verify.sh stage {name}')
        continue
    if not os.path.exists(os.path.join(ROOT, 'scripts', script)):
        problem('SCRIPT_MISSING', f'stage {name} names scripts/{script}, which does not exist')
    if f'sh scripts/{script}' not in commands:
        problem('COMMAND_UNDECLARED', f'stage {name} runs scripts/{script} and COMMANDS.md declares no sentinel for it')
for name in required_jobs:
    if name not in jobs:
        problem('JOB_MISSING', f'the pipeline has no job named {name}')

if 'sbom-provenance' in jobs:
    sbom_steps = jobs['sbom-provenance'].get('steps', []) if isinstance(jobs['sbom-provenance'], dict) else []
    sbom_text = yaml.safe_dump(sbom_steps)
    if 'sbom_reference' not in sbom_text or 'provenance_reference' not in sbom_text:
        problem('SBOM_JOB_HOLLOW', 'the sbom-provenance job does not assert the SBOM and provenance references from the identity')
if 'artifact-build' in jobs:
    artifact_steps = yaml.safe_dump(jobs['artifact-build'].get('steps', [])) if isinstance(jobs['artifact-build'], dict) else ''
    if 'sh scripts/build-artifact.sh' not in artifact_steps:
        problem('ARTIFACT_JOB_HOLLOW', 'the artifact-build job does not run sh scripts/build-artifact.sh')
    if 'ARTIFACT_IDENTITY.json' not in artifact_steps:
        problem('ARTIFACT_JOB_HOLLOW', 'the artifact-build job does not compute the digest from the published identity')

# -----------------------------------------------------------------------------------------------------------
# Masking scan. THE PATTERNS COME FROM config/ci/masking-patterns.json, and there is no fallback: a guard that
# cannot read its own pattern set would report "no masking found" for a workflow that masks everything, which is
# the worst possible failure mode for this check.
#
# THE SCAN READS THE PARSED WORKFLOW, NOT THE FILE TEXT, and that is a correction rather than a convenience: the
# first version scanned the raw file and reported three masking findings that were the words themselves inside
# this workflow's own comment explaining that they are forbidden. A comment cannot mask a failure, and a check
# that fails on prose trains its reader to ignore it. Every executable line of a workflow lives in a `run`
# string or an action input, so the parsed structure covers every place a failure can be hidden, and nothing
# else.
# -----------------------------------------------------------------------------------------------------------
patterns_path = os.path.join(ROOT, 'config/ci/masking-patterns.json')
try:
    with open(patterns_path, encoding='utf-8') as handle:
        pattern_document = json.load(handle)
    MASKING = [(entry['id'], entry['pattern']) for entry in pattern_document['patterns']]
    if not MASKING:
        problem('PATTERNS_EMPTY', 'config/ci/masking-patterns.json declares no patterns, so the masking scan would pass everything')
except Exception as exc:  # noqa: BLE001
    problem('PATTERNS_UNREADABLE', f'config/ci/masking-patterns.json could not be read ({exc}); a masking scan with no patterns reports nothing and proves nothing')
    MASKING = []

dumped = yaml.safe_dump(jobs)
for code, pattern in MASKING:
    if re.search(pattern, dumped, re.M):
        problem(code, 'the workflow contains a construct that can hide a failure')

# A STEP-LEVEL unconditional guard makes a step run after a failure as though nothing happened, so it is reported
# as a structural property of the parsed job rather than as a text pattern.
for name, job in jobs.items():
    if not isinstance(job, dict):
        continue
    for step in job.get('steps', []):
        if isinstance(step, dict) and 'always(' in str(step.get('if', '')):
            problem('MASK_ALWAYS', f'a step in job {name} runs unconditionally after a failure')

# -----------------------------------------------------------------------------------------------------------
# Job shape: a gate must be runnable and must not be conditional.
# -----------------------------------------------------------------------------------------------------------
needs_map = {}
for name, job in jobs.items():
    if not isinstance(job, dict):
        problem('JOB_SHAPE_INVALID', f'job {name} is not a mapping')
        continue
    if 'runs-on' not in job:
        problem('JOB_SHAPE_INVALID', f'job {name} declares no runner')
    if 'if' in job:
        problem('MASK_JOB_LEVEL_IF', f'job {name} is conditional, so it can be skipped without failing')
    needs = job.get('needs', [])
    if isinstance(needs, str):
        needs = [needs]
    needs_map[name] = [item for item in needs if isinstance(item, str)]
    steps = job.get('steps', [])
    if not isinstance(steps, list) or not steps:
        problem('JOB_SHAPE_INVALID', f'job {name} declares no steps')
        continue
    uses = [step.get('uses', '') for step in steps if isinstance(step, dict)]
    runs = [step.get('run', '') for step in steps if isinstance(step, dict)]
    if not any(str(item).startswith('actions/checkout') for item in uses):
        problem('JOB_SHAPE_INVALID', f'job {name} does not check the repository out')
    if not any('npm ci' in str(item) for item in runs):
        problem('JOB_SHAPE_INVALID', f'job {name} does not install the locked dependencies, so it does not test this tree')

for name, script in stages:
    job = jobs.get(name)
    if not isinstance(job, dict):
        continue
    runs = [str(step.get('run', '')) for step in job.get('steps', []) if isinstance(step, dict)]
    expected = f'sh scripts/{script}'
    if not any(expected in item for item in runs):
        problem('STAGE_COMMAND_MISMATCH', f'job {name} does not run `{expected}`, so it is not the stage verify.sh runs')

# -----------------------------------------------------------------------------------------------------------
# Order: reachability may never contradict the local gate's sequence, and the artifact-bound stages must chain.
# -----------------------------------------------------------------------------------------------------------
ancestors = {}


def ancestors_of(name, seen=None):
    if name in ancestors:
        return ancestors[name]
    if seen is None:
        seen = set()
    if name in seen:
        return set()
    seen.add(name)
    result = set()
    for parent in needs_map.get(name, []):
        result.add(parent)
        result |= ancestors_of(parent, seen)
    ancestors[name] = result
    return result


present_stages = [name for name in stage_names if name in jobs]
for earlier_index, earlier in enumerate(present_stages):
    for later in present_stages[earlier_index + 1:]:
        if later in ancestors_of(earlier):
            problem('STAGE_ORDER_INVERTED', f'verify.sh runs {earlier} before {later}, and the pipeline makes {earlier} depend on {later}')

CHAIN = ['artifact-build', 'artifact-identity', 'smoke', 'e2e', 'live-fire']
for previous, following in zip(CHAIN, CHAIN[1:]):
    if previous in jobs and following in jobs:
        if previous not in ancestors_of(following):
            problem('ARTIFACT_CHAIN_BROKEN', f'{following} does not depend on {previous}, so it can run without the digest that stage verified')

# -----------------------------------------------------------------------------------------------------------
# Artifact binding: digest-derived name, no empty upload, identity travels with the artifact.
# -----------------------------------------------------------------------------------------------------------
upload_steps = []
for name, job in jobs.items():
    if not isinstance(job, dict):
        continue
    for step in job.get('steps', []):
        if isinstance(step, dict) and str(step.get('uses', '')).startswith('actions/upload-artifact'):
            upload_steps.append((name, step))
if not upload_steps:
    problem('UPLOAD_MISSING', 'no job uploads the artifact')
for name, step in upload_steps:
    with_block = step.get('with', {}) or {}
    upload_name = str(with_block.get('name', ''))
    paths = str(with_block.get('path', ''))
    if 'outputs.' not in upload_name or 'sha256' not in upload_name:
        problem('UPLOAD_NOT_DIGEST_KEYED', f'the upload in job {name} is not named after the artifact digest')
    if str(with_block.get('if-no-files-found', '')) != 'error':
        problem('UPLOAD_EMPTY_ALLOWED', f'the upload in job {name} does not fail when the artifact is missing')
    if 'dist/' not in paths or 'ARTIFACT_IDENTITY.json' not in paths:
        problem('UPLOAD_OMITS_IDENTITY', f'the upload in job {name} does not carry dist/ and the published identity together')
    job_outputs = jobs.get(name, {}).get('outputs', {}) or {}
    if not any('steps.' in str(value) for value in job_outputs.values()):
        problem('UPLOAD_DIGEST_UNPUBLISHED', f'job {name} uploads under a digest it does not publish as a job output, so no downstream job can name it')

digest_producers = sum(1 for name, job in jobs.items() if isinstance(job, dict) and 'ARTIFACT_IDENTITY.json' in yaml.safe_dump(job))
if digest_producers == 0:
    problem('DIGEST_UNCOMPUTED', 'no job computes the digest from ARTIFACT_IDENTITY.json')

downloads = []
for name, job in jobs.items():
    if not isinstance(job, dict):
        continue
    for step in job.get('steps', []):
        if isinstance(step, dict) and str(step.get('uses', '')).startswith('actions/download-artifact'):
            downloads.append((name, step))
if not downloads:
    problem('DOWNLOAD_MISSING', 'no job consumes the uploaded artifact, so nothing is verified from it')
for name, step in downloads:
    with_block = step.get('with', {}) or {}
    if 'needs.' not in str(with_block.get('name', '')) or 'outputs.' not in str(with_block.get('name', '')):
        problem('DOWNLOAD_NOT_DIGEST_KEYED', f'the download in job {name} is not keyed by the digest another job published')

# -----------------------------------------------------------------------------------------------------------
# Triggers and reporting.
# -----------------------------------------------------------------------------------------------------------
triggers = document.get('on') or document.get(True) or {}
if isinstance(triggers, list):
    triggers = {item: None for item in triggers}
if not isinstance(triggers, dict):
    problem('TRIGGERS_INCOMPLETE', 'the workflow declares no triggers')
else:
    if 'push' not in triggers:
        problem('TRIGGERS_INCOMPLETE', 'the workflow does not run on push')
    if 'pull_request' not in triggers:
        problem('TRIGGERS_INCOMPLETE', 'the workflow does not run on pull_request')

note(f'workflow: {len(jobs)} job(s) parsed: {", ".join(sorted(jobs))}')
note(f'local gate: {len(stages)} stage(s) parsed from scripts/verify.sh')
note(f'masking scan: {len(MASKING)} construct(s) checked in the PARSED workflow (comments cannot mask a failure, and a scan that reads them reports prose), {sum(1 for code, pattern in MASKING if re.search(pattern, dumped, re.M))} present')
note(f'artifact binding: {len(upload_steps)} upload(s), {len(downloads)} download(s), digest keyed')

for message in notes:
    print(f'ci pipeline: note - {message}')
if problems:
    for code, detail in problems:
        print(f'ci pipeline: FAIL - {code} {detail}')
    print(f'ci pipeline: FAIL - {len(problems)} finding(s); no pipeline claim is made')
    sys.exit(1)
print(f'ci pipeline: validated ({len(jobs)} job(s): {", ".join(sorted(jobs))})')
ENDS_CI_GUARD

echo "ci pipeline: ok"
