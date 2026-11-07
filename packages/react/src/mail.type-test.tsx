// Type guarantees of `@marmeon/react/mail` — checked by `tsc` (pnpm build / typecheck), never run.
import type { Mailable } from '@marmeon/mail';
import { MjmlBody, MjmlRaw, MjmlDocument, MjmlSection, MjmlStyle, MjmlText, toMjml } from './mail.ts';
// @ts-expect-error — mj-include reads a file of the server: no component
import { MjmlInclude } from './mail.ts';
// @ts-expect-error — a raw HTML tag of any name: no component
import { MjmlHtml } from './mail.ts';
// @ts-expect-error — a comment written as it is: no component
import { MjmlComment } from './mail.ts';

void [MjmlInclude, MjmlHtml, MjmlComment];

export const guarantees = [
  <MjmlText paddingTop={8} lineHeight="1.5" cssClass="a" mjmlClass="b" />,
  <MjmlRaw dangerouslySetInnerHTML={{ __html: '<p>mine</p>' }} />,
  <MjmlStyle inline>{'a { color: red }'}</MjmlStyle>,
  // @ts-expect-error — dangerouslySetInnerHTML belongs to MjmlRaw
  <MjmlText dangerouslySetInnerHTML={{ __html: 'x' }} />,
  // @ts-expect-error — lineHeight is a string: a number would be px
  <MjmlText lineHeight={1.5} />,
  // @ts-expect-error — the CSS of MjmlStyle is a string
  <MjmlStyle>{5}</MjmlStyle>,
  // @ts-expect-error — cssClass, not className
  <MjmlText className="a" />,
  // @ts-expect-error — an unknown attribute is no prop
  <MjmlText colour="red" />,
  // @ts-expect-error — align is one of left, right, center, justify
  <MjmlText align="middle" />,
];

interface Props {
  readonly name: string;
  readonly items: readonly string[];
}

function View({ name, items }: Props) {
  return (
    <MjmlDocument>
      <MjmlBody>
        <MjmlSection>
          <MjmlText>{name}</MjmlText>
          {items.map((item) => (
            <MjmlText key={item}>{item}</MjmlText>
          ))}
        </MjmlSection>
      </MjmlBody>
    </MjmlDocument>
  );
}

/** A class in a `.ts` file calls `toMjml(View, props)`: `content()` is a `Mailable`'s. */
export class DigestMail implements Mailable {
  envelope() {
    return { to: 'ada@example.com', subject: 'Digest' };
  }
  content() {
    return toMjml(View, { name: 'Ada', items: ['a'] });
  }
}

export const views = [
  toMjml(View, { name: 'Ada', items: [] }),
  toMjml(<View name="Ada" items={[]} />),
  // @ts-expect-error — the props of the view are its signature: a name is required
  toMjml(View, { items: [] }),
  // @ts-expect-error — a number is no name
  toMjml(View, { name: 1, items: [] }),
];
