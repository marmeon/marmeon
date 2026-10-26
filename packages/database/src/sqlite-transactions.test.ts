import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { silent } from './__fixtures__/databases.ts';
import { Connections } from './index.ts';

// Web, worker and scheduler share one SQLite file, each with a connection of its own. node:sqlite is synchronous, so a
// competing writer has to be another process: it holds the write lock for a moment, then adds one to the counter.
const WRITER = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
db.exec('begin immediate');
process.stdout.write('locked\\n');
const commit = () => {
  db.exec('update counters set n = n + 1 where id = 1');
  db.exec('commit');
  process.exit(0);
};
// Held until the test says so (a line on stdin), or for a moment.
if (process.argv[2] === 'hold') process.stdin.once('data', commit);
else setTimeout(commit, 400);
`;

/** The other process, once it holds the write lock (`ready`) and once it has committed and exited (`finished`). */
function startWriter(database: string, hold = false): { ready: Promise<void>; finished: Promise<void>; release: () => void } {
  const writer = spawn(process.execPath, ['-e', WRITER, database, ...(hold ? ['hold'] : [])], { stdio: ['pipe', 'pipe', 'inherit'] });
  const finished = new Promise<void>((resolve, reject) => {
    writer.on('error', reject);
    writer.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the other writer exited with ${code}`))));
  });
  const locked = new Promise<void>((resolve) => writer.stdout.once('data', () => resolve()));
  // A writer that dies early fails the test instead of leaving it waiting.
  return { ready: Promise.race([locked, finished]), finished, release: () => writer.stdin.write('go\n') };
}

describe('transactions on a SQLite file that another process writes', () => {
  it('waits for the other writer instead of failing with SQLITE_BUSY', async () => {
    const database = join(tempDir('marmeon-sqlite-begin-'), 'app.db');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database, managed: false } }, root: '/', logger: silent });
    try {
      await sql`create table counters (id integer primary key, n integer not null)`.execute(connections.get());
      await sql`insert into counters (id, n) values (1, 0)`.execute(connections.get());

      const { ready, finished } = startWriter(database);
      await ready;

      // Read, then write: begun lazily, it would read before the other writer commits and then fail to upgrade its snapshot.
      await connections.get<any>().transaction().execute(async (trx) => {
        const row = await trx.selectFrom('counters').select('n').where('id', '=', 1).executeTakeFirstOrThrow();
        await trx.updateTable('counters').set({ n: row.n + 1 }).where('id', '=', 1).execute();
      });
      await finished;

      const row = await connections.get<any>().selectFrom('counters').select('n').executeTakeFirstOrThrow();
      expect(row.n).toBe(2);
    } finally {
      await connections.destroy();
    }
  });

  it('lets a read-only transaction read while the other writer holds the lock', async () => {
    const database = join(tempDir('marmeon-sqlite-begin-'), 'app.db');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database, managed: false } }, root: '/', logger: silent });
    try {
      await sql`create table counters (id integer primary key, n integer not null)`.execute(connections.get());
      await sql`insert into counters (id, n) values (1, 0)`.execute(connections.get());
      const { ready, finished, release } = startWriter(database, true);
      await ready;


      const row = await connections.get<any>().transaction().setAccessMode('read only').execute((trx) => trx.selectFrom('counters').select('n').executeTakeFirstOrThrow());
      // It finished while the other writer still held the lock: the writer commits only after this.
      expect(row.n).toBe(0);
      release();
      await finished;
    } finally {
      await connections.destroy();
    }
  });
});
