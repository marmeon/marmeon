// Type guarantee of the application's definition with http's augmentation — checked by `tsc` (pnpm build / typecheck), never run.
import { defineApplication } from '@marmeon/core';
import './provider.ts';

export function applicationTypes(): void {
  // http's settings are part of the definition, typed through `ApplicationDefinition`.
  defineApplication({ root: '/app', middleware: { global: [], web: [], api: [] }, clientRoutes: { except: ['admin.*'] } });
  // @ts-expect-error `middleware` is a group of lists, not a list
  defineApplication({ root: '/app', middleware: [] });
}
