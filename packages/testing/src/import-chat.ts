type ChatModules = typeof import('@marmeon/chat-notifications') & typeof import('@marmeon/chat-notifications/testing');

/** The two entries of @marmeon/chat-notifications `createTestApp()` needs. */
const loadChat = async (): Promise<ChatModules> => ({ ...(await import('@marmeon/chat-notifications')), ...(await import('@marmeon/chat-notifications/testing')) });

// The package itself as the missing one: `Cannot find package '@marmeon/chat-notifications' imported from …`. An error that names
// another package (a dependency of it) or only the importer's path is a broken install, not an absent package.
const MISSING = /^Cannot find (?:package|module) '@marmeon\/chat-notifications(?:\/[^']*)?'/;

/**
 * @marmeon/chat-notifications is an optional peer, like the session: `undefined` only when the package is not installed. Any other
 * failure to load it (a broken install, a syntax error) is thrown, so a test never runs against the real notifier by accident.
 * `load` is the import, replaceable by a test. @internal
 */
export async function importChat(load: () => Promise<ChatModules> = loadChat): Promise<ChatModules | undefined> {
  try {
    return await load();
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && MISSING.test(String((error as Error).message))) return undefined;
    throw error;
  }
}
