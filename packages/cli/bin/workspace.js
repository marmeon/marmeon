/**
 * Whether a package is a member of a pnpm workspace (E187) — how the `bespoke` launcher knows it runs inside the framework's
 * monorepo, where it starts Node with the `@bespokecore/source` condition. A `pnpm-workspace.yaml` above the package lists its
 * directory among `packages`: that makes it a workspace package — not its `package.json`. A copy is none, whatever its manifest
 * says: `pnpm deploy` (and an injected workspace dependency) copies a package with its workspace manifest — `exports` with the
 * source condition included — under `node_modules`, where Node refuses TypeScript (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
 * Such a copy runs its `dist/` like a published package: Node resolves the source condition only when it is given one, and only
 * the launcher gives it.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, sep } from 'node:path';

/** The nearest `pnpm-workspace.yaml` above `dir` lists `dir` among its `packages`. */
export function inWorkspace(dir) {
  const pkg = realpathSync(dir);
  for (let parent = dirname(pkg); ; parent = dirname(parent)) {
    const file = join(parent, 'pnpm-workspace.yaml');
    if (existsSync(file)) return listedIn(readFileSync(file, 'utf8'), relative(parent, pkg).split(sep).join('/'));
    if (dirname(parent) === parent) return false;
  }
}

/** Whether a workspace's `packages` globs (a YAML list; `!` excludes) take in `path` — never a path under `node_modules`. */
export function listedIn(yaml, path) {
  if (path === '' || path.split('/').includes('node_modules')) return false;
  const globs = [];
  let list = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) list = true;
    else if (list && /^\s*-\s/.test(line)) globs.push(unquote(line.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '').trim()));
    else if (list && /^[^\s#]/.test(line)) list = false;
  }
  const matches = (glob) => matchesGlob(path, glob.replace(/\/+$/, ''));
  return globs.some((glob) => !glob.startsWith('!') && matches(glob)) && !globs.some((glob) => glob.startsWith('!') && matches(glob.slice(1)));
}

function unquote(value) {
  return /^(['"])(.*)\1$/.exec(value)?.[2] ?? value;
}
