import { Html, interpolate, textFromHtml } from './html.ts';
import type { MailContent } from './message.ts';
import { HTML_KEY, withCode } from '@marmeon/core/internal';

// Held by this module only: without it the constructor throws, so the static block is the one way to an Mjml.
const MJML_KEY = Symbol('Mjml');
let makeMjml: (markup: string) => Mjml;

/** MJML markup — what the `mjml` template returns; it compiles to the table layouts and Outlook conditionals mail clients need. */
export class Mjml extends Html {
  static {
    makeMjml = (markup) => new Mjml(markup, MJML_KEY);
  }

  private constructor(markup: string, key: symbol) {
    if (key !== MJML_KEY) throw new TypeError('An Mjml is made by the mjml template — new Mjml(markup) is mjml`${raw(markup)}`, for markup you trust.');
    super(markup, HTML_KEY);
  }
}

/**
 * A mail in MJML: every interpolated value escaped (like `html`), nested `mjml`/`html` kept. Compiled by `mjml` (an
 * optional peer: `pnpm add mjml@^5`) with strict validation — a mistyped tag is an error, not a silently missing part.
 * See `docs/mail.md#writing-mails`.
 */
export function mjml(strings: TemplateStringsArray, ...values: unknown[]): Mjml {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1]!;
  return makeMjml(out);
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
    result = await compile(Html.prototype.toString.call(source), {
      validationLevel: 'strict',
      keepComments: false,
      // An empty list turns off mjml's built-in one, which imports a Google font for a known family name; only an `<mj-font>` of the app loads a font. Each call needs a new object: mjml writes every `<mj-font>` into it, so a shared one would carry one mail's font into the next.
      fonts: {},
    });
  } catch (error) {
    throw new MjmlError(withCode('Q7', `The MJML template is invalid: ${error instanceof Error ? error.message.trim() : String(error)}`), { cause: error });
  }
  return { html: result.html, text: options.text ?? textFromHtml(result.html) };
}

/** What to install for `` mjml`…` `` templates — an optional peer (a renderer, not the transport; ≈ 50 MB with its dependencies). */
export const MJML_INSTALL = 'pnpm add mjml@^5';

/** Loads the compiler, or says how to install it. Other failures (a broken install) pass through. `load` is replaced in tests. */
export async function loadMjml(load: () => Promise<unknown> = () => import('mjml' as string)): Promise<Compile> {
  try {
    const module = (await load()) as { default: Compile };
    return module.default;
  } catch (error) {
    compiler = undefined;
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && typeof message === 'string' && /['"]mjml['"]/.test(message)) {
      throw new MjmlError(withCode('Q7', `mjml\`\` needs the mjml package, which is not installed in this app: ${MJML_INSTALL}`), { cause: error });
    }
    throw error;
  }
}
