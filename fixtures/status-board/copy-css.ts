// tsc leaves stylesheets behind: a package ships the ones its compiled modules import next to them.
import { cpSync, globSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

for (const file of globSync('**/*.css', { cwd: 'src' })) {
  mkdirSync(dirname(join('dist', file)), { recursive: true });
  cpSync(join('src', file), join('dist', file));
}
