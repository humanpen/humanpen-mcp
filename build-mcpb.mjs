#!/usr/bin/env node
// Build the MCPB bundle (dist-mcpb/humanpen-mcp.mcpb) that Claude Desktop,
// Smithery and other MCPB hosts install directly.
//
// The bundle must run with nothing but Node on the user's machine, so the
// server is compiled to one self-contained file. Only the stdio transport is
// imported, so the SDK's HTTP side (express, hono, cors...) tree-shakes away:
// ~0.7MB, where bundling node_modules whole would be ~23MB. The manifest lives
// here next to the build, with the version injected from package.json - the
// same keep-one-fact rule as tsup.config.ts.
//
//   npm run build:mcpb
//
// The script ends by spawning the staged server WITHOUT an API key and walking
// a real initialize/tools-list handshake: a keyless start that lists all tools
// is exactly what a directory scanner sees, so the build fails if that breaks.

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const OUT_DIR = 'dist-mcpb';
const STAGE = join(OUT_DIR, 'bundle');
const ARTIFACT = join(OUT_DIR, 'humanpen-mcp.mcpb');
const ARTIFACT_SMITHERY = join(OUT_DIR, 'humanpen-mcp.smithery.mcpb');
const MCPB_BIN = join('node_modules', '.bin', 'mcpb');

// The public-facing copy leads with humanize alone (the flagship); the other
// operations stay discoverable through the tool list itself.
const manifest = {
  manifest_version: '0.2',
  name: 'humanpen-mcp',
  display_name: 'HumanPen',
  version,
  description:
    'A document-level AI humanizer for .docx / .pptx: humanize an entire document, rewrite only ' +
    'selected passages, or automatically target the text a Turnitin / iThenticate AI-detection ' +
    'report flags - editing in place while preserving formatting, tables, images, citations, and formulas.',
  long_description:
    "HumanPen rewrites AI-sounding prose so it reads as human-written and scores lower on AI-detection " +
    "tools, without changing your facts, numbers, tables, or layout. Point it at a .docx or .pptx file " +
    "and it edits the file in place, then hands back the path - never the document's contents. Every " +
    "job spends credits (1,000 words = 100 credits, charged only on the words processed, with a " +
    "10-credit minimum; failed or cancelled jobs cost nothing); new accounts get 100 free credits at " +
    'https://humanpen.net.',
  author: { name: 'HumanPen', url: 'https://humanpen.net' },
  homepage: 'https://humanpen.net',
  documentation: 'https://github.com/humanpen/humanpen-mcp',
  support: 'https://github.com/humanpen/humanpen-mcp/issues',
  repository: { type: 'git', url: 'https://github.com/humanpen/humanpen-mcp' },
  icon: 'icon.png',
  license: 'Apache-2.0',
  keywords: ['humanize', 'ai-detection', 'docx', 'pptx', 'turnitin', 'ithenticate', 'academic-writing'],
  privacy_policies: ['https://humanpen.net/legal/privacy'],
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js'],
      env: { HUMANPEN_API_KEY: '${user_config.api_key}' },
    },
  },
  // `tools` is filled in below from the built server's own tools/list answer,
  // so the static list can never drift from what the server actually serves.
  tools_generated: false,
  user_config: {
    api_key: {
      type: 'string',
      title: 'HumanPen API Key',
      description: 'Create one at https://humanpen.net/settings/api-keys - new accounts get 100 free credits.',
      sensitive: true,
      required: true,
    },
  },
  compatibility: { runtimes: { node: '>=18.0.0' } },
};

/** Spawn the staged server with no key and prove it still introspects. */
async function keylessSmoke(serverPath) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, HUMANPEN_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const tools = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('keyless smoke timed out')), 10_000);
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let cut;
      while ((cut = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, cut).trim();
        buffered = buffered.slice(cut + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          clearTimeout(timer);
          resolve(msg.result.tools);
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}) - a keyless start must serve tools/list`));
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'build-mcpb', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  }).finally(() => child.kill());

  if (tools.length === 0) throw new Error('tools/list came back empty');
  const unannotated = tools.filter((t) => !t.title || t.annotations?.readOnlyHint === undefined).map((t) => t.name);
  if (unannotated.length > 0) {
    throw new Error(`tools missing title/readOnlyHint annotations: ${unannotated.join(', ')}`);
  }
  return tools;
}

/** The first sentence of a tool description - directory cards, not the model,
 * read the manifest, and they want the what, not the operating manual. */
function firstSentence(description) {
  const match = /^(.*?\.)(?:\s|$)/.exec(description ?? '');
  return match ? match[1] : (description ?? '');
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(join(STAGE, 'server'), { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  define: { __PACKAGE_VERSION__: JSON.stringify(version) },
  outfile: join(STAGE, 'server', 'index.js'),
  logLevel: 'warning',
});

// The smoke doubles as the source of truth: hosts that will not execute a
// local bundle (directory pages, pre-install screens) read the manifest's
// tools array, so it is taken verbatim from what the built server answers.
const tools = await keylessSmoke(join(STAGE, 'server', 'index.js'));
manifest.tools = tools.map((t) => ({ name: t.name, description: firstSentence(t.description) }));

writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// "type": "module" is what makes the bundled server/index.js load as ESM.
writeFileSync(
  join(STAGE, 'package.json'),
  `${JSON.stringify({ name: 'humanpen-mcp-bundle', version, private: true, type: 'module' }, null, 2)}\n`,
);
copyFileSync(join('brand', 'humanpen-mcp-logo.png'), join(STAGE, 'icon.png'));

execFileSync(MCPB_BIN, ['validate', join(STAGE, 'manifest.json')], { stdio: 'inherit' });
execFileSync(MCPB_BIN, ['pack', STAGE, ARTIFACT], { stdio: 'inherit' });

// Smithery's registry wants each manifest tool to carry its full inputSchema
// and reads annotations from there too; the MCPB schema allows only name and
// description (additionalProperties: false) and rejects both as unknown keys -
// two consumers, one file, incompatible dialects. So a second archive is
// zipped for Smithery with everything the server answered, and the spec-pure
// .mcpb above stays what Claude Desktop, `mcpb validate` and the release get.
manifest.tools = tools.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  ...(t.annotations ? { annotations: t.annotations } : {}),
  ...(t.title ? { title: t.title } : {}),
}));
writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
rmSync(ARTIFACT_SMITHERY, { force: true });
execFileSync('zip', ['-q', '-r', '-X', join('..', 'humanpen-mcp.smithery.mcpb'), '.'], { cwd: STAGE });

const kb = (statSync(ARTIFACT).size / 1024).toFixed(0);
console.log(
  `\nhumanpen-mcp ${version}: ${ARTIFACT} (${kb} KB, spec-pure) + ${ARTIFACT_SMITHERY} (Smithery dialect), ` +
    `${manifest.tools.length} tools from the server's own answer.`,
);
