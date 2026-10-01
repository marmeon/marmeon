import { createMessageLoader } from '@bespokecore/i18n/messages';
import lang from 'virtual:bespoke/lang';

/**
 * The language files for the browser and the SSR entry: each page renders with its locale's messages — only that
 * locale's files are loaded (one chunk each), namespaces without them from the fallback (APP_FALLBACK_LOCALE).
 */
export const messages = createMessageLoader(lang, { fallback: 'en' });
