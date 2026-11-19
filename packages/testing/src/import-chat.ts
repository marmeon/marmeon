import { importOptional } from './optional-peer.ts';

type ChatModules = typeof import('@marmeon/chat-notifications') & typeof import('@marmeon/chat-notifications/testing');

/** The two entries of @marmeon/chat-notifications `createTestApp()` needs. */
const loadChat = async (): Promise<ChatModules> => ({ ...(await import('@marmeon/chat-notifications')), ...(await import('@marmeon/chat-notifications/testing')) });

/**
 * `undefined` only when @marmeon/chat-notifications is not installed; any other load failure throws, so a test never runs
 * against the real notifier by accident.
 * `load` is replaceable by a test. @internal
 */
export async function importChat(load: () => Promise<ChatModules> = loadChat): Promise<ChatModules | undefined> {
  return importOptional('@marmeon/chat-notifications', load);
}
