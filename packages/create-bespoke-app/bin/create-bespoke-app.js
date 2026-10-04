#!/usr/bin/env node
/**
 * `pnpm create bespoke-app my-app` · `npm init bespoke-app my-app` · `npx create-bespoke-app my-app` (E150, E167).
 * Plain JavaScript: it runs from node_modules, where Node strips no types. The work is in `dist/main.js` (from `src/main.ts`).
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 26 || (major === 26 && minor < 10)) {
  process.stderr.write(`create-bespoke-app needs Node 26.10 or newer (BespokeCore runs TypeScript natively) — this is Node ${process.versions.node}.\n`);
  process.exit(1);
}
const { main } = await import('../dist/main.js');
process.exitCode = await main();
