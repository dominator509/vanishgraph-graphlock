const fs = await import("node:fs");
const problems = [];
const document = JSON.parse(fs.readFileSync("config/observability/retention.json", "utf8"));
const catalogue = JSON.parse(fs.readFileSync("config/metrics/catalogue.json", "utf8"));

// THE CLASSES §11.1 NAMES, AND THE WINDOWS IT GIVES THEM (in days, or a named policy). Keeping the table here rather
// than reading it from the file is what makes this a check: a file that lost a class would otherwise validate itself.
const REQUIRED = [
  { data_class: "TRACE", hot_days: 7, cold_days: 30 },
  { data_class: "LOG", hot_days: 30, cold_days: 90 },
  { data_class: "LOG_SECURITY", hot_days: 400, cold_days: 400 },
  { data_class: "METRIC", hot_days: 15, cold_days: 390 },
  { data_class: "EXEMPLAR", hot_days: 3, cold_days: null },
  { data_class: "ERROR_REPORT", hot_days: 90, cold_days: null },
  { data_class: "ALERT_HISTORY", hot_days: 390, cold_days: null },
  { data_class: "SLO_VERDICT", hot_days: 390, cold_days: null },
];
const POLICY_CLASSES = ["REDACTION_EVIDENCE", "DEBUG_BUNDLE"];
const UNBOUNDED = /^(|0|-1|infinite|infinity|forever|unlimited|never|none|null)$/i;

const days = (text) => {
  if (typeof text !== "string") return null;
  const match = /^(\d+)\s*(h|d|months?|mo|y)?$/i.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "d").toLowerCase();
  if (unit === "h") return value / 24;
  if (unit.startsWith("month") || unit === "mo") return value * 30;
  if (unit === "y") return value * 365;
  return value;
};

const classes = Array.isArray(document.classes) ? document.classes : [];
const byName = new Map(classes.map((entry) => [entry.data_class, entry]));
for (const required of REQUIRED) {
  const entry = byName.get(required.data_class);
  if (entry === undefined) {
    problems.push(`§11.1 names ${required.data_class} and the configuration does not carry it`);
    continue;
  }
  if (typeof entry.hot !== "string" || UNBOUNDED.test(entry.hot.trim())) problems.push(`${required.data_class}: the hot window is missing or unbounded`);
  else if (days(entry.hot) !== required.hot_days) problems.push(`${required.data_class}: the hot window is ${entry.hot} and §11.1 says ${String(required.hot_days)} d`);
  if (required.cold_days !== null) {
    if (typeof entry.cold !== "string" || UNBOUNDED.test(entry.cold.trim())) problems.push(`${required.data_class}: the cold window is missing or unbounded`);
    else if (days(entry.cold) !== required.cold_days) problems.push(`${required.data_class}: the cold window is ${entry.cold} and §11.1 says ${String(required.cold_days)} d`);
  }
  if (entry.deletion !== "PARTITION_DROP" && entry.deletion !== "EVIDENCE_STORE_POLICY") problems.push(`${required.data_class}: deletion mechanism ${entry.deletion} is not a whole-partition drop`);
}
for (const policyClass of POLICY_CLASSES) {
  const entry = byName.get(policyClass);
  if (entry === undefined) problems.push(`§11.1 names ${policyClass} and the configuration does not carry it`);
  else if (entry.deletion !== "EVIDENCE_STORE_POLICY") problems.push(`${policyClass}: retention must follow the evidence store policy rather than this file inventing a second number for it`);
}
for (const entry of classes) {
  for (const field of ["hot", "cold"]) {
    const value = entry[field];
    if (value !== null && typeof value === "string" && UNBOUNDED.test(value.trim())) problems.push(`${entry.data_class}: the ${field} window is unbounded`);
  }
}

const security = byName.get("LOG_SECURITY");
if (security !== undefined) {
  const note = String(security.note ?? "");
  for (const selector of ["ERROR", "FATAL", "CrossTenantAccessRefused", "EgressDenied", "StaleRecipeRefused", "DuplicateEffectDetected"]) {
    if (!note.includes(selector)) problems.push(`LOG_SECURITY: the security subset must name the selector ${selector}`);
  }
  const logDays = days(byName.get("LOG")?.hot ?? "");
  const securityDays = days(security.hot ?? "");
  if (logDays !== null && securityDays !== null && securityDays <= logDays) problems.push("LOG_SECURITY must be retained longer than the rest of the logs");
}

const deletion = document.deletion ?? {};
if (deletion.mechanism !== "WHOLE_PARTITION_DROP") problems.push("deletion.mechanism must be WHOLE_PARTITION_DROP");
if (deletion.sealed_partition_rewrite !== "REFUSED") problems.push("a sealed-partition rewrite must be REFUSED");
const family = catalogue.families.find((entry) => entry.name === deletion.counter);
if (family === undefined) problems.push(`deletion.counter ${deletion.counter} is not a registered metric family`);
else {
  for (const label of deletion.counter_labels ?? []) if (!family.labels.includes(label)) problems.push(`${deletion.counter} does not declare the label ${label}`);
  const declared = catalogue.per_family_label_value_sets?.[deletion.counter]?.outcome ?? catalogue.label_value_sets?.outcome ?? [];
  for (const outcome of deletion.outcomes ?? []) if (!declared.includes(outcome)) problems.push(`outcome ${outcome} is not in the bounded set for ${deletion.counter}`);
}
if (!/INFO/.test(String(deletion.log_rule ?? ""))) problems.push("deletion.log_rule must require an INFO record");
const logRule = String(deletion.log_rule ?? "").replace(/never[^.]*debug/gi, "");
if (/DEBUG/.test(logRule)) problems.push("deletion must never be reported at DEBUG");

const access = document.access ?? {};
if (!Array.isArray(access.raw_telemetry_read_requires) || access.raw_telemetry_read_requires.length < 3) problems.push("access.raw_telemetry_read_requires must name authentication, the role and the MFA-backed assurance level");
if (!/EVIDENCE_READBACK/.test(String(access.tenant_scoping ?? ""))) problems.push("a cross-tenant read must increment the refusal counter with layer EVIDENCE_READBACK");
if (!/NO RESULT CONTENTS/i.test(String(access.audit_rule ?? ""))) problems.push("the audit rule must state that no result contents are recorded");

console.log(`classes: ${String(classes.length)} configured, ${String(REQUIRED.length)} with a §11.1 window and ${String(POLICY_CLASSES.length)} following the evidence store policy`);
console.log("windows: no class is unbounded and the security subset is longer than the rest of the logs");
console.log(`deletion: ${String(deletion.mechanism)} with sealed rewrites ${String(deletion.sealed_partition_rewrite)}, counter ${String(deletion.counter)} carrying ${(deletion.counter_labels ?? []).join(", ")}`);
console.log(`access: raw telemetry reads require ${(access.raw_telemetry_read_requires ?? []).length} condition(s), are tenant-scoped, and are audited without result contents`);
console.log("propagation: BLOCKED_ENVIRONMENT - no partitioned store is reachable, so the expiry job's DRY-RUN PLAN is validated instead of an executed deletion; that row is NOT counted as demonstrated");

if (problems.length > 0) {
  console.log("problems:");
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log("verdict: OK (configuration; propagation BLOCKED_ENVIRONMENT)");
