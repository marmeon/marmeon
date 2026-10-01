import { createMessageLoader } from '@bespokecore/i18n/messages';
import lang from 'virtual:bespoke/lang';

/**
 * The language files (`modules/<module>/lang/<locale>.ts`, `lang/<locale>.ts`) for the browser and the SSR entry:
 * each page renders with its locale's messages — only that locale's files are loaded.
 */
export const messages = createMessageLoader(lang, { fallback: 'en' });
