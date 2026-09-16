#!/usr/bin/env node
/**
 * CLI wrapper: print the generated OpenAPI document (EP-004 M8).
 *
 * WHY A WRAPPER RATHER THAN RUNNING `src/http/openapi/document.ts` DIRECTLY: that module lives under `src/`, and a
 * module that behaves differently when executed rather than imported puts a branch in production code that only a
 * script exercises. This file is the entry point; the document module stays a pure builder.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { buildOpenApiDocument } from '../src/http/openapi/document.ts';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const target = join(PROJECT_ROOT, '.agent', 'evidence', 'openapi.json');
mkdirSync(dirname(target), { recursive: true });
const document = buildOpenApiDocument();
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
process.stdout.write(
  `openapi-document: ${String(Object.keys(document.paths).length)} path(s) written to .agent/evidence/openapi.json\n`,
);
