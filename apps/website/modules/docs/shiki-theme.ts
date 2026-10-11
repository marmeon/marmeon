import type { ThemeRegistration } from 'shiki';

/**
 * One placeholder colour per role. The theme only sorts tokens into roles; `highlight.ts` swaps each placeholder for a class and
 * `styles/code.css` holds the real colours (`--syn-*`, light and dark). No `fontStyle`: Shiki would turn it into a `style`
 * attribute, which the production CSP refuses.
 */
export const ROLE_COLOURS = {
  text: '#000000',
  keyword: '#010000',
  type: '#020000',
  string: '#030000',
  function: '#040000',
  comment: '#050000',
  tag: '#060000',
  punctuation: '#070000',
} as const;

export type Role = keyof typeof ROLE_COLOURS;

const SCOPES: Readonly<Record<Exclude<Role, 'text'>, readonly string[]>> = {
  keyword: ['keyword', 'storage', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression', 'variable.language'],
  type: [
    'entity.name.type',
    'entity.name.class',
    'support.type',
    'support.class',
    'entity.other.inherited-class',
    'entity.name.tag.tsx support.class.component',
    'entity.other.attribute-name',
    'support.type.property-name.json',
    'entity.name.tag.yaml',
    'variable.other.env',
  ],
  string: ['string', 'punctuation.definition.string', 'markup.inserted', 'meta.embedded.line.tsx string', 'string.unquoted.plain.out.yaml'],
  function: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'],
  comment: ['comment', 'punctuation.definition.comment'],
  tag: ['entity.name.tag', 'constant', 'support.constant', 'markup.deleted', 'markup.heading'],
  punctuation: ['punctuation', 'meta.brace', 'keyword.operator'],
};

/** The Marmeon code theme (see `docs/` pages' blocks): keyword, type, string, function, comment, tag, punctuation. */
export const MARMEON_THEME: ThemeRegistration = {
  name: 'marmeon',
  type: 'light',
  colors: { 'editor.foreground': ROLE_COLOURS.text, 'editor.background': '#FFFFFF' },
  settings: [
    { settings: { foreground: ROLE_COLOURS.text, background: '#FFFFFF' } },
    ...(Object.entries(SCOPES) as [Exclude<Role, 'text'>, readonly string[]][]).map(([role, scope]) => ({
      scope: [...scope],
      settings: { foreground: ROLE_COLOURS[role] },
    })),
  ],
};
