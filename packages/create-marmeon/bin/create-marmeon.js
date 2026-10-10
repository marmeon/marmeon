#!/usr/bin/env node
/**
 * `pnpm create marmeon my-app` · `npm create marmeon@latest my-app` · `npx create-marmeon my-app`.
 * Plain JavaScript: it runs from node_modules, where Node strips no types. The work is in `dist/main.js` (from `src/main.ts`).
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 26 || (major === 26 && minor < 10)) {
  process.stderr.write(`create-marmeon needs Node 26.10 or newer (Marmeon runs TypeScript natively) — this is Node ${process.versions.node}.\n`);
  process.exit(1);
}
const { main } = await import('../dist/main.js');
process.exitCode = await main();
