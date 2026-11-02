import { Clock } from '@marmeon/core';
import type { ClassResolver, HttpContext } from '@marmeon/http';
import { RequestLocale } from '@marmeon/i18n';
import { Session } from '@marmeon/session';
import type { Talk } from './TalkCatalog.ts';

/**
 * The `afterAuthorize` hook of a talk's routes: the request speaks the talk's language, and the visitor's session remembers
 * the talk and when (`resolve(Clock)`, a token). A hook also runs for the island and live-validation requests of its route, whose session is read-only, so it
 * writes only when `session.readOnly` says it may.
 */
export function rememberTalk(ctx: HttpContext<{}, { talk: Talk }>, resolve: ClassResolver): void {
  resolve(RequestLocale).use(ctx.params.talk.language);
  const session = resolve(Session);
  if (!session.readOnly) session.put('last_talk', { slug: ctx.params.talk.slug, at: resolve(Clock).now() });
}
