import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKey } from '@bespokecore/encryption';
import type { CommandInput } from '../command.ts';

/**
 * Writes a new `APP_KEY` into `.env` (Laravel's `key:generate`). Runs without
 * booting the app — a missing key is exactly why it cannot boot.
 */
export class KeyGenerateCommand {
  static command = 'key:generate';
  static description = 'Set the application key (APP_KEY) in .env';
  static options = { show: { type: 'boolean' }, force: { type: 'boolean' } } as const;
  static boots = false;

  handle({ options, output, root }: CommandInput): number {
    const key = generateKey();
    if (options.show === true) {
      output.line(key);
      return 0;
    }

    const file = join(root, '.env');
    if (!existsSync(file) && existsSync(join(root, '.env.example'))) copyFileSync(join(root, '.env.example'), file);
    const env = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const line = /^APP_KEY=(.*)$/m.exec(env);

    if (line && line[1]!.trim() !== '' && options.force !== true) {
      output.error('APP_KEY is already set. Replacing it makes existing sessions and encrypted cookies unreadable — use --force.');
      return 1;
    }

    const next = line ? env.replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`) : `${env}${env === '' || env.endsWith('\n') ? '' : '\n'}APP_KEY=${key}\n`;
    writeFileSync(file, next);
    output.success('Application key set in .env.');
    return 0;
  }
}
