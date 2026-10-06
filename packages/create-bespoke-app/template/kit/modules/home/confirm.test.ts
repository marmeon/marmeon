import { ConfirmDialog, I18nContext, type ConfirmRequest } from '@bespokecore/react';
import { Catalog } from '@bespokecore/i18n/messages';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Confirm } from '../../bootstrap/confirm.tsx';
import de from '../../lang/de.ts';
import en from '../../lang/en.ts';

// The app's dialog (bootstrap/confirm.tsx) — written by create-bespoke-app's starter kit; its test lives here, where the app's tests run.

const catalog = new Catalog({ fallback: 'en' }).add('en', 'app', en).add('de', 'app', de);
const ask = (locale: string, request: ConfirmRequest) =>
  renderToStaticMarkup(createElement(I18nContext.Provider, { value: { locale, catalog } }, createElement(Confirm, { request, answer: () => {} })));

describe('the app’s dialog', () => {
  it('asks in the page’s language — unsaved changes, and another tab that signed in or out', () => {
    const leave = ask('de', { kind: 'leave', message: 'Ungespeicherte Änderungen.' });
    expect(leave).toContain('>Bleiben<');
    expect(leave).toContain('>Verlassen<');
    const session = ask('de', { kind: 'leave', reason: 'session', message: 'You signed in or out …' });
    expect(session).toContain('Du hast dich in einem anderen Tab an- oder abgemeldet');
    expect(session).toContain('>Neu laden<');
    expect(session).not.toContain('You signed in or out');
    expect(ask('en', { kind: 'leave', reason: 'session', message: '' })).toContain('>Load again<');
  });

  it('is the framework’s dialog with the app’s words', () => {
    const plain = renderToStaticMarkup(createElement(ConfirmDialog, { request: { kind: 'confirm', message: 'Sure?' }, answer: () => {} }));
    expect(ask('de', { kind: 'confirm', message: 'Sure?' })).toBe(plain.replace('>Cancel<', '>Abbrechen<'));
  });
});
