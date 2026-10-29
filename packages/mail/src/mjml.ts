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

type Compile = (source: string, options: Record<string, unknown>) => Promise<{ html: string; json: Node; errors: readonly { formattedMessage?: string; message?: string }[] }>;
let compiler: Promise<Compile> | undefined;

type Node = { tagName?: string; attributes?: Record<string, unknown>; children?: Node[] };

// Components whose mjml-core defaults point at an image on a host of someone else (mailjet.com, imgur.com): an unset
// attribute would make every opened mail call that host. `children` names the child that may bring its own value. A new
// default in a later mjml shows in the test that lists every built-in component.
const THIRD_PARTY_IMAGES: readonly { tag: string; host: string; attributes: readonly string[]; children?: string }[] = [
  { tag: 'mj-social-element', host: 'www.mailjet.com', attributes: ['src'] },
  { tag: 'mj-accordion', host: 'i.imgur.com', attributes: ['icon-wrapped-url', 'icon-unwrapped-url'], children: 'mj-accordion-element' },
  { tag: 'mj-carousel', host: 'i.imgur.com', attributes: ['left-icon', 'right-icon'] },
];

type Declared = { defaults: Record<string, Record<string, unknown>>; classes: Record<string, Record<string, unknown>>; classDefaults: Record<string, Record<string, Record<string, unknown>>> };

/** What `mj-attributes` of the head declares, merged the way mjml-core merges it (a later block adds to an earlier one). */
function declaredAttributes(root: Node): Declared {
  const declared: Declared = { defaults: {}, classes: {}, classDefaults: {} };
  const head = root.children?.find((child) => child.tagName === 'mj-head');
  for (const block of head?.children ?? []) {
    if (block.tagName !== 'mj-attributes') continue;
    for (const child of block.children ?? []) {
      const { name, ...rest } = child.attributes ?? {};
      if (child.tagName === 'mj-class') {
        declared.classes[String(name)] = { ...declared.classes[String(name)], ...rest };
        const byTag: Record<string, Record<string, unknown>> = {};
        for (const inner of child.children ?? []) byTag[inner.tagName ?? ''] = inner.attributes ?? {};
        declared.classDefaults[String(name)] = { ...declared.classDefaults[String(name)], ...byTag };
      } else {
        const tag = child.tagName ?? '';
        declared.defaults[tag] = { ...declared.defaults[tag], ...child.attributes };
      }
    }
  }
  return declared;
}

const isSet = (value: unknown) => typeof value === 'string' && value.trim() !== '';

/**
 * Throws a Q7 `MjmlError` when a component would load a default image from a host of someone else: its source
 * attribute is unset on the tag, in a `mj-class`, in `mj-attributes` and in `mj-all`. Runs on the tree mjml rendered. See `docs/mail.md#writing-mails`.
 */
function refuseThirdPartyImages(root: Node): void {
  const declared = declaredAttributes(root);
  const all = declared.defaults['mj-all'] ?? {};
  // mjml-core's order: mj-attributes of the tag, then its mj-class, then what an mj-class says about this tag for the descendants of an element with that class, then the tag itself.
  const chain = (node: Node, inherited: string): Record<string, unknown> => {
    const own = { ...node.attributes };
    const classes = String(own['mj-class'] ?? '').split(' ');
    delete own['mj-class'];
    let merged: Record<string, unknown> = { ...declared.defaults[node.tagName ?? ''] };
    for (const name of classes) merged = { ...merged, ...declared.classes[name] };
    for (const name of inherited.split(' ')) merged = { ...merged, ...declared.classDefaults[name]?.[node.tagName ?? ''] };
    return { ...merged, ...own };
  };
  const fail = (node: Node, attribute: string, host: string): never => {
    const name = node.attributes?.name === undefined ? '' : ` name="${String(node.attributes.name)}"`;
    throw new MjmlError(withCode('Q7', `The MJML template is invalid: <${node.tagName}${name}> has no ${attribute}, so mjml would load its image from ${host} in every opened mail. Set ${attribute} to an image you host, on the tag or in mj-attributes.`));
  };
  const walk = (node: Node, inherited: string): void => {
    const rule = THIRD_PARTY_IMAGES.find((candidate) => candidate.tag === node.tagName);
    const next = node.attributes?.['mj-class'] === undefined ? inherited : String(node.attributes['mj-class']);
    const effective = { ...all, ...chain(node, inherited) };
    if (rule) {
      for (const attribute of rule.attributes) {
        if (isSet(effective[attribute])) continue;
        // An accordion hands its value to its elements, but an element's own value wins.
        const elements = rule.children ? (node.children ?? []).filter((child) => child.tagName === rule.children) : [];
        if (elements.length > 0 && elements.every((element) => isSet(chain(element, next)[attribute]))) continue;
        // An accordion without elements renders no icon.
        if (rule.children && elements.length === 0) continue;
        fail(node, attribute, rule.host);
      }
    }
    for (const child of node.children ?? []) walk(child, next);
  };
  for (const child of root.children ?? []) if (child.tagName === 'mj-body') walk(child, '');
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', colon: ':', sol: '/', bsol: '\\', period: '.', commat: '@', num: '#' };

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));?/g, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    const code = decimal === undefined ? Number.parseInt(hex!, 16) : Number(decimal);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// The places a mail client or MJML reads a URL to load: attributes of the HTML and of the MJML source (`background-url`, the icon attributes of `mj-accordion` and `mj-carousel`, `mj-font`'s `href`; not `mj-navbar`'s `base-url`, which loads nothing).
const LOADING_ATTRIBUTE = String.raw`(?:src|poster|background|background-url|icon-wrapped-url|icon-unwrapped-url|left-icon|right-icon)`;
const VALUE = String.raw`\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))`;

/** URLs a mail would load, as written in `markup`: images, backgrounds, stylesheets, SVG images, `url()` and `@import`. */
function loadedUrls(markup: string): string[] {
  const text = decodeEntities(markup);
  const urls: string[] = [];
  const value = (match: RegExpMatchArray) => (match[1] ?? match[2] ?? match[3] ?? '').trim();
  for (const match of text.matchAll(new RegExp(String.raw`<(?:link|image|mj-font)\b[^>]*?\bhref${VALUE}`, 'gi'))) urls.push(value(match));
  for (const match of text.matchAll(new RegExp(String.raw`\bsrcset${VALUE}`, 'gi'))) for (const candidate of value(match).split(',')) urls.push(candidate.trim().split(/\s+/)[0]!);
  for (const match of text.matchAll(new RegExp(String.raw`\b${LOADING_ATTRIBUTE}${VALUE}`, 'gi'))) urls.push(value(match));
  for (const match of text.matchAll(/url\(\s*["']?([^"')]+)/gi)) urls.push(match[1]!.trim());
  for (const match of text.matchAll(/@import\s+["']([^"']+)/gi)) urls.push(match[1]!.trim());
  return urls;
}

/** The host a URL loads from, as a browser reads it (case, punycode, userinfo, backslashes); `undefined` for a relative, `data:` or `cid:` URL. */
function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url, 'https://relative.invalid');
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    return parsed.hostname === 'relative.invalid' ? undefined : parsed.hostname;
  } catch {
    return undefined;
  }
}

/**
 * The compiled HTML may load from the hosts the template itself loads from and no other: whatever a component of mjml
 * brings by itself, now or in a later version, is refused. A host the template only links to or mentions in text does
 * not count. Relative, `data:` and `cid:` URLs load nothing from a third party.
 */
function refuseUnnamedHosts(markup: string, html: string): void {
  const named = new Set(loadedUrls(markup).map(hostOf));
  for (const url of loadedUrls(html)) {
    const host = hostOf(url);
    if (host === undefined || named.has(host)) continue;
    throw new MjmlError(withCode('Q7', `The MJML template is invalid: the mail would load ${url}, a host the template does not load from itself. Give the component that brings it an image you host.`));
  }
}

/** Compiles MJML into `{ html, text }` — `text` derived unless given. */
export async function fromMjml(source: Mjml, options: { text?: string } = {}): Promise<MailContent> {
  const compile = await (compiler ??= loadMjml());
  const markup = Html.prototype.toString.call(source);
  let result: Awaited<ReturnType<Compile>>;
  try {
    result = await compile(markup, {
      validationLevel: 'strict',
      keepComments: false,
      // An empty list turns off mjml's built-in one, which imports a Google font for a known family name; only an `<mj-font>` of the app loads a font. Each call needs a new object: mjml writes every `<mj-font>` into it, so a shared one would carry one mail's font into the next.
      fonts: {},
    });
    // On the tree mjml itself parsed and rendered, so includes, presets and components cannot differ; the HTML is dropped when this throws.
    refuseThirdPartyImages(result.json);
    refuseUnnamedHosts(markup, result.html);
  } catch (error) {
    if (error instanceof MjmlError) throw error;
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
