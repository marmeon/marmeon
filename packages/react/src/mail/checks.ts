import type { MjmlComponentName } from './props.ts';

/** The attributes MJML reads as a name when set (`inline="inline"`) and not at all when off. */
const FLAGS: ReadonlySet<string> = new Set(['inline', 'fullWidth']);

/** The props typed `string | number`: a number is `px` there, and a number anywhere else is refused (`fontWeight: 700` would be `700px`). `scripts/mail-implementation.test.ts` keeps the list equal to `props.ts`. */
export const UNIT_PROPS: ReadonlySet<string> = new Set([
  'backgroundHeight',
  'backgroundSize',
  'backgroundWidth',
  'borderRadius',
  'borderWidth',
  'fontSize',
  'gap',
  'height',
  'icoFontSize',
  'icoLineHeight',
  'icoPadding',
  'icoPaddingBottom',
  'icoPaddingLeft',
  'icoPaddingRight',
  'icoPaddingTop',
  'iconHeight',
  'iconPadding',
  'iconSize',
  'iconWidth',
  'innerPadding',
  'innerPaddingBottom',
  'innerPaddingLeft',
  'innerPaddingRight',
  'innerPaddingTop',
  'letterSpacing',
  'maxHeight',
  'padding',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'tbWidth',
  'textPadding',
  'width',
]);

/**
 * What a component refuses at run time, and the props it hands to the implementation. The types stop these at compile time,
 * but a value from `any` (`{...data}`) does not carry them, and a raw sink fed from data is an injection into the mail: the
 * check sits where the props arrive, in front of the library that would write them.
 *
 * - `dangerouslySetInnerHTML` only on `MjmlRaw`: it writes its markup as it is, like `raw()`.
 * - `className`: MJML has `cssClass`, and one name is one way.
 * - `lineHeight` as a number: the library turns `1.5` into `1.5px`, which is not what anyone means.
 * - `MjmlStyle` takes one string as its child: the library writes it as it is, so an element or an array has no meaning there.
 *   The string holds no `<`: CSS needs none, and `</mj-style>` would end the element and let the rest in as markup of the mail.
 * - a number for a prop that takes no unit (`fontWeight`): it would be dropped or written as `700px`.
 *
 * A number is `px` in the props of `UNIT_PROPS`; `fullWidth={false}` and `inline={false}` drop the attribute (the library
 * would write its name).
 *
 * @throws TypeError naming the component and the reason.
 */
export function checkedProps(name: MjmlComponentName, props: unknown): Record<string, unknown> {
  if (typeof props !== 'object' || props === null) throw new TypeError(`${name} takes an object of props, got ${props === null ? 'null' : typeof props}.`);
  const given = props as Record<string, unknown>;
  if (given.dangerouslySetInnerHTML !== undefined && name !== 'MjmlRaw') {
    throw new TypeError(`${name} takes no dangerouslySetInnerHTML: markup you wrote goes into MjmlRaw, never data.`);
  }
  if (given.className !== undefined) throw new TypeError(`${name} takes no className: use cssClass, the MJML attribute css-class.`);
  if (name === 'MjmlStyle' && given.children !== undefined && typeof given.children !== 'string') {
    throw new TypeError('MjmlStyle takes its CSS as one string child (a template literal), not an element, a number or a list of parts.');
  }
  if (name === 'MjmlStyle' && typeof given.children === 'string' && given.children.includes('<')) {
    throw new TypeError('MjmlStyle takes CSS without a "<": it is written as it is, and "</mj-style>" would end the element and let the rest in as markup.');
  }
  const checked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(given)) {
    if (key === 'className') continue;
    if (typeof value === 'number' && key !== 'children') {
      if (key === 'lineHeight') throw new TypeError(`${name} takes lineHeight as a string ('1.5', '24px'): a number would become ${value}px.`);
      if (!UNIT_PROPS.has(key)) throw new TypeError(`${name} takes ${key} as a string: a number is px only where the value has a unit.`);
      if (!Number.isFinite(value)) throw new TypeError(`${name} takes a finite number for ${key}, got ${value}.`);
      checked[key] = `${value}px`;
    } else if (FLAGS.has(key) && value === false) {
      continue;
    } else {
      checked[key] = value;
    }
  }
  return checked;
}
