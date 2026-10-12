import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { MakeJobCommand, MakeNotificationCommand } from './commands/make.ts';

const MODULE = `import { defineModule } from '@marmeon/core';

export default defineModule({
  name: 'billing',
});
`;

function app(index = MODULE): { root: string; index: string } {
  const root = tempDir('marmeon-make-register-');
  mkdirSync(join(root, 'modules', 'billing'), { recursive: true });
  const file = join(root, 'modules', 'billing', 'index.ts');
  writeFileSync(file, index);
  return { root, index: file };
}

function run(command: { handle(input: any): number }, root: string, args: string[], options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const code = command.handle({ root, args, options: { module: 'billing', ...options }, output });
  return { code, lines: lines.map((line) => stripVTControlCharacters(line)) };
}

const job = (root: string, options: Record<string, unknown> = {}) => run(new MakeJobCommand(), root, ['SendInvoiceReminder'], options);
const notification = (root: string, options: Record<string, unknown> = {}) => run(new MakeNotificationCommand(), root, ['InvoiceOverdue'], options);

describe('make:job and make:notification register themselves', () => {
  it('adds the job and its import to the module', () => {
    const { root, index } = app();
    const { code, lines } = job(root);
    expect(code).toBe(0);
    expect(lines).toContain('✓ Registered SendInvoiceReminderJob in modules/billing/index.ts (jobs)');
    const text = readFileSync(index, 'utf8');
    expect(text.match(/import \{ SendInvoiceReminderJob \} from '\.\/jobs\/SendInvoiceReminderJob\.ts';/g)).toHaveLength(1);
    expect(text).toContain('jobs: [SendInvoiceReminderJob]');
  });

  it('leaves the module byte for byte the same on a second run', () => {
    const { root, index } = app();
    job(root);
    const before = readFileSync(index, 'utf8');
    const { lines } = job(root, { force: true });
    expect(readFileSync(index, 'utf8')).toBe(before);
    expect(lines).toContain('SendInvoiceReminderJob is already registered in modules/billing/index.ts');
  });

  it('registers a job and a notification in one module, and appends to a list written out over lines', () => {
    const { root, index } = app(MODULE.replace("  name: 'billing',", "  name: 'billing',\n  jobs: [\n    Other,\n  ],"));
    writeFileSync(index, `import { Other } from './jobs/Other.ts';\n${readFileSync(index, 'utf8')}`);
    job(root);
    notification(root);
    const text = readFileSync(index, 'utf8');
    expect(text).toContain('  jobs: [\n    Other,\n    SendInvoiceReminderJob,\n  ],');
    expect(text).toContain('notifications: [InvoiceOverdueNotification]');
  });

  it('prints the lines and touches nothing with --no-register', () => {
    const { root, index } = app();
    const { code, lines } = notification(root, { 'no-register': true });
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(MODULE);
    expect(lines).toContain('Register it in modules/billing/index.ts:');
    expect(lines).toContain("  import { InvoiceOverdueNotification } from './notifications/InvoiceOverdueNotification.ts';");
    expect(lines).toContain('  notifications: [InvoiceOverdueNotification]');
  });

  it('falls back to the lines to add when the list is not written out in the module', () => {
    const source = MODULE.replace("  name: 'billing',", "  name: 'billing',\n  jobs: allJobs,");
    const { root, index } = app(source);
    const { code, lines } = job(root);
    expect(code).toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('! Not registered — modules/billing/index.ts: ') && line.endsWith('Add it yourself:'))).toBe(true);
    expect(lines).toContain("  import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';");
    expect(lines).toContain('  jobs: [SendInvoiceReminderJob]');
  });

  it('names the module file, never an absolute path, when the module has no index.ts', () => {
    const { root, index } = app();
    rmSync(index);
    const { code, lines } = job(root);
    expect(code).toBe(0);
    expect(lines.some((line) => line.startsWith('! Not registered — modules/billing/index.ts: modules/billing/index.ts does not exist'))).toBe(true);
    expect(lines.filter((line) => line.includes(root))).toEqual([]);
  });
});
