import { createApplication, defineModule, ErrorReports, Logger, type Container, type ErrorReport, type ErrorReporter } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, DefaultExceptionHandler, ExceptionHandler, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { protocolHeaders, VALIDATE_HEADER } from '@marmeon/http/internal';
import { createHttpKernel } from './kernel.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const PASSWORD = 'hunter2-s3cr3t';
const TOKEN = 'a1b2c3d4'.repeat(8);

const reports: ErrorReport[] = [];
let hang = false;
class Collecting implements ErrorReporter {
  report(report: ErrorReport): Promise<void> | void {
    reports.push(report);
    if (hang) return new Promise(() => {});
  }
}
class Throwing implements ErrorReporter {
  report(): void {
    throw new Error('the reporter is down');
  }
}
class ReportingProvider {
  static errorReporters = [Throwing, Collecting];
}

class Throws {
  handle(): never {
    throw new Error(`connect failed: postgres://app:${PASSWORD}@db.internal/shop`);
  }
}

const routes = openRoutes((Route) => {
  Route.middleware(Throws).post('/live-boom', () => null);
  Route.get('/boom', () => {
    throw new Error(`connect failed: postgres://app:${PASSWORD}@db.internal/shop`, { cause: new Error(`refused token=${TOKEN}`) });
  });
  Route.get('/gone', () => abort(404));
  Route.get('/teapot', () => abort(500, 'broken'));
  Route.get('/users/:token', (ctx: HttpContext<{}, { token: string }>) => {
    throw new Error(`failed for ${ctx.params.token}`);
  }).name('users.show');
});

async function boot() {
  const application = await createApplication(
    {
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ReportingProvider],
      modules: [defineModule({ name: 'reporting', routes })],
    },
    { env: { APP_KEY: generateKey() } },
  );
  return createHttpKernel(application);
}

describe('createHttpKernel — error reporters', () => {
  it('gives a 500 to the provider\'s reporters, masked, without waiting for them', async () => {
    reports.length = 0;
    const app = await boot();
    const response = await app.request('/boom?session=abc', { headers: { accept: 'application/json' } });
    expect(response.status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reports).toHaveLength(1);
    const seen = JSON.stringify(reports[0]);
    expect(seen).not.toContain(PASSWORD);
    expect(seen).not.toContain(TOKEN);
    expect(reports[0]).toMatchObject({ source: 'request', context: { method: 'GET', route: '', path: '/boom' } });
    expect(reports[0]!.error.cause?.message).toContain('refused');
  });

  it('does not answer later than a reporter that never finishes', async () => {
    reports.length = 0;
    hang = true;
    try {
      const app = await boot();
      const response = await app.request('/boom', { headers: { accept: 'application/json' } });
      expect(response.status).toBe(500);
    } finally {
      hang = false;
    }
  });

  it('masks the route parameter in the path and names the route', async () => {
    reports.length = 0;
    const app = await boot();
    await app.request(`/users/${TOKEN}`, { headers: { accept: 'application/json' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports[0]!.context).toMatchObject({ route: 'users.show', path: '/users/[redacted]' });
    expect(JSON.stringify(reports[0]!.context)).not.toContain(TOKEN);
  });

  it('reports no client error', async () => {
    reports.length = 0;
    const app = await boot();
    expect((await app.request('/gone', { headers: { accept: 'application/json' } })).status).toBe(404);
    expect((await app.request('/missing', { headers: { accept: 'application/json' } })).status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(0);
  });

  it('reports an HttpError of 500 and above', async () => {
    reports.length = 0;
    const app = await boot();
    await app.request('/teapot', { headers: { accept: 'application/json' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports[0]!.error).toMatchObject({ status: 500 });
  });

  it('reports the error of an island request, masked', async () => {
    reports.length = 0;
    const app = await boot();
    const response = await app.request('/boom', { headers: { ...protocolHeaders(), 'x-marmeon-region': 'island', accept: 'application/json' } });
    expect(response.status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain(PASSWORD);
  });

  it('reports the error of a live validation request, masked', async () => {
    reports.length = 0;
    const app = await boot();
    const response = await app.request('/live-boom', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...protocolHeaders(), [VALIDATE_HEADER]: 'email' }, body: '{}' });
    expect(response.status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain(PASSWORD);
  });

  it('warns once about an exception handler that still has report()', async () => {
    const warnings: string[] = [];
    class OldHandler extends DefaultExceptionHandler {
      report(): void {}
    }
    class OldHandlerProvider {
      register(container: Container) {
        container.singleton(ExceptionHandler, OldHandler);
        container.singleton(Logger, () => ({ debug() {}, info() {}, error() {}, child: () => container.make(Logger), warn: (message: string) => void warnings.push(message) }));
      }
    }
    const application = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, OldHandlerProvider], modules: [defineModule({ name: 'old', routes })] },
      { env: { APP_KEY: generateKey() } },
    );
    const app = createHttpKernel(application);
    await app.request('/boom', { headers: { accept: 'application/json' } });
    await app.request('/boom', { headers: { accept: 'application/json' } });
    expect(warnings.filter((warning) => warning.includes('has a report() method'))).toHaveLength(1);
  });

  it('answers as before when the reporting itself throws', async () => {
    class BrokenReports {
      register(container: Container) {
        container.instance(ErrorReports, {
          report() {
            throw new Error('reporting is broken');
          },
        } as unknown as ErrorReports);
      }
    }
    const application = await createApplication(
      { root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, BrokenReports], modules: [defineModule({ name: 'broken', routes })] },
      { env: { APP_KEY: generateKey() } },
    );
    const response = await createHttpKernel(application).request('/boom', { headers: { accept: 'application/json' } });
    expect(response.status).toBe(500);
  });
});
