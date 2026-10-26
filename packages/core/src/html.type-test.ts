// Only `html` and `raw()` make an Html — checked by `tsc` (pnpm build / typecheck), never run.
import { Html } from './html.ts';

// @ts-expect-error — the constructor is protected and asks for a key: markup becomes HTML through `raw()` or the `html` template
export const made = new Html('<b>x</b>');
