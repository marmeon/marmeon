import { Container } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { SessionConfig } from '../config.ts';
import { SessionStore } from '../store.ts';

/**
 * `marmeon session:prune`: removes expired sessions — what the lottery does now and then after a response
 * (`SESSION_LOTTERY`), as a command for a scheduler or system cron. Redis sessions expire on their own.
 */
export class PruneSessionsCommand {
  static command = 'session:prune';
  static description = 'Delete expired sessions (database and file drivers)';

  readonly #config: SessionConfig;
  readonly #container: Container;

  constructor(config: SessionConfig, container: Container) {
    this.#config = config;
    this.#container = container;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const { driver, lifetime } = this.#config;
    if (driver === 'redis') {
      output.line(`Nothing to prune: ${driver} sessions expire on their own.`);
      return 0;
    }
    const removed = await this.#container.make(SessionStore).gc(lifetime * 60);
    output.success(`Pruned ${removed} expired ${removed === 1 ? 'session' : 'sessions'} (${driver}).`);
    return 0;
  }
}
