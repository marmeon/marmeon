import { err, ok, type Result } from '@marmeon/core';
import { AGENTS_BLOCK_FORMAT } from './block.ts';

/** What happened to the text: it was made, the block was replaced or appended, or it was current already. */
export type AgentsChange = 'created' | 'replaced' | 'appended' | 'unchanged';

/** The file has marks the program will not guess about; nothing is written. */
export interface AgentsSyncError {
  readonly kind: 'marks';
  readonly message: string;
}

const BEGIN = /^<!-- marmeon:begin v(\d+) -->$/;
const END = /^<!-- marmeon:end -->$/;
/** A line that tries to be a mark but is none of the two forms. */
const MARK_LIKE = /^<!-- marmeon:(?:begin|end)\b/;

/**
 * Puts `block` (with `\n` line ends) into the text of an `AGENTS.md`. Without text the file is made: a title, the block and a
 * section for the app. With one pair of marks the part from mark to mark is replaced and everything outside stays byte for byte;
 * without marks the block is appended. Any other shape (a mark without its partner, two blocks, the end before the beginning, a
 * version of the marks newer than this one) is an error: the program never guesses where the text of the app ends. A file with
 * `\r\n` line ends gets the block with them. See docs/agents.md#what-belongs-to-the-block-and-what-to-you.
 */
export function syncAgents(whole: string | undefined, block: string, name?: string): Result<{ text: string; change: AgentsChange }, AgentsSyncError> {
  // A byte order mark in front of line 1 is not part of any mark: it stays where it is.
  const bom = whole?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = whole?.slice(bom.length);
  const result = sync(text, block, name);
  return result.ok ? ok({ text: bom + result.value.text, change: result.value.change }) : result;
}

function sync(text: string | undefined, block: string, name?: string): Result<{ text: string; change: AgentsChange }, AgentsSyncError> {
  if (text === undefined) {
    return ok({ text: `# ${name ?? 'This app'}\n\n${block}\n\n## This app\n\nNotes for agents that belong to this app go here.\n`, change: 'created' });
  }
  const crlf = text.includes('\r\n');
  const eol = crlf ? '\r\n' : '\n';
  const inserted = crlf ? block.replaceAll('\n', '\r\n') : block;

  const lines = text.split(/(?<=\n)/);
  const begins: { index: number; version: number }[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    const bare = line.replace(/\r?\n$/, '');
    const begin = BEGIN.exec(bare);
    if (begin) begins.push({ index, version: Number(begin[1]) });
    else if (END.test(bare)) ends.push(index);
    else if (MARK_LIKE.test(bare)) begins.push({ index, version: Number.NaN });
  });

  if (begins.length === 0 && ends.length === 0) {
    const gap = text === '' ? '' : text.endsWith('\n') ? eol : eol + eol;
    return ok({ text: `${text}${gap}${inserted}${eol}`, change: 'appended' });
  }
  if (begins.length !== 1 || ends.length !== 1) return refuse('it holds a mark without its partner, or more than one block. Leave one pair of marks, or none.');
  const [begin] = begins as [{ index: number; version: number }];
  const [end] = ends as [number];
  if (Number.isNaN(begin.version)) return refuse('a mark is not of the form `<!-- marmeon:begin v1 -->` or `<!-- marmeon:end -->` on a line of its own.');
  if (begin.version > AGENTS_BLOCK_FORMAT) return refuse(`its block is marked v${begin.version}, newer than the v${AGENTS_BLOCK_FORMAT} this marmeon writes. Update marmeon.`);
  if (begin.version < 1) return refuse(`its block is marked v${begin.version}, which no marmeon wrote.`);
  if (end < begin.index) return refuse('the end mark comes before the begin mark.');

  const closing = /\r?\n$/.exec(lines[end]!)?.[0] ?? '';
  const next = `${lines.slice(0, begin.index).join('')}${inserted}${closing}${lines.slice(end + 1).join('')}`;
  return ok({ text: next, change: next === text ? 'unchanged' : 'replaced' });
}

function refuse(reason: string) {
  return err({ kind: 'marks' as const, message: `AGENTS.md was left as it is: ${reason}` });
}
