// Type guarantees of `Session` — checked by `tsc` (typecheck), never run.
import type { Session } from './session.ts';

declare const session: Session;

session.flashData('status', 'Saved.');
// @ts-expect-error `flash()` is `flashData()`: a flash message is what a response carries
session.flash('status', 'Saved.');
