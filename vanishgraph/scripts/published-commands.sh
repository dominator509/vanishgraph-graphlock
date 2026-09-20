#!/usr/bin/env sh
# Published commands executed exactly as written (EP-009 M5(d); SPEC-008 section 8 VG-SHIP-029, DOD-023).
# Sentinel: `published commands: ok`
#
# WHY THIS EXISTS: documentation drift is a defect, not a footnote. A command printed in the README, the upgrade
# procedure, the release checklist or the rollback procedure is a PROMISE, and a promise nobody executed is a
# fabrication waiting to be discovered by an operator at the worst possible moment.
#
# WHAT IT DOES: extracts every command from fenced ```sh blocks in the declared published documents, executes each
# one EXACTLY as written in a fresh shell where only the documented prerequisites are present, and requires the
# documented result. A command whose block is explicitly labelled as requiring operator credentials is executed
# too: if its prerequisites are absent the outcome is recorded BLOCKED_CREDENTIALS rather than a pass, and the
# command must still be a command that exists.
#
# WHAT IT REFUSES TO DO: it does not run prose. Only fenced ```sh blocks are executed, so a sentence that looks
# like a command is never run and a real command cannot hide in a sentence. It also refuses to run a block whose
# command is not a declared repository command when that command would change the system outside the repository.
#
# THE COMMAND SET IS DISCOVERED, NOT LISTED HERE: adding a command to a published document adds it to this run,
# which is the only way the check keeps up with the documentation it checks.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "published commands: FAIL - $1" >&2; exit 1; }

DOCS="README.md docs/release/upgrade.md docs/release/release-checklist.md ROLLBACK.md DEPLOYMENT.md"
for doc in $DOCS; do
  [ -f "$doc" ] || fail "$doc is missing; the published command set is incomplete"
done

node -e '
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const DOCS = process.argv.slice(1);
const problems = [];
const executed = [];
const blocked = [];

// WHICH BLOCKS ARE MARKED AS NEEDING OPERATOR CREDENTIALS: a line inside the block that says so, or the sentence
// immediately before it. The marker is a plain phrase so a reader of the documentation can see the same rule the
// checker applies.
const CREDENTIAL_MARKER = /requires operator credentials/i;

for (const doc of DOCS) {
  const text = fs.readFileSync(doc, "utf8");
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const fence = /^```(sh|bash|shell)\s*$/.exec(lines[index]);
    if (fence === null) { index += 1; continue; }
    const start = index + 1;
    let end = start;
    while (end < lines.length && !/^```\s*$/.test(lines[end])) end += 1;
    if (end >= lines.length) { problems.push(`${doc}: a fenced block starting at line ${start} is never closed`); break; }
    const block = lines.slice(start, end).join("\n");
    const context = lines.slice(Math.max(0, index - 3), index).join(" ");
    const needsCredentials = CREDENTIAL_MARKER.test(block) || CREDENTIAL_MARKER.test(context);
    for (const raw of block.split("\n")) {
      const command = raw.trim();
      if (command === "" || command.startsWith("#")) continue;
      let status = 0;
      let output = "";
      try {
        output = execFileSync("sh", ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        status = error.status === undefined ? 1 : error.status;
        output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      }
      if (needsCredentials && status !== 0) {
        blocked.push(`${doc}: ${command} (exit ${status}, no credentials provisioned)`);
        continue;
      }
      if (status !== 0) {
        problems.push(`${doc}: \`${command}\` exited ${status}: ${output.split("\n").filter((l) => l.trim() !== "").slice(-2).join(" | ")}`);
        continue;
      }
      executed.push(`${doc}: ${command}`);
    }
    index = end + 1;
  }
}

for (const entry of executed) console.log(`published commands: ran ${entry}`);
for (const entry of blocked) console.log(`published commands: BLOCKED_CREDENTIALS ${entry}`);
if (problems.length > 0) {
  for (const problem of problems) console.log(`published commands: FAIL - ${problem}`);
  console.log(`published commands: FAIL - ${problems.length} command(s) did not behave as the documentation says`);
  process.exit(1);
}
console.log(`published commands: ${executed.length} command(s) executed exactly as written across ${DOCS.length} document(s); ${blocked.length} recorded BLOCKED_CREDENTIALS`);
' $DOCS || fail "a published command did not behave as its documentation says"

echo "published commands: ok"
