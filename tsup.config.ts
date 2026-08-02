import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

// The version the server reports over MCP is the version npm published. Kept
// as one fact rather than two: a constant in the source would drift from
// package.json silently, and nothing about a wrong version number in a
// protocol handshake is visible to whoever is debugging with it.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  dts: true,
  clean: true,
  define: { __PACKAGE_VERSION__: JSON.stringify(version) },
  // The shebang survives so the published bin is directly executable, which
  // is what `npx -y humanpen-mcp` relies on.
  banner: { js: '' },
});
