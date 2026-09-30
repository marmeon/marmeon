import { describe, expect, it } from 'vitest';
import { usePage } from './app.tsx';
import { Head } from './head.tsx';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';

function Greeting({ name }: { name: string }) {
  const { url } = usePage();
  return <p>Hello {name} at {url}</p>;
}

function Titled({ name }: { name: string }) {
  return (
    <>
      <Head title="Layout" />
      <Head title={`${name} <admin>`}>
        <meta name="description" content={`Profile of ${name}`} />
      </Head>
      <p>{name}</p>
    </>
  );
}

const resolve = resolveModulePages({
  '../modules/greeting/views/Titled.tsx': async () => ({ default: Titled }),
  '../modules/greeting/views/Hello.tsx': async () => ({ default: Greeting }),
  '../modules/broken/views/NoDefault.tsx': async () => ({}),
  '../elsewhere/Ignored.tsx': async () => ({ default: Greeting }),
});

describe('resolveModulePages', () => {
  it('maps modules/<module>/views/<Page> to <module>/<Page>', async () => {
    expect(await resolve('greeting/Hello')).toBe(Greeting);
  });

  it('explains where a missing page is expected', async () => {
    await expect(resolve('greeting/Nope')).rejects.toThrow('modules/greeting/views/Nope.tsx');
    await expect(resolve('Ignored')).rejects.toThrow(/not found/);
    await expect(resolve('broken/NoDefault')).rejects.toThrow(/no default export/);
  });
});

describe('createSsrRenderer', () => {
  it('renders the page component with its props and page context', async () => {
    const render = createSsrRenderer(resolve);
    const { html } = await render({ component: 'greeting/Hello', props: { name: 'Ada' }, url: '/hi' });
    expect(html).toBe('<p>Hello <!-- -->Ada<!-- --> at <!-- -->/hi</p>');
  });
});

describe('<Head> on the server', () => {
  it('collects title (through the template, escaped, the last one wins) and tags for the document head', async () => {
    const render = createSsrRenderer(resolve, { title: (title) => `${title} — Shop` });
    const { html, head } = await render({ component: 'greeting/Titled', props: { name: 'Ada' }, url: '/ada' });
    expect(html).toBe('<p>Ada</p>');
    expect(head).toBe(
      '<title data-bespoke-head="ssr">Ada &#60;admin&#62; — Shop</title><meta name="description" content="Profile of Ada" data-bespoke-head="ssr"/>',
    );
  });

  it('adds nothing for pages without <Head>', async () => {
    const { head } = await createSsrRenderer(resolve)({ component: 'greeting/Hello', props: { name: 'Ada' }, url: '/' });
    expect(head).toBe('');
  });
});
