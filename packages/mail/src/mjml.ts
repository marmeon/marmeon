import { Html, interpolate, textFromHtml } from './html.ts';
import type { MailContent } from './message.ts';

/**
 * MJML markup — what the `mjml` template returns. MJML compiles to the table layouts and Outlook
 * conditionals that mail clients need; React or Vue markup is made for browsers, not for them.
 */
export class Mjml extends Html {}

/**
 * A mail in MJML, every interpolated value escaped (like `html`), nested `mjml`/`html` kept — a
 * layout can be a function returning `mjml`:
 *
 * ```ts
 * content() {
 *   return mjml`<mjml><mj-body><mj-section><mj-column>
 *     <mj-text>Hello ${this.#user.name}</mj-text>
 *     <mj-button href="${this.#url}">Choose a new password</mj-button>
 *   </mj-column></mj-section></mj-body></mjml>`;
 * }
 * ```
 *
 * Compiled by `mjml` (an optional peer: `pnpm add mjml`) with strict validation — a mistyped tag is
 * an error, not a silently missing part. The text version is derived from the compiled HTML.
 */
export function mjml(strings: TemplateStringsArray, ...values: unknown[]): Mjml {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1]!;
  return new Mjml(out);
}

export class MjmlError extends Error {
  override name = 'MjmlError';
}

type Compile = (source: string, options: Record<string, unknown>) => Promise<{ html: string; errors: readonly { formattedMessage?: string; message?: string }[] }>;
let compiler: Promise<Compile> | undefined;

/** Compiles MJML into `{ html, text }` — `text` derived unless given. */
export async function fromMjml(source: Mjml, options: { text?: string } = {}): Promise<MailContent> {
  const compile = await (compiler ??= loadMjml());
  let result: Awaited<ReturnType<Compile>>;
  try {
    result = await compile(source.toString(), { validationLevel: 'strict', keepComments: false });
  } catch (error) {
    throw new MjmlError(`The MJML template is invalid: ${error instanceof Error ? error.message.trim() : String(error)}`, { cause: error });
  }
  return { html: result.html, text: options.text ?? textFromHtml(result.html) };
}

async function loadMjml(): Promise<Compile> {
  try {
    const module = (await import('mjml' as string)) as { default: Compile };
    return module.default;
  } catch (error) {
    compiler = undefined;
    throw new MjmlError('mjml`` needs the mjml package: pnpm add mjml', { cause: error });
  }
}
