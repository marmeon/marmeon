import { describe, expect, it } from 'vitest';
import { usePage } from './app.tsx';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';

function Greeting({ name }: { name: string }) {
  const { url } = usePage();
  return <p>Hello {name} at {url}</p>;
}

const resolve = resolveModulePages({
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
