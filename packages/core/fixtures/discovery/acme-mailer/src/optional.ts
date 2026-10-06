// A subpath for an optional peer (like the React adapter's `./table`): it imports a package the app need not install, and has no
// class to inject — discovery must not list it, or the server would import it at boot.
// @ts-expect-error — the optional peer is not installed
import { missing } from '@acme/optional-peer';

export const optional = (): unknown => missing;
