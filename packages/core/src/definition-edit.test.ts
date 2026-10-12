import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editDefinition, editDefinitionFile, importedBindings } from './definition-edit.ts';
import type { DefinitionEdit } from './definition-edit.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const job = (name = 'SendInvoiceReminderJob'): DefinitionEdit => ({
  define: { name: 'defineModule', from: '@marmeon/core' },
  key: 'jobs',
  add: { element: (n) => n[name]! },
  imports: [{ name, from: `./jobs/${name}.ts` }],
});

const added = (source: string, edit: DefinitionEdit = job()): string => {
  const outcome = editDefinition(source, 'index.ts', edit);
  if (outcome.status !== 'added') throw new Error(`expected added, got ${JSON.stringify(outcome)}`);
  return outcome.source;
};

const manual = (source: string, edit: DefinitionEdit = job()): string => {
  const outcome = editDefinition(source, 'index.ts', edit);
  if (outcome.status !== 'manual') throw new Error(`expected manual, got ${outcome.status}`);
  return outcome.reason;
};

const head = "import { defineModule } from '@marmeon/core';\n";

describe('appending to a list', () => {
  it('extends a single-line list and adds the import after the last import', () => {
    expect(added(`${head}\nexport default defineModule({ name: 'billing', jobs: [A, B] });\n`)).toBe(
      `${head}import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';\n\nexport default defineModule({ name: 'billing', jobs: [A, B, SendInvoiceReminderJob] });\n`,
    );
  });

  it('fills an empty list', () => {
    expect(added(`${head}export default defineModule({ name: 'x', jobs: [] });\n`)).toContain('jobs: [SendInvoiceReminderJob]');
  });

  it('adds a line to a multi-line list, with a trailing comma', () => {
    const source = `${head}export default defineModule({\n  name: 'x',\n  jobs: [\n    A,\n    B,\n  ],\n});\n`;
    expect(added(source)).toBe(
      `${head}import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';\nexport default defineModule({\n  name: 'x',\n  jobs: [\n    A,\n    B,\n    SendInvoiceReminderJob,\n  ],\n});\n`,
    );
  });

  it('adds a line to a multi-line list without a trailing comma', () => {
    const source = `${head}export default defineModule({\n  jobs: [\n    A,\n    B\n  ],\n});\n`;
    expect(added(source)).toContain('    A,\n    B,\n    SendInvoiceReminderJob\n  ],');
  });

  it('keeps a comment on the last element and puts the comma before it', () => {
    const source = `${head}export default defineModule({\n  jobs: [\n    A,\n    B // runs nightly\n  ],\n});\n`;
    expect(added(source)).toContain('    B, // runs nightly\n    SendInvoiceReminderJob\n  ],');
  });

  it('puts the entry first when asked', () => {
    const source = "import { defineApplication } from '@marmeon/core';\nexport default defineApplication({ modules: [system] });\n";
    const outcome = added(source, {
      define: { name: 'defineApplication', from: '@marmeon/core' },
      key: 'modules',
      add: { element: (n) => n.auth!, position: 'first' },
      imports: [{ name: 'auth', from: '#modules/auth', kind: 'default' }],
    });
    expect(outcome).toBe(
      "import { defineApplication } from '@marmeon/core';\nimport auth from '#modules/auth';\nexport default defineApplication({ modules: [auth, system] });\n",
    );
  });

  it('puts the entry first in a multi-line list', () => {
    const source = "import { defineApplication } from '@marmeon/core';\nexport default defineApplication({\n  modules: [\n    system,\n  ],\n});\n";
    expect(
      added(source, {
        define: { name: 'defineApplication', from: '@marmeon/core' },
        key: 'modules',
        add: { element: (n) => n.billing!, position: 'first' },
        imports: [{ name: 'billing', from: '#modules/billing', kind: 'default' }],
      }),
    ).toContain('  modules: [\n    billing,\n    system,\n  ],');
  });
});

describe('adding a missing property', () => {
  it('uses the indentation of the last property (tabs)', () => {
    const source = `${head}export default defineModule({\n\tname: 'x',\n\tproviders: [P],\n});\n`;
    expect(added(source)).toContain("\tname: 'x',\n\tproviders: [P],\n\tjobs: [SendInvoiceReminderJob],\n});");
  });

  it('adds it behind the last property of a single-line object', () => {
    expect(added(`${head}export default defineModule({ name: 'x' });\n`)).toContain("({ name: 'x', jobs: [SendInvoiceReminderJob] })");
  });

  it('fills an empty object', () => {
    expect(added(`${head}export default defineModule({});\n`)).toContain('({ jobs: [SendInvoiceReminderJob] })');
  });

  it('adds a value, or leaves an existing one', () => {
    const edit: DefinitionEdit = {
      define: { name: 'defineModule', from: '@marmeon/core' },
      key: 'migrations',
      add: { value: "new URL('./migrations/', import.meta.url)" },
    };
    expect(added(`${head}export default defineModule({ name: 'x' });\n`, edit)).toContain(
      "({ name: 'x', migrations: new URL('./migrations/', import.meta.url) })",
    );
    expect(editDefinition(`${head}export default defineModule({ name: 'x', migrations: 'modules/x/migrations' });\n`, 'index.ts', edit)).toEqual({
      status: 'present',
    });
  });
});

describe('imports', () => {
  it('joins an existing import of the same module', () => {
    const edit: DefinitionEdit = {
      define: { name: 'defineModule', from: '@marmeon/core' },
      key: 'listeners',
      add: { element: (n) => `${n.listen}(E, L)` },
      imports: [{ name: 'listen', from: '@marmeon/core' }],
    };
    const outcome = added(`${head}export default defineModule({ listeners: [] });\n`, edit);
    expect(outcome).toBe("import { defineModule, listen } from '@marmeon/core';\nexport default defineModule({ listeners: [listen(E, L)] });\n");
    expect(added("import { defineModule, other } from '@marmeon/core';\nexport default defineModule({});\n", edit)).toContain('{ defineModule, listen, other }');
  });

  it('follows aliases', () => {
    const edit: DefinitionEdit = {
      define: { name: 'defineModule', from: '@marmeon/core' },
      key: 'listeners',
      add: { element: (n) => `${n.listen}(E, L)` },
      imports: [{ name: 'listen', from: '@marmeon/core' }],
    };
    const source = "import { defineModule as module, listen as on } from '@marmeon/core';\nexport default module({ listeners: [] });\n";
    expect(added(source, edit)).toContain('listeners: [on(E, L)]');
    expect(added(source, edit)).not.toContain('import { listen');
  });

  it('follows a namespace import', () => {
    const edit: DefinitionEdit = {
      define: { name: 'defineModule', from: '@marmeon/core' },
      key: 'listeners',
      add: { element: (n) => `${n.listen}(E, L)` },
      imports: [{ name: 'listen', from: '@marmeon/core' }],
    };
    const source = "import * as core from '@marmeon/core';\nexport default core.defineModule({ listeners: [] });\n";
    expect(added(source, edit)).toBe("import * as core from '@marmeon/core';\nexport default core.defineModule({ listeners: [core.listen(E, L)] });\n");
  });

  it('reuses a binding of the name from anywhere when asked', () => {
    const edit: DefinitionEdit = {
      define: { name: 'defineModule', from: '@marmeon/core' },
      key: 'listeners',
      add: { element: (n) => `listen(${n.Registered}, L)` },
      imports: [{ name: 'Registered', from: './events/Registered.ts', reuseAnyBinding: true }],
    };
    const source = `${head}import { Registered } from '@marmeon/auth';\nexport default defineModule({ listeners: [] });\n`;
    expect(added(source, edit)).toBe(`${head}import { Registered } from '@marmeon/auth';\nexport default defineModule({ listeners: [listen(Registered, L)] });\n`);
    expect(manual(`${head}import { Registered } from '@marmeon/auth';\nexport default defineModule({ listeners: [] });\n`, { ...edit, imports: [{ name: 'Registered', from: './x.ts' }] })).toContain('already used');
  });

  it('matches relative specifiers without their extension', () => {
    const source = `${head}import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.js';\nexport default defineModule({ jobs: [] });\n`;
    expect(added(source)).toBe(`${head}import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.js';\nexport default defineModule({ jobs: [SendInvoiceReminderJob] });\n`);
  });

  it('copies double quotes and no semicolons', () => {
    const source = 'import { defineModule } from "@marmeon/core"\nexport default defineModule({ jobs: [] })\n';
    expect(added(source)).toBe('import { defineModule } from "@marmeon/core"\nimport { SendInvoiceReminderJob } from "./jobs/SendInvoiceReminderJob.ts"\nexport default defineModule({ jobs: [SendInvoiceReminderJob] })\n');
  });

  it('keeps CRLF line endings', () => {
    const source = `${head}export default defineModule({\n  jobs: [\n    A,\n  ],\n});\n`.replace(/\n/g, '\r\n');
    const outcome = added(source);
    expect(outcome.replace(/\r\n/g, '')).not.toContain('\n');
    expect(outcome).toContain('    A,\r\n    SendInvoiceReminderJob,\r\n  ],');
    expect(outcome).toContain(";\r\nimport { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';\r\n");
  });

  it('puts a new import behind a comment on the last import line', () => {
    const source = "import { defineModule } from '@marmeon/core'; // the kernel\nexport default defineModule({ jobs: [] });\n";
    expect(added(source)).toContain("// the kernel\nimport { SendInvoiceReminderJob }");
  });
});

describe('idempotence', () => {
  it('reports present the second time, whatever the whitespace', () => {
    const first = added(`${head}export default defineModule({ jobs: [A] });\n`);
    expect(editDefinition(first, 'index.ts', job())).toEqual({ status: 'present' });
    const edit: DefinitionEdit = {
      define: { name: 'defineModule', from: '@marmeon/core' },
      key: 'listeners',
      add: { element: () => 'listen(E, L)' },
    };
    expect(editDefinition(`${head}export default defineModule({ listeners: [listen( E,\n L )] });\n`, 'index.ts', edit)).toEqual({ status: 'present' });
  });
});

describe('shapes it leaves alone', () => {
  it.each([
    ['a file that does not parse', `${head}export default defineModule({ jobs: [ );\n`, 'does not parse'],
    ['no call', `${head}export default {};\n`, 'no defineModule'],
    ['two calls', `${head}export const a = defineModule({});\nexport default defineModule({});\n`, 'more than once'],
    ['a definition passed by name', `${head}export default defineModule(definition);\n`, 'not an object'],
    ['a defineModule from elsewhere', "import { defineModule } from './local.ts';\nexport default defineModule({ jobs: [] });\n", 'no defineModule'],
    ['a list in a variable', `${head}export default defineModule({ jobs: allJobs });\n`, 'not a list written out'],
    ['a shorthand property', `${head}export default defineModule({ jobs });\n`, 'not a list written out'],
    ['a spread that may set the key', `${head}export default defineModule({ ...shared, name: 'x' });\n`, 'spread'],
    ['a type alias of the name', `${head}type SendInvoiceReminderJob = string;\nexport default defineModule({ jobs: [] });\n`, 'already used'],
    ['an interface of the name', `${head}interface SendInvoiceReminderJob {}\nexport default defineModule({ jobs: [] });\n`, 'already used'],
    ['a namespace of the name', `${head}export namespace SendInvoiceReminderJob {}\nexport default defineModule({ jobs: [] });\n`, 'already used'],
    ['an import-equals of the name', `${head}import SendInvoiceReminderJob = require('x');\nexport default defineModule({ jobs: [] });\n`, 'already used'],
    ['a spread after the key', `${head}export default defineModule({ jobs: [A], ...shared });\n`, 'spread'],
    ['a key set twice', `${head}export default defineModule({ jobs: [A], jobs: [B] });\n`, 'twice'],
    ['a name bound to a constant', `${head}const SendInvoiceReminderJob = 1;\nexport default defineModule({ jobs: [] });\n`, 'already used'],
    ['a name imported only as a type', `${head}import type { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';\nexport default defineModule({ jobs: [] });\n`, 'only as a type'],
  ])('%s', (_name, source, reason) => {
    expect(manual(source)).toContain(reason);
  });

  it('does not write an entry that breaks the file', () => {
    const edit: DefinitionEdit = { ...job(), add: { element: () => 'A, (' } };
    expect(manual(`${head}export default defineModule({ jobs: [] });\n`, edit)).toContain('the file is left as it was');
  });

  it('reads the real list, not a commented one', () => {
    const source = `${head}// jobs: [Old]\n// modules: [legacy]\nexport default defineModule({ jobs: [A] });\n`;
    const outcome = added(source);
    expect(outcome).toContain('// jobs: [Old]\n');
    expect(outcome).toContain('jobs: [A, SendInvoiceReminderJob]');
  });
});

describe('entries already there', () => {
  it('is present when the existing import differs only in form', () => {
    const edit: DefinitionEdit = {
      define: { name: 'defineApplication', from: '@marmeon/core' },
      key: 'modules',
      add: { element: (n) => n.billing! },
      imports: [{ name: 'billing', from: '#modules/billing', kind: 'default' }],
    };
    const source = "import { defineApplication } from '@marmeon/core';\nimport b from '#modules/billing.ts';\nexport default defineApplication({ modules: [b] });\n";
    expect(editDefinition(source, 'app.ts', edit)).toEqual({ status: 'present' });
  });

  it('does not take another binding of the name for the entry', () => {
    const edit: DefinitionEdit = {
      define: { name: 'defineApplication', from: '@marmeon/core' },
      key: 'modules',
      add: { element: (n) => n.billing! },
      imports: [{ name: 'billing', from: '#modules/billing', kind: 'default' }],
    };
    const head = "import { defineApplication } from '@marmeon/core';\n";
    const tail = 'export default defineApplication({ modules: [billing] });\n';
    expect(manual(`${head}import billing from '#modules/billing-legacy';\n${tail}`, edit)).toContain('already used');
    expect(manual(`${head}const billing = legacy;\n${tail}`, edit)).toContain('already used');
  });

  it('keeps a file and the index of a folder of that name apart', () => {
    const edit = job('A');
    const source = `${head}import { A } from './jobs/A/index.ts';\nexport default defineModule({ jobs: [A] });\n`;
    expect(manual(source, edit)).toContain('already used');
  });

  it('puts a new import behind a block comment on the last import line', () => {
    const source = "import { defineModule } from '@marmeon/core'; /* kernel */\nexport default defineModule({ jobs: [] });\n";
    expect(added(source)).toContain("/* kernel */\nimport { SendInvoiceReminderJob }");
  });
});

describe('editDefinitionFile', () => {
  it('edits the target of a symlink and keeps the link', () => {
    const dir = tempDir('marmeon-definition-edit-');
    const real = join(dir, 'real.ts');
    const link = join(dir, 'index.ts');
    writeFileSync(real, `${head}export default defineModule({ jobs: [] });\n`);
    symlinkSync(real, link);
    expect(editDefinitionFile(link, job()).status).toBe('added');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toContain('jobs: [SendInvoiceReminderJob]');
  });

  it('keeps the mode of the file and leaves a read-only file alone', () => {
    const dir = tempDir('marmeon-definition-edit-');
    const file = join(dir, 'index.ts');
    const source = `${head}export default defineModule({ jobs: [] });\n`;
    writeFileSync(file, source);
    chmodSync(file, 0o664);
    expect(editDefinitionFile(file, job()).status).toBe('added');
    expect(statSync(file).mode & 0o777).toBe(0o664);
    chmodSync(file, 0o444);
    const outcome = editDefinitionFile(file, { ...job('Other') });
    if (process.getuid?.() !== 0) expect(outcome).toEqual({ status: 'manual', reason: expect.stringContaining('not writable') });
    expect(readFileSync(file, 'utf8')).not.toContain('Other');
  });

  it('reports a missing file', () => {
    const dir = tempDir('marmeon-definition-edit-');
    expect(editDefinitionFile(join(dir, 'index.ts'), job())).toEqual({ status: 'manual', reason: expect.stringContaining('does not exist') });
  });

  it('leaves the bytes alone unless it added something', () => {
    const dir = tempDir('marmeon-definition-edit-');
    const file = join(dir, 'index.ts');
    const source = `${head}export default defineModule({ jobs: allJobs });\n`;
    writeFileSync(file, source);
    expect(editDefinitionFile(file, job()).status).toBe('manual');
    expect(readFileSync(file, 'utf8')).toBe(source);
  });

  it('writes an addition and leaves no temporary file', () => {
    const dir = tempDir('marmeon-definition-edit-');
    mkdirSync(join(dir, 'modules'));
    const file = join(dir, 'modules', 'index.ts');
    writeFileSync(file, `${head}export default defineModule({ jobs: [] });\n`);
    expect(editDefinitionFile(file, job()).status).toBe('added');
    expect(readFileSync(file, 'utf8')).toContain('jobs: [SendInvoiceReminderJob]');
    expect(editDefinitionFile(file, job()).status).toBe('present');
    expect(readdirSync(join(dir, 'modules'))).toEqual(['index.ts']);
    expect(existsSync(file)).toBe(true);
  });
});

describe('importedBindings', () => {
  it('lists value and type imports by local name', () => {
    const bindings = importedBindings(
      "import a, { b as c, type D } from './x.ts';\nimport * as ns from 'pkg';\nimport type { E } from 'e';\n",
      'index.ts',
    );
    expect(bindings.get('a')).toEqual({ from: './x.ts', imported: 'default', typeOnly: false });
    expect(bindings.get('c')).toEqual({ from: './x.ts', imported: 'b', typeOnly: false });
    expect(bindings.get('D')?.typeOnly).toBe(true);
    expect(bindings.get('ns')?.imported).toBe('*');
    expect(bindings.get('E')?.typeOnly).toBe(true);
  });
});
