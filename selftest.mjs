/**
 * Drive the server over real stdio JSON-RPC, the way a client does.
 *
 * Importing the module and calling its functions would prove the functions
 * work; it would not prove the server speaks the protocol, registers the
 * tools, or keeps stdout clean. Only spawning it and talking to it does.
 *
 *   HUMANPEN_API_KEY=hp_... node selftest.mjs [document.docx] [report.pdf]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const [documentPath, reportPath] = process.argv.slice(2);

const child = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Anything unparseable on stdout is a protocol violation - a stray
      // console.log would land here and break every client.
      console.log(`  [FAIL] non-JSON on stdout: ${line.slice(0, 120)}`);
      continue;
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

let nextId = 1;
function call(method, params, timeoutMs = 300_000) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'OK ' : 'FAIL'}] ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function payloadOf(response) {
  const raw = response.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

console.log('== 1. initialize');
const initialized = await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'humanpen-selftest', version: '1.0.0' },
});
check('server answers initialize', initialized.result?.serverInfo?.name === 'humanpen',
  JSON.stringify(initialized.result?.serverInfo));
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

console.log('\n== 2. tools/list');
const listed = await call('tools/list', {});
const tools = (listed.result?.tools ?? []).map((tool) => tool.name);
console.log(`  tools: ${tools.join(', ')}`);
const expected = [
  'humanize_document', 'fix_citations', 'condense_document',
  'translate_document', 'read_detection_report', 'check_job', 'get_credit_balance',
];
check('all seven tools registered', expected.every((name) => tools.includes(name)),
  expected.filter((name) => !tools.includes(name)).join(',') || 'none missing');
const described = (listed.result?.tools ?? []).every((tool) => tool.description?.length > 40);
check('every tool carries a description a model can select on', described);
const costed = (listed.result?.tools ?? [])
  .filter((tool) => /humanize_document|fix_citations|condense_document|translate_document/.test(tool.name))
  .every((tool) => /COSTS CREDITS/.test(tool.description ?? ''));
check('the four spending tools say so in their description', costed);

console.log('\n== 3. get_credit_balance');
const balance = await call('tools/call', { name: 'get_credit_balance', arguments: {} });
const balancePayload = payloadOf(balance);
console.log(`  ${JSON.stringify(balancePayload)}`);
check('balance returns a number', typeof balancePayload.available_balance === 'number');

console.log('\n== 4. errors are typed, not prose');
const missing = await call('tools/call', {
  name: 'translate_document',
  arguments: { document_path: '/definitely/not/here.docx', target_lang: 'zh', wait_seconds: 5 },
});
const missingPayload = payloadOf(missing);
console.log(`  ${JSON.stringify(missingPayload)}`);
check('a missing file is an isError result', missing.result?.isError === true);
check('carries a machine-readable code', missingPayload.code === 'FILE_NOT_FOUND', missingPayload.code);
check('says retrying will not help', missingPayload.retryable === false);

if (reportPath && existsSync(reportPath)) {
  console.log('\n== 5. read_detection_report (free)');
  const report = await call('tools/call', {
    name: 'read_detection_report',
    arguments: { report_path: reportPath },
  });
  const reportPayload = payloadOf(report);
  console.log(`  ${JSON.stringify({ ...reportPayload, segments: undefined })}`);
  check('identifies the vendor', ['turnitin', 'ithenticate'].includes(reportPayload.report_type),
    String(reportPayload.report_type));
  check('reports an AI percentage', typeof reportPayload.ai_percent === 'number',
    String(reportPayload.ai_percent));
  check('omits segment texts unless asked', reportPayload.segments === undefined);
}

if (documentPath && existsSync(documentPath)) {
  console.log('\n== 6. translate_document end to end (spends credits)');
  const translated = await call('tools/call', {
    name: 'translate_document',
    arguments: { document_path: documentPath, target_lang: 'zh', wait_seconds: 200 },
  });
  const jobPayload = payloadOf(translated);
  console.log(`  ${JSON.stringify(jobPayload)}`);
  check('job reached DONE', jobPayload.status === 'DONE', String(jobPayload.status));
  check('wrote the result to disk', Boolean(jobPayload.output_path) && existsSync(jobPayload.output_path ?? ''),
    String(jobPayload.output_path));
  check('reported what it charged', typeof jobPayload.credits_charged === 'number',
    String(jobPayload.credits_charged));
  check('did not return the document itself',
    !JSON.stringify(jobPayload).includes('PK'));

  if (jobPayload.job_id) {
    console.log('\n== 7. check_job on the same job');
    const rechecked = await call('tools/call', {
      name: 'check_job',
      arguments: { job_id: jobPayload.job_id },
    });
    const recheckedPayload = payloadOf(rechecked);
    check('check_job finds it finished', recheckedPayload.finished === true);
  }
}

console.log('\n== stdout hygiene');
check('nothing but JSON-RPC was written to stdout', buffer.trim() === '', buffer.slice(0, 80));
check('startup wrote nothing alarming to stderr', !/error|Error/.test(stderr), stderr.slice(0, 120));

child.kill();
console.log(`\n${'='.repeat(56)}`);
if (failures) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log('All checks passed.');
