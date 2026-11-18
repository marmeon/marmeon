import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { NAME } from './destination.ts';
import { ChatSetupError } from './errors.ts';

/** The drivers the package ships; `log` is a sink that sends nothing, the others are webhook formats. A provider can bring more (`static chatDrivers`). */
export const BUILT_IN_CHAT_DRIVERS = ['log', 'slack', 'discord', 'teams'] as const;

export const ChatConfig = defineConfig('chat', {
  env: env({
    /**
     * `log` (default: nothing is sent, the log shows where a message would go), `slack`, `discord`, `teams`, or a driver a provider
     * brings. The format of the named destinations of `CHAT_WEBHOOKS` and of every address that names no driver of its own. A
     * name nobody brought stops the start.
     */
    CHAT_DRIVER: env.string().regex(NAME, 'must be a driver name: lowercase letters, digits and dashes').default('log'),
    /**
     * Named destinations as `name=address` entries, comma-separated: `ops=https://…,alerts=https://…`. A webhook address is a
     * secret: whoever has it can post to the channel. It never appears in a log line or an error message.
     */
    CHAT_WEBHOOKS: env.string().default(''),
    NODE_ENV: env.string().optional(),
  }),
  resolve: (e) => ({
    driver: e.CHAT_DRIVER,
    /** The entries as written, split at commas and trimmed; {@link parseWebhooks} reads them at the start and refuses a malformed one. */
    webhooks: e.CHAT_WEBHOOKS.trim() === '' ? [] : e.CHAT_WEBHOOKS.split(',').map((entry) => entry.trim()),
    /** Protected (production, or no `NODE_ENV`): the log sink writes no text, and the boot warns about `CHAT_DRIVER=log` ({@link CHAT_LOG_WARNING}). */
    protected: environment.isProtected(e),
  }),
});
export type ChatConfig = ConfigOf<typeof ChatConfig>;

/** What the boot logs, once per process, when a protected environment (production, no `NODE_ENV`) runs on `CHAT_DRIVER=log`, the default. */
export const CHAT_LOG_WARNING =
  'CHAT_DRIVER=log outside development and tests: no chat message is sent — only each message\'s destination and title are written to the log. ' +
  'Set CHAT_DRIVER=slack, discord or teams and CHAT_WEBHOOKS.';

const ENTRY = /^([a-z][a-z0-9-]*)=(.+)$/;

/**
 * The named destinations of `CHAT_WEBHOOKS`. An entry that is not `name=address` is refused by its position, a name that is listed
 * twice by the name: the address is a secret and stays out of the message.
 * @internal
 */
export function parseWebhooks(entries: readonly string[]): ReadonlyMap<string, string> {
  const webhooks = new Map<string, string>();
  entries.forEach((entry, index) => {
    const match = ENTRY.exec(entry);
    if (match === null) {
      throw new ChatSetupError(
        withCode('S10', `CHAT_WEBHOOKS: entry ${index + 1} is not name=https://… — a name of lowercase letters, digits and dashes, "=", then the address; entries are split at commas.`),
      );
    }
    const [, name, address] = match as unknown as [string, string, string];
    if (webhooks.has(name)) throw new ChatSetupError(withCode('S10', `CHAT_WEBHOOKS: the name "${name}" is listed twice.`));
    webhooks.set(name, address);
  });
  return webhooks;
}
