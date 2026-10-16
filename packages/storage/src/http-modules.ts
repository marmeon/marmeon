/** The optional peer @marmeon/http — its own module so a test can make the import fail like a missing package. */
export async function loadHttpModules(): Promise<{ http: typeof import('@marmeon/http'); page: typeof import('@marmeon/http/protocol') }> {
  return { http: await import('@marmeon/http'), page: await import('@marmeon/http/protocol') };
}
