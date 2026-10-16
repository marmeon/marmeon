// Type guarantees of the application's definition — checked by `tsc` (pnpm build / typecheck), never run.
import { createApplication, defineApplication } from './index.ts';

export function applicationTypes(): void {
  // What boots an app (the environment, test doubles) is not part of what ships: a definition that carries it does not compile.
  // @ts-expect-error `env` belongs to the boot options
  defineApplication({ root: '/app', env: {} });
  // @ts-expect-error `override` belongs to the boot options
  defineApplication({ root: '/app', override: () => {} });
  // @ts-expect-error `phase` belongs to the boot options
  defineApplication({ root: '/app', phase: 'build' });

  // They go to createApplication() as the second argument — and only there.
  void createApplication(defineApplication({ root: '/app', discover: false }), { env: {}, phase: 'build', override: () => {} });
  // @ts-expect-error the definition has no `env` either when it is passed on
  void createApplication({ root: '/app', env: {} });
  // @ts-expect-error `modules` belongs to the definition
  void createApplication({ root: '/app' }, { modules: [] });
}
