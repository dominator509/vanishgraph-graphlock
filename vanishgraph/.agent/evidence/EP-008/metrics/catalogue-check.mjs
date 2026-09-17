// THE MODULE IS IMPORTED BY ABSOLUTE URL FROM THE WORKING DIRECTORY, because this check script lives in the evidence
// directory and a relative specifier would resolve against THAT directory. MEASURED: the first version imported
// "./src/adapters/..." and Node looked for the module inside `.agent/evidence/EP-008/metrics/`. File paths below are
// still relative, because `fs` resolves them against the working directory, which the guard sets to the repository root.
const { pathToFileURL } = await import("node:url");
const registry = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/metrics-registry.ts`).href);
const { loadMetricCatalogue, validateDashboard } = registry;
const fs = await import("node:fs");
const path = await import("node:path");

const problems = [];
const loaded = loadMetricCatalogue("./config/metrics/catalogue.json");
if (!loaded.ok) {
  console.log("catalogue: INVALID");
  for (const error of loaded.errors) problems.push(error);
} else {
  console.log(`catalogue: ${loaded.catalogue.families.length} families, all names, labels, owners and meanings valid`);
}

const dashboards = fs.existsSync("./config/dashboards") ? fs.readdirSync("./config/dashboards").filter((f) => f.endsWith(".json")) : [];
let panels = 0;
if (loaded.ok) {
  for (const file of dashboards) {
    const document = JSON.parse(fs.readFileSync(path.join("./config/dashboards", file), "utf8"));
    const list = Array.isArray(document.dashboards) ? document.dashboards : [document];
    for (const dashboard of list) {
      const validation = validateDashboard(dashboard, loaded.catalogue);
      panels += Array.isArray(dashboard.panels) ? dashboard.panels.length : 0;
      if (!validation.ok) for (const error of validation.errors) problems.push(`${file}: ${error}`);
    }
  }
}
console.log(`dashboards: ${dashboards.length} file(s), ${panels} panel(s), every referenced metric registered and every ratio panel naming its denominator`);

const registered = new Set(loaded.ok ? loaded.catalogue.families.map((f) => f.name) : []);
const metricTokens = (text) => [...text.matchAll(/vanishgraph_[a-z0-9_]+/g)].map((m) => m[0]);
for (const [file, owner, key] of [["./config/alerts/catalogue.json", "EP-008 M7", "alerts"], ["./config/slo/objectives.json", "EP-008 M8", "indicators"]]) {
  if (!fs.existsSync(file)) {
    console.log(`${key}: PENDING - ${file} does not exist yet and is owned by ${owner}; this check did not run`);
    continue;
  }
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = document[key] ?? [];
  if (!Array.isArray(entries) || entries.length === 0) problems.push(`${file}: carries no ${key}`);
  for (const entry of entries) {
    const names = metricTokens(JSON.stringify(entry));
    if (names.length === 0) problems.push(`${file}: ${entry.id ?? "an entry"} refers to no metric`);
    for (const name of names) if (!registered.has(name)) problems.push(`${file}: ${entry.id ?? "an entry"} refers to unregistered metric ${name} (VG-OBS-016)`);
  }
  console.log(`${key}: ${entries.length} entr(ies), every referenced metric registered`);
}

const FORBIDDEN_NAMES = ["requests_sent", "requests_submitted", "submissions", "actions_taken", "deletion_rate", "success_rate", "deleted", "permanent_deletion", "permanently_removed"];
// MATCHED AS `_`-BOUNDED SEGMENTS OF THE IDENTIFIER, NOT AS WHOLE TOKENS. MEASURED, AND THE NEGATIVE CONTROL FOUND IT:
// splitting the identifier on `_` and comparing tokens meant `vanishgraph_permanent_deletion_total` produced the tokens
// permanent, deletion, total and the compound ban `permanent_deletion` could NEVER match — so the check reported zero
// hits on a file that carried the prohibited name, which is the "scan that cannot fire" defect this guard exists to
// avoid. A boundary-bounded pattern matches the compound (`_permanent_deletion_`) and the single token (`_deleted_`).
const FORBIDDEN_PATTERNS = FORBIDDEN_NAMES.map((token) => new RegExp(`(^|_)${token}(_|$)`));
const BANNED_PHRASES = [/requests sent/, /requests submitted/, /actions taken/, /permanent deletion/, /permanently removed/, /deletion rate/, /success rate/];
const EXCLUDED = new Set([
  "config/metrics/catalogue.json",
  "src/adapters/observability/metrics-registry.ts",
]);
function walk(dir, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full, found); continue; }
    found.push(full);
  }
  return found;
}
const scanned = [...walk("config"), ...walk("src"), ...walk("docs")].filter((file) => /\.(json|ts|md|mjs)$/.test(file) && !EXCLUDED.has(file));
let hits = 0;
for (const file of scanned) {
  for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    for (const name of metricTokens(line)) {
      if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(name))) { problems.push(`${file}:${index + 1}: prohibited metric identifier ${name}`); hits += 1; }
    }
    if (file.startsWith("config/")) {
      for (const phrase of BANNED_PHRASES) {
        if (phrase.test(line) && !/prohibit|forbidden|never|must not|does not exist/i.test(line)) { problems.push(`${file}:${index + 1}: prohibited metric phrasing "${phrase.source}"`); hits += 1; }
      }
    }
  }
}
console.log(`prohibited names: scanned ${scanned.length} file(s) under config/, src/ and docs/, ${hits} hit(s)`);

if (problems.length > 0) {
  console.log("problems:");
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log("verdict: OK");
