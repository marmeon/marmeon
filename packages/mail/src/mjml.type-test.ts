// Only the `mjml` template makes an Mjml — checked by `tsc` (pnpm build / typecheck), never run.
import { Mjml } from './mjml.ts';

// @ts-expect-error — the constructor is private: markup becomes MJML through the `mjml` template
export const made = new Mjml('<mjml></mjml>');
