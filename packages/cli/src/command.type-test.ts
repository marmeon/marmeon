// Type guarantees of `static commands` on a provider — checked by `tsc` (typecheck), never run.
import { defineApplication } from '@marmeon/core';
import type { Command } from './command.ts';
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
