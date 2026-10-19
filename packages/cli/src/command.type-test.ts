// Type guarantees of `static commands` on a provider — checked by `tsc` (typecheck), never run.
import { defineApplication } from '@marmeon/core';
import type { Command, CommandInput } from './command.ts';
import './provider.ts';

class SomeCommand implements Command {
  static readonly command = 'some:run';
  static readonly description = 'Runs';
  handle(): void {}
}

class NotACommand {}

export class Good {
  static commands = [SomeCommand];
  register(): void {}
}

export class Bad {
  static commands = [NotACommand];
  register(): void {}
}

export const good = defineApplication({ root: '.', providers: [Good] });

// @ts-expect-error a class without `static command` is no command
export const bad = defineApplication({ root: '.', providers: [Bad] });

// The prompt of a command: read-only, and its choices are strings.
export function ask({ prompt }: CommandInput): Promise<readonly number[]> {
  // @ts-expect-error interactive is decided by the CLI, a command cannot switch it on
  prompt.interactive = true;
  // @ts-expect-error choices are text
  void prompt.choose('Which?', [1, 2]);
  return prompt.choose('Which?', ['a', 'b'], { multiple: true });
}
