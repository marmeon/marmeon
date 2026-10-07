import type { DefaultLayout } from '@marmeon/react';
import { AppLayout } from '../layouts/AppLayout.tsx';

export { LayerFrame as layer } from '../layouts/LayerFrame.tsx';

/** The layout of every page without its own `Page.layout` (E35). Shared by the client and SSR entries. */
export const layout: DefaultLayout = () => AppLayout;
