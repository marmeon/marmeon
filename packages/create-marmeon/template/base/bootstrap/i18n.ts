import { createMessageLoader } from '@marmeon/i18n/messages';
import lang from 'virtual:marmeon/lang';

/**
 * The language files (`modules/<module>/lang/<locale>.ts`, `lang/<locale>.ts`) for the browser and the SSR entry:
 * each page renders with its locale's messages — only that locale's files are loaded, missing namespaces from the
 * server's APP_FALLBACK_LOCALE (sent with every page).
 */
export const messages = createMessageLoader(lang);
