import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { DevtoolsClearCommand, DevtoolsPruneCommand } from './commands.ts';
import { DevtoolsServiceProvider } from './provider.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

/** An app whose config/devtools.ts throws when it is loaded — and its default storage directory. */
function root(): string {
  const dir = tempDir('marmeon-devtools-commands-');
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config/devtools.ts'), "throw new Error('config/devtools.ts was loaded');\n");
  return dir;
}

const output = () => {
  const lines: string[] = [];
  return { lines, output: { success: (line: string) => lines.push(line), line: (line = '') => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) } };
};

describe('devtools:clear and devtools:prune', () => {
  it('never load config/devtools.ts outside development — they clear the default directory', async () => {
    for (const NODE_ENV of ['production', 'test']) {
      const dir = root();
      const app = await createApplication({ root: dir, discover: false, providers: [DevtoolsServiceProvider] }, { env: { NODE_ENV } });
      try {
        for (const Command of [DevtoolsClearCommand, DevtoolsPruneCommand]) {
          const { lines, output: out } = output();
          const code = await new Command(app).handle({ output: out } as never).catch((error: Error) => `threw: ${error.message}`);
          expect(code, `${NODE_ENV} ${Command.command}: ${String(code)} ${lines.join(' ')}`).toBe(0);
        }
      } finally {
        await app.shutdown();
      }
    }
  });
});
