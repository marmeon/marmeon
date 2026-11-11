import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { CommandArgumentsError, Redactor, type Application } from '@marmeon/core';
import { Output } from 'marmeon';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DbQueryCommand } from './commands/db-query.ts';
import { Connections } from './connections.ts';
import { freshDatabase, drivers, silent, type TestDriver } from './__fixtures__/databases.ts';
import { inspectionConnection } from './migrator-connection.ts';
import { Migrator } from './migrations/migrator.ts';
import type { ProjectedColumn, SchemaProjection } from './schema/projection.ts';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/formats/cli-db-query/${name}.json`, import.meta.url), 'utf8'));
}

const column = (name: string, secret = false): ProjectedColumn => ({ name, type: { sqlite: 'text', pgsql: 'text' }, nullable: true, primary: false, identity: false, default: null, secret });
const projection: SchemaProjection = {
  migrations: [],
  tables: new Map([['users', { name: 'users', module: 'app', columns: [column('id'), column('email'), column('password', true)], uniques: [], indexes: [], foreignKeys: [], markers: [] }]]),
};
const migrator = { readProjection: async () => projection, ranProjection: async () => projection, undescribedColumns: async () => ({ columns: new Map(), withheld: new Set() }) } as unknown as Migrator;

const STATEMENTS = [
  'create table users (id integer primary key, email text, password text)',
  "insert into users (id, email, password) values (1, 'a@example.test', 'abc'), (2, 'b@example.test', 'xyz')",
];

interface Setup {
  connections: Connections;
  /** Runs DDL or a write on the database of `connection`, outside the command. */
  exec(statement: string, connection?: string): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;
}

async function setup(driver: TestDriver): Promise<Setup> {
  if (driver === 'sqlite') {
    const directory = tempDir('marmeon-db-query-');
    const files = { default: join(directory, 'app.db'), system: join(directory, 'system.db') };
    const exec = async (statement: string, connection = 'default') => {
      const db = new DatabaseSync(files[connection as keyof typeof files]);
      try {
        db.exec(statement);
      } finally {
        db.close();
      }
    };
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: files.default }, system: { driver: 'sqlite', database: files.system } }, root: directory, logger: silent });
    return {
      connections,
      exec,
      count: async () => {
        const db = new DatabaseSync(files.default, { readOnly: true });
        try {
          return (db.prepare('select count(*) as n from users').get() as { n: number }).n;
        } finally {
          db.close();
        }
      },
      close: async () => connections.destroy(),
    };
  }
  const [app, system] = await Promise.all([freshDatabase('pgsql'), freshDatabase('pgsql')]);
  const connections = new Connections({ connections: { default: app.options, system: system.options }, root: '/', logger: silent });
  return {
    connections,
    exec: async (statement, connection = 'default') => void (await sql.raw(statement).execute(inspectionConnection(connections, connection))),
    count: async () => Number((await sql<{ n: string }>`select count(*) as n from users`.execute(inspectionConnection(connections))).rows[0]!.n),
    close: async () => {
      await connections.destroy();
      await Promise.all([app.drop(), system.drop()]);
    },
  };
}

async function run(connections: Connections, args: string[], options: Record<string, string | boolean> = {}, stdin?: string, using: Migrator = migrator) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
  if (stdin !== undefined) vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([Buffer.from(stdin)]) as never);
  try {
    const code = await new DbQueryCommand(connections, using, new Redactor()).handle({ args, options, output: new Output(), root: '/' } as never);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    vi.restoreAllMocks();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(drivers)('db:query on %s', (driver) => {
  let db: Setup;
  const query = (sqlText: string, options: Record<string, string | boolean> = {}) => run(db.connections, [sqlText], { json: true, ...options });

  beforeAll(async () => {
    db = await setup(driver);
    for (const statement of STATEMENTS) await db.exec(statement);
    await db.exec('create table things (name text)', 'system');
    await db.exec("insert into things (name) values ('from system')", 'system');
  });
  afterAll(async () => db.close());

  it('prints the rows as a table', async () => {
    const { code, stdout, stderr } = await run(db.connections, ['select id, email from users order by id']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toMatch(/^id\s+email\n1\s+a@example\.test\n2\s+b@example\.test\n\n2 rows\n$/);
  });

  it('prints one JSON document, matching the stored format', async () => {
    const { code, stdout, stderr } = await query('select id, email from users order by id');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const document = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(['format', 'connection', 'driver', 'columns', 'rows', 'truncated', 'cut', 'warnings']);
    expect(document).toEqual(fixture(driver === 'sqlite' ? 'v1' : 'v1-pgsql'));
  });

  it('reads the SQL from standard input', async () => {
    const { code, stdout } = await run(db.connections, [], { stdin: true, json: true }, 'select email\nfrom users where id = 2\n');
    expect(code).toBe(0);
    expect(JSON.parse(stdout).rows).toEqual([['b@example.test']]);
  });

  it('queries the connection --database names', async () => {
    const { code, stdout } = await query('select name from things', { database: 'system' });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ connection: 'system', rows: [['from system']] });
  });

  it('keeps --limit rows and says there were more', async () => {
    const { stdout } = await query('select id from users order by id', { limit: '1' });
    expect(JSON.parse(stdout)).toMatchObject({ rows: [[1]], truncated: true });
    const text = await run(db.connections, ['select id from users order by id'], { limit: '1' });
    expect(text.stdout).toContain('1 row, more were left out (--limit=1)');
  });

  it('refuses a write with exit code 3, prints nothing on stdout and leaves the table as it was', async () => {
    for (const options of [{ json: true }, {}]) {
      const { code, stdout, stderr } = await run(db.connections, ['delete from users'], options);
      expect(code).toBe(3);
      expect(stdout).toBe('');
      expect(stderr.length).toBeGreaterThan(0);
    }
    expect(await db.count()).toBe(2);
  });

  it.each(['select password from users', 'select * from users', 'select length(password) from users'])('refuses a secret column: %s', async (statement) => {
    const { code, stdout, stderr } = await query(statement);
    expect(code).toBe(3);
    expect(stdout).toBe('');
    expect(stderr).toContain('users.password');
  });

  it('fails, not throws, for a connection that does not exist', async () => {
    const { code, stdout, stderr } = await query('select 1', { database: 'nowhere' });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('nowhere');
  });

  it('writes the control characters of a cell and of a column name out before they reach the terminal', async () => {
    const hostile = driver === 'sqlite' ? "char(27) || '[2J' || char(13) || char(10) || 'x'" : "chr(27) || '[2J' || chr(13) || chr(10) || 'x'";
    // A stand-in for the console that writes what it is given as it is: the escaping must already be done by the command.
    const table = vi.fn();
    const output = { table, line: vi.fn(), error: vi.fn(), json: vi.fn() };
    const code = await new DbQueryCommand(db.connections, migrator, new Redactor()).handle({ args: [`select ${hostile} as c`], options: {}, output, root: '/' } as never);
    expect(code).toBe(0);
    const [header, rows] = table.mock.calls[0] as [string[], string[][]];
    expect(rows[0]![0]).toBe('\\u001b[2J\\u000d\\u000ax');
    expect([...`${header.join('')}${rows.flat().join('')}`].some((char) => char.charCodeAt(0) < 32)).toBe(false);
  });

  it('writes the control characters of a column name out as well', async () => {
    const table = vi.fn();
    const output = { table, line: vi.fn(), error: vi.fn(), json: vi.fn() };
    const alias = '"a\u001b[2Jb"';
    await new DbQueryCommand(db.connections, migrator, new Redactor()).handle({ args: [`select 1 as ${alias}`], options: {}, output, root: '/' } as never);
    expect((table.mock.calls[0] as [string[]])[0]).toEqual(['a\\u001b[2Jb']);
  });
});

describe('db:query refuses a wrong call with exit code 2', () => {
  let db: Setup;
  beforeAll(async () => {
    db = await setup('sqlite');
    await db.exec(STATEMENTS.join(';'));
  });
  afterAll(async () => db.close());
  const wrong = async (args: string[], options: Record<string, string | boolean> = {}, stdin?: string) => {
    await expect(run(db.connections, args, options, stdin)).rejects.toBeInstanceOf(CommandArgumentsError);
  };

  it('needs exactly one of the argument and --stdin', async () => {
    await wrong(['select 1'], { stdin: true }, 'select 1');
    await wrong([]);
    await wrong(['select 1', 'select 2']);
    await wrong(['   ']);
  });

  it('reads at most 64 KiB from standard input', async () => {
    await wrong([], { stdin: true }, `select '${'a'.repeat(64 * 1024)}'`);
    expect((await run(db.connections, [], { stdin: true, json: true }, `select '${'a'.repeat(60 * 1024)}' as a`)).code).toBe(0);
  });

  it.each([[true], [''], [['a', 'b']]])('takes --database=%j as a wrong call, not as default', async (value) => {
    await expect(run(db.connections, ['select 1'], { database: value } as never)).rejects.toBeInstanceOf(CommandArgumentsError);
  });

  it('refuses --stdin on a terminal instead of waiting for it', async () => {
    vi.spyOn(process, 'stdin', 'get').mockReturnValue({ isTTY: true } as never);
    await wrong([], { stdin: true });
  });

  it.each([['--limit', '0'], ['--limit', '1001'], ['--limit', 'abc'], ['--limit', '1.5'], ['--limit', ''], ['--timeout', '0'], ['--timeout', '61'], ['--timeout', 'x']])('takes %s=%s as a wrong call', async (option, value) => {
    await wrong(['select 1'], { [option.slice(2)]: value });
  });
});

// Only development and test have a development database to look into. Decided positively: a missing or unknown NODE_ENV is no
// reason to run, and nothing is opened before the decision.
describe('db:query outside development and test', () => {
  it.each(['production', 'staging', ''])('refuses with NODE_ENV=%j, before anything is read or opened', async (nodeEnv) => {
    const touched = vi.fn();
    const connections = new Proxy({}, { get: (_target, property) => (touched(String(property)), () => ({ driver: 'sqlite' })) }) as unknown as Connections;
    const projectionRead = vi.fn();
    vi.stubEnv('NODE_ENV', nodeEnv);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
    const code = await new DbQueryCommand(connections, { readProjection: projectionRead } as unknown as Migrator, new Redactor()).handle({ args: ['select 1'], options: { json: true }, output: new Output(), root: '/' } as never);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('db:query runs only in development and test');
    expect(touched).not.toHaveBeenCalled();
    expect(projectionRead).not.toHaveBeenCalled();
  });

  it('runs with NODE_ENV=development', async () => {
    const db = await setup('sqlite');
    try {
      for (const statement of STATEMENTS) await db.exec(statement);
      vi.stubEnv('NODE_ENV', 'development');
      expect((await run(db.connections, ['select 1'], { json: true })).code).toBe(0);
    } finally {
      await db.close();
    }
  });
});

// The database holds what the migrations that ran made, so a pending migration's rename or drop must not make a column readable.
describe('db:query with a pending migration that changes a secret column', () => {
  const pending = (columns: ProjectedColumn[]): SchemaProjection => ({
    migrations: [],
    tables: new Map([['users', { name: 'users', module: 'app', columns, uniques: [], indexes: [], foreignKeys: [], markers: [] }]]),
  });
  it.each([
    ['renames it', pending([column('id'), column('email'), column('password_hash', true)])],
    ['drops it', pending([column('id'), column('email')])],
  ])('still refuses the column when the migration %s', async (_what, afterPending) => {
    const db = await setup('sqlite');
    try {
      for (const statement of STATEMENTS) await db.exec(statement);
      const command = new DbQueryCommand(db.connections, { readProjection: async () => afterPending, ranProjection: async () => projection, undescribedColumns: async () => ({ columns: new Map(), withheld: new Set() }) } as unknown as Migrator, new Redactor());
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
      const code = await command.handle({ args: ['select password from users'], options: { json: true }, output: new Output(), root: '/' } as never);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('users.password');
    } finally {
      await db.close();
    }
  });
});

describe('db:query with the real migrator', () => {
  const create = `import { defineMigration } from '${new URL('./index.ts', import.meta.url).href}';
export default defineMigration({ up: (schema) => schema.create('users', (table) => { table.id(); table.string('email'); table.string('password').secret(); }), down: (schema) => schema.drop('users') });
`;
  const alter = (change: string) => `import { defineMigration } from '${new URL('./index.ts', import.meta.url).href}';
export default defineMigration({ up: (schema) => schema.alter('users', (table) => { ${change} }), down: () => {} });
`;

  it.each([
    ['renames', "table.renameColumn('password', 'password_hash');"],
    ['drops', "table.dropColumn('password');"],
  ])('refuses the column while a pending migration %s it', async (_what, change) => {
    const directory = workspaceTempDir('marmeon-db-query-');
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '2026_01_01_000000_create_users_table.ts'), create);
    const file = join(directory, 'app.db');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: file } }, root: directory, logger: silent });
    const modules = [{ name: 'app', migrations: pathToFileURL(`${migrations}/`) }];
    const real = () => new Migrator({ modules, root: directory } as unknown as Application, connections);
    try {
      await real().migrate();
      const raw = new DatabaseSync(file);
      raw.exec("insert into users (email, password) values ('a@example.test', 'abc')");
      raw.close();
      writeFileSync(join(migrations, '2026_01_02_000000_change_users_table.ts'), alter(change));
      const { code, stdout, stderr } = await run(connections, ['select password from users'], { json: true }, undefined, real());
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('users.password');
    } finally {
      await connections.destroy();
    }
  });

  // What the database holds cannot be told from files that are not what ran: refused rather than guessed.
  const unestablished = async (prepare: (migrations: string, file: string) => Promise<void>, options: Record<string, string | boolean> = {}, statement = 'select password from users') => {
    const directory = workspaceTempDir('marmeon-db-query-');
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    const file = join(directory, 'app.db');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: file }, other: { driver: 'sqlite', database: join(directory, 'other.db') } }, root: directory, logger: silent });
    const modules = [{ name: 'app', migrations: pathToFileURL(`${migrations}/`) }];
    const real = () => new Migrator({ modules, root: directory } as unknown as Application, connections);
    try {
      writeFileSync(join(migrations, '2026_01_01_000000_create_users_table.ts'), create);
      await prepare(migrations, file);
      const { code, stdout, stderr } = await run(connections, [statement], { json: true, ...options }, undefined, real());
      expect(code).toBe(1);
      expect(stdout).toBe('');
      return stderr;
    } finally {
      await connections.destroy();
    }
  };
  const migrateFirst = async (migrations: string, file: string) => {
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: file } }, root: join(file, '..'), logger: silent });
    try {
      await new Migrator({ modules: [{ name: 'app', migrations: pathToFileURL(`${migrations}/`) }], root: join(file, '..') } as unknown as Application, connections).migrate();
    } finally {
      await connections.destroy();
    }
  };

  it('reads the columns the migrations describe', async () => {
    const directory = workspaceTempDir('marmeon-db-query-');
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '2026_01_01_000000_create_users_table.ts'), create);
    const file = join(directory, 'app.db');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: file } }, root: directory, logger: silent });
    const real = new Migrator({ modules: [{ name: 'app', migrations: pathToFileURL(`${migrations}/`) }], root: directory } as unknown as Application, connections);
    try {
      await real.migrate();
      // A pending migration that adds a column changes nothing the database has yet.
      writeFileSync(join(migrations, '2026_01_02_000000_add_nickname.ts'), alter("table.string('nickname').nullable();"));
      const { code, stdout } = await run(connections, ['select id, email from users'], { json: true }, undefined, real);
      expect(code).toBe(0);
      expect(JSON.parse(stdout).rows).toEqual([]);
    } finally {
      await connections.destroy();
    }
  });

  it('refuses a database that has tables and no record of migrations', async () => {
    const stderr = await unestablished(async (_migrations, file) => {
      const raw = new DatabaseSync(file);
      raw.exec(STATEMENTS.join(';'));
      raw.close();
    });
    expect(stderr).toContain('has tables but no record of migrations');
  });

  it('refuses a migration that ran and has no file any more, naming it', async () => {
    const stderr = await unestablished(async (migrations, file) => {
      await migrateFirst(migrations, file);
      rmSync(join(migrations, '2026_01_01_000000_create_users_table.ts'));
    });
    expect(stderr).toContain('2026_01_01_000000_create_users_table');
    expect(stderr).toContain('no module has its file any more');
  });

  it('refuses a migration whose file changed after it ran, naming it', async () => {
    const stderr = await unestablished(async (migrations, file) => {
      await migrateFirst(migrations, file);
      writeFileSync(join(migrations, '2026_01_01_000000_create_users_table.ts'), `${create}// edited\n`);
    });
    expect(stderr).toContain('2026_01_01_000000_create_users_table');
    expect(stderr).toContain('changed after it ran');
  });

  it('refuses a migration whose recorded checksum is missing, as an older record leaves it', async () => {
    const stderr = await unestablished(async (migrations, file) => {
      await migrateFirst(migrations, file);
      const raw = new DatabaseSync(file);
      raw.exec('update migrations set checksum = null');
      raw.close();
      writeFileSync(join(migrations, '2026_01_01_000000_create_users_table.ts'), create.replace('.secret()', ''));
    });
    expect(stderr).toContain('2026_01_01_000000_create_users_table');
    expect(stderr).toContain('no recorded checksum');
  });

  it('refuses a connection that has tables while the record, on default, is not there', async () => {
    const stderr = await unestablished(
      async (_migrations, file) => {
        const raw = new DatabaseSync(join(file, '..', 'other.db'));
        raw.exec(STATEMENTS.join(';'));
        raw.close();
      },
      { database: 'other' },
    );
    expect(stderr).toContain('has tables but no record of migrations');
  });

  const notes = `import { defineMigration } from '${new URL('./index.ts', import.meta.url).href}';
export default defineMigration({ up: (schema) => schema.create('notes', (table) => { table.id(); }), down: (schema) => schema.drop('notes') });
`;

  it('treats a column no migration describes as secret: a migration whose record row was lost, then dropped its column', async () => {
    const stderr = await unestablished(async (migrations, file) => {
      writeFileSync(join(migrations, '2025_01_01_000000_create_notes_table.ts'), notes);
      await migrateFirst(migrations, file);
      const raw = new DatabaseSync(file);
      raw.exec("delete from migrations where name like '%create_users_table'");
      raw.close();
      writeFileSync(join(migrations, '2026_01_02_000000_change_users_table.ts'), alter("table.dropColumn('password');"));
    });
    expect(stderr).toContain('users.password');
    expect(stderr).toContain('No migration describes it');
  });

  it('treats the columns of a migration whose record row was lost as secret, though pending migrations drop and recreate them without secret()', async () => {
    const stderr = await unestablished(async (migrations, file) => {
      writeFileSync(join(migrations, '2025_01_01_000000_create_notes_table.ts'), notes);
      await migrateFirst(migrations, file);
      const raw = new DatabaseSync(file);
      raw.exec("delete from migrations where name like '%create_users_table'");
      raw.close();
      writeFileSync(join(migrations, '2026_01_02_000000_drop_password.ts'), alter("table.dropColumn('password');"));
      writeFileSync(join(migrations, '2026_01_03_000000_add_password.ts'), alter("table.string('password').nullable();"));
    });
    expect(stderr).toContain('users.password');
    expect(stderr).toContain('No migration describes it');
  });

  it('treats a table made by raw SQL as secret, every column of it', async () => {
    const stderr = await unestablished(
      async (migrations, file) => {
        await migrateFirst(migrations, file);
        const raw = new DatabaseSync(file);
        raw.exec('create table raw_notes (id integer primary key, body text)');
        raw.close();
      },
      {},
      'select body from raw_notes',
    );
    expect(stderr).toContain('raw_notes.body');
    expect(stderr).toContain('No migration describes it');
  });

  it('withholds a virtual table whole, without reading its columns: one whose module is not loaded does not stop other queries', async () => {
    const directory = workspaceTempDir('marmeon-db-query-');
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '2026_01_01_000000_create_users_table.ts'), create);
    const file = join(directory, 'app.db');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: file } }, root: directory, logger: silent });
    const real = new Migrator({ modules: [{ name: 'app', migrations: pathToFileURL(`${migrations}/`) }], root: directory } as unknown as Application, connections);
    try {
      await real.migrate();
      const raw = new DatabaseSync(file);
      raw.enableDefensive(false);
      raw.exec('create virtual table DocsFts using fts5(body)');
      raw.exec("pragma writable_schema = on; insert into sqlite_master (type, name, tbl_name, rootpage, sql) values ('table', 'gone', 'gone', 0, 'create virtual table gone using no_such_module(a)')");
      raw.close();
      expect((await run(connections, ['select id, email from users'], { json: true }, undefined, real)).code).toBe(0);
      for (const table of ['DocsFts', 'docsfts', 'gone']) {
        const { code, stderr } = await run(connections, [`select * from ${table}`], { json: true }, undefined, real);
        expect(code, table).toBe(1);
        expect(stderr, table).toContain(table !== 'gone' ? 'No migration describes it' : 'no such module');
      }
    } finally {
      await connections.destroy();
    }
  });

  it('leaves no file behind when the SQLite database is not there', async () => {
    const directory = tempDir('marmeon-db-query-');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: join(directory, 'app.db') } }, root: directory, logger: silent });
    const modules = [{ name: 'app', migrations: pathToFileURL(`${directory}/`) }];
    try {
      const { code } = await run(connections, ['select 1'], { json: true }, undefined, new Migrator({ modules, root: directory } as unknown as Application, connections));
      expect(code).toBe(1);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      await connections.destroy();
    }
  });
});

describe('db:query on a connection that is not managed', () => {
  it('knows no secret column, so every column is readable', async () => {
    const directory = tempDir('marmeon-db-query-');
    const file = join(directory, 'open.db');
    const raw = new DatabaseSync(file);
    raw.exec(STATEMENTS.join(';'));
    raw.close();
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: file, managed: false } }, root: directory, logger: silent });
    try {
      const { code, stdout } = await run(connections, ['select password from users order by id'], { json: true });
      expect(code).toBe(0);
      expect(JSON.parse(stdout).rows).toEqual([['abc'], ['xyz']]);
    } finally {
      await connections.destroy();
    }
  });
});

describe('db:query --managed-only', () => {
  const unmanaged = (directory: string) => {
    const file = join(directory, 'open.db');
    const raw = new DatabaseSync(file);
    raw.exec(STATEMENTS.join(';'));
    raw.close();
    return new Connections({ connections: { default: { driver: 'sqlite', database: file, managed: false } }, root: directory, logger: silent });
  };

  it('refuses a connection that is not managed, before any query runs, and names no file', async () => {
    const directory = tempDir('marmeon-db-query-');
    const connections = unmanaged(directory);
    try {
      const { code, stdout, stderr } = await run(connections, ['select password from users'], { json: true, 'managed-only': true });
      expect(code).toBe(3);
      expect(stdout).toBe('');
      expect(stderr).toContain('not managed');
      expect(stderr).not.toContain(directory);
      expect(stderr).not.toContain('abc');
    } finally {
      await connections.destroy();
    }
  });

  it('leaves a managed connection alone', async () => {
    const db = await setup('sqlite');
    try {
      for (const statement of STATEMENTS) await db.exec(statement);
      expect((await run(db.connections, ['select id from users'], { json: true, 'managed-only': true })).code).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe.runIf(drivers.includes('pgsql' as never))('db:query on Postgres, the limits of a run', () => {
  it('counts a table in a schema off the search path as one no migration describes', async () => {
    const directory = workspaceTempDir('marmeon-db-query-');
    const migrations = join(directory, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '2026_01_01_000000_create_users_table.ts'), `import { defineMigration } from '${new URL('./index.ts', import.meta.url).href}';
export default defineMigration({ up: (schema) => schema.create('users', (table) => { table.id(); table.string('email'); table.string('password').secret(); }), down: (schema) => schema.drop('users') });
`);
    const fresh = await freshDatabase('pgsql');
    const connections = new Connections({ connections: { default: fresh.options }, root: directory, logger: silent });
    const real = new Migrator({ modules: [{ name: 'app', migrations: pathToFileURL(`${migrations}/`) }], root: directory } as unknown as Application, connections);
    try {
      await real.migrate();
      await sql.raw('create schema audit').execute(inspectionConnection(connections));
      await sql.raw('create table audit.api_tokens (id integer, token text)').execute(inspectionConnection(connections));
      expect((await run(connections, ['select id, email from users'], { json: true }, undefined, real)).code).toBe(0);
      const { code, stderr } = await run(connections, ['select token from audit.api_tokens'], { json: true }, undefined, real);
      expect(code).toBe(1);
      expect(stderr).toContain('api_tokens.token');
    } finally {
      await connections.destroy();
      await fresh.drop();
    }
  });

  it('ends a query that runs past --timeout', async () => {
    const db = await setup('pgsql');
    try {
      const { code, stdout, stderr } = await run(db.connections, ['select count(*) from generate_series(1, 1e10)'], { json: true, timeout: '1' });
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/timeout/i);
    } finally {
      await db.close();
    }
  });
});
