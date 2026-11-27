import { runMarmeonJson } from './spawn.ts';

/** One migration of the document `marmeon migrate:status --json` prints. */
export interface MigrationEntry {
  readonly name: string;
  readonly module: string;
  readonly connection: string | null;
  readonly batch: number | null;
  readonly status: 'ran' | 'pending';
}

/** The migration a MySQL database holds as started and not finished, from the `interrupted` key of the document. */
export interface InterruptedEntry {
  readonly name: string;
  readonly module: string;
  readonly direction: string;
  readonly startedAt: string;
}

/** What {@link readMigrationStatus} made of the child: its migrations, warnings and the migration that stopped halfway (`null` when none), or why they could not be read (text for the developer; the stderr in it is redacted by `runMarmeonJson`). */
export type MigrationStatus =
  | { readonly ok: true; readonly migrations: MigrationEntry[]; readonly warnings: string[]; readonly interrupted: InterruptedEntry | null }
  | { readonly ok: false; readonly reason: string };

const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;

const UNREADABLE = 'marmeon migrate:status printed a document this version does not read — update marmeon.';

/**
 * Runs `marmeon migrate:status --json` in `root` as a child process and reads its document: format, size and every field are
 * checked, and fields are copied one by one. The command and its arguments are fixed. An entry without `connection` (an older
 * @marmeon/database) runs on an unknown one, and a document without `interrupted` has no migration that stopped halfway.
 */
export async function readMigrationStatus(root: string, { signal, timeoutMs }: { readonly signal?: AbortSignal; readonly timeoutMs: number }): Promise<MigrationStatus> {
  const run = await runMarmeonJson(root, ['migrate:status', '--json'], { timeoutMs, signal, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES });
  if (run.timedOut) return { ok: false, reason: `The app did not answer in time: migrate:status was stopped after ${Math.round(timeoutMs / 1000)} seconds.` };
  if (signal?.aborted) return { ok: false, reason: 'The call was cancelled; marmeon migrate:status was stopped.' };
  if (run.tooLarge) return { ok: false, reason: 'migrate:status printed more than 16 MiB; the result was dropped.' };
  if (run.code !== 0) {
    return { ok: false, reason: `marmeon migrate:status failed: ${run.stderrTail.trim() || `it ended with code ${run.code}`}. Run it in a terminal to see the whole message.` };
  }
  if (run.document === undefined) return { ok: false, reason: 'marmeon migrate:status did not print one JSON document: something in the app writes to stdout directly.' };
  const document = run.document as { format?: unknown; migrations?: unknown; warnings?: unknown; interrupted?: unknown };
  if (document.format !== 1 || !Array.isArray(document.migrations) || !Array.isArray(document.warnings)) return { ok: false, reason: UNREADABLE };
  const migrations: MigrationEntry[] = [];
  for (const raw of document.migrations as Record<string, unknown>[]) {
    if (raw === null || typeof raw !== 'object' || typeof raw.name !== 'string' || typeof raw.module !== 'string' || (raw.status !== 'ran' && raw.status !== 'pending')) {
      return { ok: false, reason: UNREADABLE };
    }
    migrations.push({
      name: raw.name,
      module: raw.module,
      connection: typeof raw.connection === 'string' ? raw.connection : null,
      batch: typeof raw.batch === 'number' ? raw.batch : null,
      status: raw.status,
    });
  }
  const raw = document.interrupted as Record<string, unknown> | null | undefined;
  let interrupted: InterruptedEntry | null = null;
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || typeof raw.name !== 'string' || typeof raw.module !== 'string' || typeof raw.direction !== 'string' || typeof raw.startedAt !== 'string') return { ok: false, reason: UNREADABLE };
    interrupted = { name: raw.name, module: raw.module, direction: raw.direction, startedAt: raw.startedAt };
  }
  return { ok: true, migrations, warnings: (document.warnings as unknown[]).filter((warning): warning is string => typeof warning === 'string'), interrupted };
}
