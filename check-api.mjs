#!/usr/bin/env node
/**
 * Check this client against the API it actually talks to.
 *
 * A published client rots when the API moves, and it rots in someone else's
 * install rather than in a test run. This asks the live API for its own
 * OpenAPI document and verifies that every path this client builds is one the
 * API still documents.
 *
 * No credentials and no private repository: the OpenAPI document is public, so
 * anyone who forks this can run the same check.
 *
 *   node check-api.mjs
 */
import { readFileSync } from 'node:fs';

const BASE_URL = process.env.HUMANPEN_BASE_URL ?? 'https://api.humanpen.net/v1';
const SOURCES = ['src/client.ts', 'src/index.ts'];

// Paths as the client writes them, template literals included.
const PATH_PATTERN = /['`](\/(?:jobs|files|credits|detect-reports|auth)[^'`\s]*)['`]/g;

/** Reduce an interpolated path to the template form OpenAPI uses. */
function normalize(path) {
  return path.replace(/\$\{[^}]+\}/g, '{id}').replace(/\{[^}]+\}/g, '{id}');
}

async function main() {
  let document;
  try {
    const response = await fetch(`${BASE_URL}/openapi.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    document = await response.json();
  } catch (cause) {
    // A network failure is not a contract failure, and reporting it as one
    // teaches people to ignore this check.
    console.error(`SKIP: could not reach ${BASE_URL}/openapi.json (${cause.message})`);
    process.exit(0);
  }

  const documented = new Set(Object.keys(document.paths ?? {}).map(normalize));
  const called = new Set();
  for (const file of SOURCES) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const [, path] of source.matchAll(PATH_PATTERN)) called.add(normalize(path));
  }

  if (called.size === 0) {
    console.error('FAIL: found no API paths in the client - this check has stopped checking.');
    process.exit(1);
  }

  const missing = [...called].filter((path) => !documented.has(path)).sort();
  if (missing.length > 0) {
    console.error('FAIL: the API no longer documents paths this client calls:');
    for (const path of missing) console.error(`  ${path}`);
    console.error(`\nCompare against ${BASE_URL}/docs.md and update the client.`);
    process.exit(1);
  }

  console.log(`OK: all ${called.size} paths this client calls are documented by ${BASE_URL}.`);
}

main();
