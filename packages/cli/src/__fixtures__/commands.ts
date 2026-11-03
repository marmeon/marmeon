import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILT_IN } from '../built-in.ts';
import { repo } from './cli.js';

/** Every `static command = '…'` of the code of a package, tests aside: the names `marmeon <command>` can mean. */
export function commandNames(): Set<string> {
  // `list` and `help` are answered by marmeon itself, no class has them.
  const names = new Set(['list', 'help', ...BUILT_IN.map((command) => command.command)]);
  for (const entry of readdirSync(join(repo, 'packages'), { withFileTypes: true })) {
    const src = join(repo, 'packages', entry.name, 'src');
    if (!entry.isDirectory() || !existsSync(src)) continue;
    for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || /\.(?:test|type-test)\.ts$|__fixtures__/.test(file)) continue;
      for (const [, name] of readFileSync(join(src, file), 'utf8').matchAll(/static command = '([^']+)'/g)) names.add(name!);
    }
  }
  return names;
}
