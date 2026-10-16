import { describe, expect, it } from 'vitest';
import * as devtools from './index.ts';
import * as internal from './internal.ts';

describe('the entry points of the devtools', () => {
  it('keeps what an app documents in the main entry', () => {
    for (const name of ['defineDevtools', 'DevtoolsServiceProvider', 'DevtoolsTester', 'FileStore', 'DevtoolsConfig', 'DevtoolsConfigError']) expect(devtools, name).toHaveProperty(name);
  });

  it('keeps the recorder and the test opt-in out of the main entry and in ./internal', () => {
    for (const name of ['Recorder', 'enableDevtoolsForTests']) {
      expect(devtools, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });

  it('drops the page and bar internals from every entry', () => {
    for (const name of ['BAR_SCRIPT', 'barMarkup', 'PAGE_CSP', 'MAIL_CSP', 'registerDevtoolsPages', 'DevtoolsSettings', 'resolveOptions']) {
      expect(devtools, name).not.toHaveProperty(name);
      expect(internal, name).not.toHaveProperty(name);
    }
  });
});
