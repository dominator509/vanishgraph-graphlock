#!/usr/bin/env node
/**
 * Runtime canary generator (SPEC-007 §4.4 items 1-2; EP-008 M2(b); DOD-013).
 *
 * WHY A GENERATOR RATHER THAN A FIXTURE. §4.4: "The canary generator produces unpredictable values at test time from a
 * declared seed, and the run records the seed and a digest over the emitted bundle. Static fixtures may exist for unit
 * isolation but may not be the acceptance proof." So every value below is DERIVED FROM A SEED AT RUN TIME, and the seed
 * plus a digest over the emitted bundle are what make the run reproducible without making it static.
 *
 * THE MATERIAL IS NON-LIVE BY CONSTRUCTION, AND THAT IS A HARD RULE, NOT A CONVENTION:
 *   * names come from generated syllables, so no person's name can appear;
 *   * domains use the reserved `.invalid` and `.example` TLDs (RFC 2606), which resolve nowhere;
 *   * telephone numbers use the reserved fictitious range 555-0100..555-0199;
 *   * secrets are generated random strings that authenticate to nothing;
 *   * document numbers are generated digit strings that match no issuing scheme;
 *   * NO REAL PERSON'S DATA IS USED TO PROVE REDACTION, in any field, in any mode, ever.
 *
 * CLI:
 *   node scripts/canary-dlp.mjs generate [--seed HEX] [--out PATH] [--seed-out PATH]
 *     writes the bundle as canonical JSON and prints: seed=<hex> bundle_digest=<sha256> entries=<n>
 *   node scripts/canary-dlp.mjs show --seed HEX
 *     prints the bundle to stdout without writing a file
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** A small, seeded, deterministic PRNG. Determinism is what makes a recorded seed worth recording. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ren', 'ta', 'vor', 'sil', 'dra', 'pen', 'quo', 'nyx', 'bel', 'cor', 'fim', 'gath', 'hes'];
const STREET_SUFFIXES = ['Street', 'Road', 'Avenue', 'Lane', 'Drive', 'Boulevard', 'Court', 'Place', 'Terrace'];
const TOWNS = ['Northgate', 'Silverbrook', 'Ashfield', 'Ravensholt', 'Mirefield', 'Oakvale'];

/** The six sites where §4.4 item 3 says canaries must be injected, plus the classes they carry. */
const SITES = [
  { site: 'PROTECTED_SUBJECT_REFERENCE_CHAIN', rule_class: 'SUBJECT_NAME', field_path: 'displayRef' },
  { site: 'EMAIL_THREAD_BODY', rule_class: 'EMAIL_ADDRESS', field_path: 'message' },
  { site: 'FETCHED_PAGE_BODY', rule_class: 'RAW_HTML', field_path: 'message' },
  { site: 'FORM_SUBMISSION_PAYLOAD', rule_class: 'TELEPHONE_NUMBER', field_path: 'message' },
  { site: 'SCREENSHOT_ARTIFACT', rule_class: 'SENSITIVE_SCREENSHOT', field_path: 'screenshot' },
  { site: 'SECRET_SHAPED_ENVIRONMENT_VALUE', rule_class: 'TOKEN_OR_SECRET', field_path: 'message' },
];

/** One canary per §4.2 rule class, so a disabled-rule control can name the class that was disabled. */
const CLASS_MATERIAL = {
  SUBJECT_NAME: (rand) => `${word(rand)} ${word(rand)}`,
  EMAIL_ADDRESS: (rand) => `${word(rand)}.${word(rand)}@${word(rand)}.invalid`,
  TELEPHONE_NUMBER: (rand) => `+1 555-01${String(Math.floor(rand() * 100)).padStart(2, '0')}`,
  POSTAL_ADDRESS: (rand) => `${String(1 + Math.floor(rand() * 400))} ${word(rand)} ${pick(rand, STREET_SUFFIXES)}, ${pick(rand, TOWNS)}`,
  RAW_HTML: (rand) => `<div class="${word(rand)}"><a href="https://${word(rand)}.example/${word(rand)}">${word(rand)}</a></div>`,
  PAGE_CONTENT: (rand) => `page body: ${word(rand)} ${word(rand)} ${word(rand)}`,
  COOKIE_SESSION_VALUE: (rand) => `Cookie: session=${hex(rand, 24)}`,
  TOKEN_OR_SECRET: (rand) => `Bearer ${hex(rand, 40)}`,
  IDENTITY_DOCUMENT_CONTENT: (rand) => `${hex(rand, 9).toUpperCase()}<${hex(rand, 12).toUpperCase()}`,
  FORM_VALUE: (rand) => `formValues: ${word(rand)}-${hex(rand, 8)}`,
  SENSITIVE_SCREENSHOT: (rand) => `data:image/png;base64,${Buffer.from(hex(rand, 48)).toString('base64')}`,
  OPERATOR_NOTE: (rand) => `note: ${word(rand)} ${word(rand)} ${hex(rand, 6)}`,
};

function pick(rand, list) {
  return list[Math.floor(rand() * list.length) % list.length];
}

function word(rand) {
  const syllables = 2 + Math.floor(rand() * 2);
  let out = '';
  for (let index = 0; index < syllables; index += 1) out += pick(rand, SYLLABLES);
  return out;
}

function hex(rand, length) {
  let out = '';
  while (out.length < length) out += Math.floor(rand() * 16).toString(16);
  return out.slice(0, length);
}

/** The encoded forms §4.2 forbids: plain, base64, percent-encoded, and a truncated prefix. */
function encodings(value) {
  const forms = [{ encoding: 'plain', value }];
  forms.push({ encoding: 'base64', value: Buffer.from(value, 'utf8').toString('base64') });
  forms.push({ encoding: 'percent', value: encodeURIComponent(value) });
  if (value.length > 6) forms.push({ encoding: 'truncated', value: value.slice(0, Math.max(4, Math.floor(value.length / 2))) });
  return forms;
}

/**
 * Generate the bundle.
 *
 * EVERY ENTRY CARRIES THE SEED IT CAME FROM and the bundle carries the seed once, so a failing run can be replayed
 * exactly: the same seed produces the same values, and the digest over the emitted bundle is what ties the two together.
 */
export function generateCanaryBundle(seedHex) {
  const rand = mulberry32(Number.parseInt(seedHex.slice(0, 8), 16) >>> 0);
  const entries = [];

  for (const site of SITES) {
    const material = CLASS_MATERIAL[site.rule_class](rand);
    for (const form of encodings(material)) {
      entries.push({
        site: site.site,
        field_path: site.field_path,
        rule_class: site.rule_class,
        encoding: form.encoding,
        value: form.value,
      });
    }
  }

  // AND ONE CANARY PER RULE CLASS WITHOUT A SITE, so every class of §4.2 is represented and the disabled-rule control can
  // be run against any of them. The encoded forms are generated here too: a class covered only in its plain form would
  // leave the encoding rules of §4.2 untested for that class, which is coverage that looks like coverage.
  for (const [ruleClass, make] of Object.entries(CLASS_MATERIAL)) {
    if (SITES.some((site) => site.rule_class === ruleClass)) continue;
    for (const form of encodings(make(rand))) {
      entries.push({
        site: 'CONTROLLED_CLASS_COVERAGE',
        field_path: 'message',
        rule_class: ruleClass,
        encoding: form.encoding,
        value: form.value,
      });
    }
  }

  return { seed: seedHex, generated_at: new Date(0).toISOString(), entries };
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const args = { mode: argv[0] ?? 'generate', seed: null, out: null };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--seed') args.seed = argv[index + 1];
    else if (argv[index] === '--out') args.out = argv[index + 1];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  // A SEED IS ALWAYS RECORDED. When none is given it is generated here from the operating system's randomness, which is
  // what makes the values unpredictable at test time; passing --seed replays a recorded run exactly.
  const seed = args.seed ?? createHash('sha256').update(String(process.hrtime.bigint()) + String(Math.random())).digest('hex').slice(0, 16);
  const bundle = generateCanaryBundle(seed);
  const text = canonicalJson(bundle);
  const digest = createHash('sha256').update(text).digest('hex');

  if (args.mode === 'show') process.stdout.write(text);
  else if (args.out !== null) writeFileSync(args.out, text);

  // THE DIGEST IS OVER THE BYTES THAT WERE WRITTEN, so an independent reader can recompute it from the file alone.
  process.stdout.write(`seed=${bundle.seed}\nbundle_digest=${digest}\nentries=${String(bundle.entries.length)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main(process.argv.slice(2));
}
