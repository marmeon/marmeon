import type { MailContent } from './message.ts';

/**
 * @internal — the key of the render contract: a value with this method is rendered by its own engine (MJML today), with
 * that engine's checks. `Symbol.for`, so the engine of a second copy of this package is found too.
 */
export const RENDER_MAIL: unique symbol = Symbol.for('marmeon.mail.render');

/** @internal — a template that renders itself into a mail's content; `contentOf` asks it before it looks at `Html`. */
export interface RendersMail {
  [RENDER_MAIL](): Promise<MailContent>;
}

/** @internal */
export function rendersMail(value: unknown): value is RendersMail {
  return typeof value === 'object' && value !== null && typeof (value as Partial<RendersMail>)[RENDER_MAIL] === 'function';
}
