import { createMessageLoader } from '@marmeon/i18n/messages';
import lang from 'virtual:marmeon/lang/office';

/** The back office's texts with the app's rewording laid over them — loaded by this entry only. */
export const messages = createMessageLoader(lang);
