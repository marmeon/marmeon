import { MailError, MjmlError, mjml, type Mailable, type Mjml as MjmlContent } from '@marmeon/mail';
import { MailFake } from '@marmeon/mail/testing';
import { createContext, Suspense, use, useContext, useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  MjmlAll,
  MjmlBody,
  MjmlButton,
  MjmlClass,
  MjmlColumn,
  MjmlHead,
  MjmlImage,
  MjmlRaw,
  MjmlDocument,
  MjmlSection,
  MjmlSocial,
  MjmlSocialElement,
  MjmlStyle,
  MjmlText,
  MjmlTitle,
  toMjml,
} from './mail.ts';

// The behaviour of `@marmeon/react/mail` as an app sees it — its own components, `@marmeon/mail`, React. Nothing here names the
// library the components are built on, so the tests hold for any implementation behind them.

const HOSTILE = '<script>alert(1)</script> & "q" \'s';

/** A mail whose content is `content`, composed the way a send composes it. */
class View implements Mailable {
  readonly #content: () => MjmlContent;
  constructor(content: () => MjmlContent) {
    this.#content = content;
  }
  envelope() {
    return { to: 'ada@example.com', subject: 'Hello' };
  }
  content() {
    return this.#content();
  }
}
const send = (content: () => MjmlContent) => new MailFake('hello@app.test').send(new View(content));
const markup = (content: MjmlContent) => String(content);

function Page({ children }: { children?: React.ReactNode }) {
  return (
    <MjmlDocument>
      <MjmlBody>
        <MjmlSection>
          <MjmlColumn>{children}</MjmlColumn>
        </MjmlSection>
      </MjmlBody>
    </MjmlDocument>
  );
}

describe('toMjml()', () => {
  it('makes a Mjml that compiles, with a readable text version', async () => {
    function Welcome({ name, url }: { name: string; url: string }) {
      return (
        <Page>
          <MjmlText>Hello {name},</MjmlText>
          <MjmlButton href={url}>Choose a new password</MjmlButton>
        </Page>
      );
    }
    const message = await send(() => toMjml(Welcome, { name: 'Ada', url: 'https://app.test/reset?token=abc&email=ada%40example.com' }));
    expect(message.html).toMatch(/^<!doctype html>/i);
    expect(message.html).toContain('<table');
    expect(message.text).toBe('Hello Ada,\n\nChoose a new password (https://app.test/reset?token=abc&email=ada%40example.com)');
  });

  it('takes an element too', () => {
    expect(markup(toMjml(<Page />))).toMatch(/^<mjml>/);
  });

  describe('escaping', () => {
    it('escapes text and an attribute value that come from data, in the markup and in the sent mail', async () => {
      const content = () =>
        toMjml(
          <Page>
            <MjmlText>Hello {HOSTILE}</MjmlText>
            <MjmlImage src="https://app.test/logo.png" alt={HOSTILE} />
          </Page>,
        );
      expect(markup(content())).not.toContain('<script>');
      expect(markup(content())).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; ');
      expect(markup(content())).toContain('alt="&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#x27;s"');
      const message = await send(content);
      expect(message.html).not.toContain('<script>');
      expect(message.html).toContain('&lt;script&gt;');
    });

    it('does not let a name open an element or load an image', async () => {
      const name = '</mj-text><mj-raw><img src="https://tracker.test/p.gif"></mj-raw><mj-text>';
      const content = () => toMjml(<Page><MjmlText>{name}</MjmlText></Page>);
      expect(markup(content())).not.toContain('<mj-raw>');
      const message = await send(content);
      expect(message.html).not.toContain('<img');
      expect(message.html).toContain('&lt;img src=&quot;https://tracker.test/p.gif&quot;&gt;');
    });

    it('does not let a quote end an attribute', () => {
      const text = markup(toMjml(<Page><MjmlButton href={'https://app.test/" onclick="x'}>Go</MjmlButton></Page>));
      expect(text).toContain('href="https://app.test/&quot; onclick=&quot;x"');
    });
  });

  describe('the checks MJML still makes on a view', () => {
    it('refuses an image of another host that a component loads by itself (a social element without src)', async () => {
      const content = () => toMjml(<Page><MjmlSocial><MjmlSocialElement name="facebook" href="https://facebook.test/app">Facebook</MjmlSocialElement></MjmlSocial></Page>);
      await expect(send(content)).rejects.toThrow(/Q7.*mj-social-element.*"facebook".*src/s);
      const hosted = () => toMjml(<Page><MjmlSocial><MjmlSocialElement name="facebook" href="https://facebook.test/app" src="https://app.test/facebook.png">Facebook</MjmlSocialElement></MjmlSocial></Page>);
      await expect(send(hosted)).resolves.toBeTruthy();
    });

    it('validates strictly: an attribute MJML does not know is an error, not a silent drop', async () => {
      const data = { 'data-x': '1' };
      await expect(send(() => toMjml(<Page><MjmlText {...data}>Hi</MjmlText></Page>))).rejects.toThrow(MjmlError);
    });

    it('refuses a relative link when the mail is sent', async () => {
      await expect(send(() => toMjml(<Page><MjmlButton href="/reset">Go</MjmlButton></Page>))).rejects.toThrow(MailError);
    });
  });

  describe('values', () => {
    it('writes a number as px, camelCase as kebab-case, a flag as its name and cssClass and mjmlClass as MJML knows them', () => {
      const text = markup(
        toMjml(
          <MjmlDocument>
            <MjmlHead>
              <MjmlClass name="accent" color="#c00" />
              <MjmlStyle inline>{'.x { color: red }'}</MjmlStyle>
            </MjmlHead>
            <MjmlBody>
              <MjmlSection fullWidth paddingTop={8} paddingBottom="4%" cssClass="wide">
                <MjmlColumn>
                  <MjmlText lineHeight="1.5" letterSpacing={2} mjmlClass="accent">Hi</MjmlText>
                  <MjmlImage src="https://app.test/a.png" alt="A" fluidOnMobile height={40} />
                  <MjmlSocial iconSize={20} />
                </MjmlColumn>
              </MjmlSection>
            </MjmlBody>
          </MjmlDocument>,
        ),
      );
      expect(text).toContain('padding-top="8px"');
      expect(text).toContain('padding-bottom="4%"');
      expect(text).toContain('full-width="full-width"');
      expect(text).toContain('css-class="wide"');
      expect(text).toContain('mj-class="accent"');
      expect(text).toContain('line-height="1.5"');
      expect(text).toContain('letter-spacing="2px"');
      expect(text).toContain('fluid-on-mobile="true"');
      expect(text).toContain('height="40px"');
      // The library writes a number as px for some attributes only; a component takes it for every one that has a unit.
      expect(text).toContain('icon-size="20px"');
      expect(text).toContain('<mj-style inline="inline">');
    });

    it('leaves a flag that is off out, where the library would write its name', () => {
      const text = markup(toMjml(<MjmlDocument><MjmlHead><MjmlStyle inline={false}>{'a { color: red }'}</MjmlStyle></MjmlHead><MjmlBody><MjmlSection fullWidth={false} /></MjmlBody></MjmlDocument>));
      expect(text).not.toContain('full-width');
      expect(text).not.toContain('inline');
    });

    it('takes arbitrary attributes in MjmlAll', () => {
      expect(markup(toMjml(<MjmlDocument><MjmlHead><MjmlAll fontFamily="Georgia, serif" /></MjmlHead><MjmlBody /></MjmlDocument>))).toContain('<mj-all font-family="Georgia, serif"');
    });
  });

  describe('React', () => {
    it('runs state and context', () => {
      const Theme = createContext('plain');
      function Label() {
        const theme = useContext(Theme);
        const [count] = useState(3);
        return <MjmlText>{theme} {count}</MjmlText>;
      }
      const text = markup(toMjml(<Theme.Provider value="dark"><Page><Label /></Page></Theme.Provider>));
      expect(text).toContain('dark');
      expect(text).toContain('3');
    });

    it('runs the hooks in the body of a view called as toMjml(View, props)', () => {
      function Counter({ start }: { start: number }) {
        const [count] = useState(start);
        return <Page><MjmlText>count {count}</MjmlText></Page>;
      }
      expect(markup(toMjml(Counter, { start: 7 }))).toContain('count 7');
      // Called directly it runs outside the renderer: a hook has no component to belong to.
      expect(() => Counter({ start: 7 })).toThrow();
    });

    it('shows the fallback of a Suspense that suspends, and nothing of its content', () => {
      const never = new Promise<string>(() => {});
      function Slow() {
        return <MjmlText>{use(never)}</MjmlText>;
      }
      const text = markup(toMjml(<Page><Suspense fallback={<MjmlText>loading</MjmlText>}><Slow /></Suspense></Page>));
      expect(text).toContain('loading');
    });

    it('lists several children and conditionals as MJML needs them', () => {
      const items = ['a', 'b', 'c'];
      const text = markup(toMjml(<Page>{items.map((item) => <MjmlText key={item}>{item}</MjmlText>)}{false}{null}</Page>));
      expect(text.match(/<mj-text>/g)).toHaveLength(3);
    });
  });

  describe('a fragment in a layout', () => {
    it('renders the tags of a body, which a template nests in its own frame', async () => {
      function Body({ name }: { name: string }) {
        return <MjmlSection><MjmlColumn><MjmlText>Hello {name}</MjmlText></MjmlColumn></MjmlSection>;
      }
      const message = await send(() => mjml`<mjml><mj-body>${toMjml(Body, { name: '<b>Ada</b>' })}</mj-body></mjml>`);
      expect(message.html).toContain('Hello &lt;b&gt;Ada&lt;/b&gt;');
    });
  });

  describe('raw output', () => {
    it('writes the markup of MjmlRaw as it is, and its children escaped', () => {
      const text = markup(toMjml(<Page><MjmlRaw dangerouslySetInnerHTML={{ __html: '<p class="x">mine</p>' }} /><MjmlRaw>{'<p>data</p>'}</MjmlRaw></Page>));
      expect(text).toContain('<p class="x">mine</p>');
      expect(text).toContain('&lt;p&gt;data&lt;/p&gt;');
    });

    it('writes the CSS of MjmlStyle as one string', () => {
      expect(markup(toMjml(<MjmlDocument><MjmlHead><MjmlStyle>{'.a > .b { color: red }'}</MjmlStyle></MjmlHead><MjmlBody /></MjmlDocument>))).toContain('.a > .b { color: red }');
    });
  });
});

describe('what a view must not do', () => {
  it('refuses a <title> that React moves in front of the root, where MJML would drop it', () => {
    expect(() => toMjml(<MjmlDocument><title>Reset</title><MjmlBody /></MjmlDocument>)).toThrow(MjmlError);
    expect(() => toMjml(<MjmlDocument><title>Reset</title><MjmlBody /></MjmlDocument>)).toThrow(/Use MjmlTitle for the title/);
  });

  it('refuses a <meta> and a <link precedence> the same way', () => {
    expect(() => toMjml(<MjmlDocument><meta name="x" content="y" /><MjmlBody /></MjmlDocument>)).toThrow(MjmlError);
    expect(() => toMjml(<MjmlDocument><link rel="stylesheet" href="/a.css" precedence="default" /><MjmlBody /></MjmlDocument>)).toThrow(MjmlError);
  });

  it('refuses a fragment whose hoisted tag comes before its first MJML tag', () => {
    expect(() => toMjml(<><title>x</title><MjmlSection /></>)).toThrow(MjmlError);
  });

  it('refuses a view that renders no MJML', () => {
    expect(() => toMjml(<p>hi</p>)).toThrow(MjmlError);
    expect(() => toMjml(<></>)).toThrow(MjmlError);
  });

  it('says where a <meta>, a <link> and an image go: React hoists them also from inside MjmlRaw, and preloads a JSX <img>', () => {
    const meta = () => toMjml(<MjmlDocument><MjmlBody><MjmlRaw><meta name="x" content="y" /></MjmlRaw></MjmlBody></MjmlDocument>);
    expect(meta).toThrow(MjmlError);
    expect(meta).toThrow(/dangerouslySetInnerHTML=\{\{ __html: '<meta …>' \}\} \/> for a <meta> or <link>/);
    const image = () => toMjml(<MjmlDocument><MjmlBody><MjmlRaw><img src="https://app.test/a.png" alt="" /></MjmlRaw></MjmlBody></MjmlDocument>);
    expect(image).toThrow(/preload a JSX <img>.*MjmlImage for an image/);
    // What the message recommends passes.
    expect(markup(toMjml(<MjmlDocument><MjmlBody><MjmlRaw dangerouslySetInnerHTML={{ __html: '<meta name="x" content="y">' }} /></MjmlBody></MjmlDocument>))).toContain('<meta name="x" content="y">');
  });

  it('refuses content in front of the root, which mjml would drop', () => {
    expect(() => toMjml(<><MjmlText>first</MjmlText><MjmlDocument><MjmlBody /></MjmlDocument></>)).toThrow(MjmlError);
    expect(markup(toMjml(<><MjmlDocument><MjmlBody /></MjmlDocument></>))).toMatch(/^<mjml>/);
  });

  it('keeps MjmlTitle, which writes where MJML reads it', () => {
    expect(markup(toMjml(<MjmlDocument><MjmlHead><MjmlTitle>Reset</MjmlTitle></MjmlHead><MjmlBody /></MjmlDocument>))).toContain('<mj-title>Reset</mj-title>');
  });

  it('refuses dangerouslySetInnerHTML on every component but MjmlRaw — also through {...data}', () => {
    const data = { dangerouslySetInnerHTML: { __html: '<mj-raw><img src="https://tracker.test/p.gif"></mj-raw>' } } as Record<string, unknown>;
    expect(() => toMjml(<Page><MjmlText {...data}>Hi</MjmlText></Page>)).toThrow(new TypeError('MjmlText takes no dangerouslySetInnerHTML: markup you wrote goes into MjmlRaw, never data.'));
    for (const Component of [MjmlButton, MjmlTitle, MjmlStyle, MjmlSection, MjmlSocialElement] as const) {
      expect(() => toMjml(<MjmlDocument><MjmlBody><Component {...(data as object)} /></MjmlBody></MjmlDocument>), Component.name).toThrow(TypeError);
    }
  });

  it('refuses a number as lineHeight, which would become px', () => {
    expect(() => toMjml(<Page><MjmlText lineHeight={1.5 as never}>Hi</MjmlText></Page>)).toThrow(/MjmlText takes lineHeight as a string/);
  });

  it('refuses anything but one string as the child of MjmlStyle', () => {
    for (const child of [5, ['a', 'b'], <MjmlText key="x">x</MjmlText>, { toString: () => '</mj-style>' }]) {
      expect(() => toMjml(<MjmlDocument><MjmlHead><MjmlStyle>{child as never}</MjmlStyle></MjmlHead><MjmlBody /></MjmlDocument>)).toThrow(/MjmlStyle takes its CSS as one string child/);
    }
  });

  it('refuses CSS that holds a "<", where </mj-style> would let markup and an image of the tracker in', async () => {
    const breakout = '</mj-style></mj-head><mj-body><mj-raw><img src="https://tracker.test/p.gif"></mj-raw></mj-body><mj-head><mj-style>';
    const view = () => toMjml(<MjmlDocument><MjmlHead><MjmlStyle>{breakout}</MjmlStyle></MjmlHead><MjmlBody /></MjmlDocument>);
    expect(view).toThrow(/MjmlStyle takes CSS without a "<"/);
    expect(() => toMjml(<MjmlDocument><MjmlHead><MjmlStyle>{'a > b { color: red }'}</MjmlStyle></MjmlHead><MjmlBody /></MjmlDocument>)).not.toThrow();
  });

  it('refuses a number for a prop that has no unit, as it would be written 700px', () => {
    const data = { fontWeight: 700 } as Record<string, unknown>;
    expect(() => toMjml(<Page><MjmlText {...data}>Hi</MjmlText></Page>)).toThrow(/MjmlText takes fontWeight as a string/);
  });

  it('refuses className: cssClass is the one way', () => {
    const data = { className: 'x' } as Record<string, unknown>;
    expect(() => toMjml(<Page><MjmlText {...data}>Hi</MjmlText></Page>)).toThrow(/MjmlText takes no className: use cssClass/);
  });

  it('refuses a number that is not finite', () => {
    expect(() => toMjml(<Page><MjmlText fontSize={Number.NaN}>Hi</MjmlText></Page>)).toThrow(/finite number for fontSize/);
  });
});
