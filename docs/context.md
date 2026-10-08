# Context

## Introduction

Marmeon keeps almost no global state. Services get what they need through their constructor, and the data of a request lives in
the request's own scope. Two things are the exception, because code everywhere needs them without being handed them: which unit
of work runs right now, and what time it is.

The unit of work is the context: a request, a job or a scheduled task. The logger reads it, so every log entry names the request
or the job it belongs to without anyone passing an id around:

```ts title="modules/notes/NoteExport.ts"
import { currentRequest } from '@marmeon/core';

export class NoteExport {
  async send(url: string, body: string): Promise<Response> {
    // The request that caused this call, so the other service's logs can be matched with ours.
    const requestId = currentRequest()?.requestId;
    return fetch(url, { method: 'POST', body, headers: requestId ? { 'x-request-id': requestId } : {} });
  }
}
```

The time comes from a clock that you inject, so a test can move it.

## The current unit of work

The framework sets the context where a unit of work begins: the HTTP kernel for each request, the queue worker for each attempt
of a job, the scheduler for each run of a task. Four functions of `@marmeon/core` read it:

| Function | Returns |
| --- | --- |
| `currentRequest()` | `{ requestId }` inside a request, else `undefined`. The id is the client's `x-request-id` when it is a sane one, else a generated one. |
| `currentJob()` | `{ job, jobId, attempt, requestId? }` inside a job, else `undefined`. `jobId` stays the same across retries. |
| `currentTask()` | `{ task }` inside a scheduled task, else `undefined`. |
| `currentLogContext()` | What every log entry written now carries: `{ requestId }`, `{ job, jobId, attempt }` or `{ task }`. |

A job's `requestId` names the request that dispatched it, also through jobs dispatched in between. Your logs then lead from a
failed job back to the request that started it. It is not part of a job's log context, because a job's entries name the job.

The context follows the code through every `await`, and it never crosses into another request: two requests that run at the same
time each see their own.

### Context, never data

The context says which unit of work runs. It never carries services or data: no signed-in user, no session, no tenant. Those
belong to the request's scope, where the container hands them to the classes that ask for them. A value in a global store
outlives its request too easily, and a later request could read it.

So read the context for cross-cutting concerns only: a log line, a header that carries the request's id to another service, a
trace. For everything else, inject the service.

## Adding fields to every log entry

`LogContextSources` adds fields to every entry the app logs. A provider registers a source in `boot()`. The source runs for each
entry, so keep it cheap, and return nothing when it has nothing to add:

```ts title="modules/system/SystemServiceProvider.ts"
import { hostname } from 'node:os';
import { LogContextSources, type Application, type ServiceProvider } from '@marmeon/core';

export class SystemServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    // Which machine wrote the entry, when several servers write into one log.
    const host = hostname();
    app.container.make(LogContextSources).add(() => ({ host }));
  }
}
```

`add()` returns a function that removes the source again. The OpenTelemetry package uses the same mechanism to add the active
span's ids. The [logging](logging.md) page explains the log entries.

## The clock

A service that expires, schedules or waits asks for a `Clock` instead of calling `Date.now()`:

```ts title="modules/notes/NoteLinks.ts"
import { Clock } from '@marmeon/core';

export class NoteLinks {
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  expiresAt(): number {
    return this.#clock.now() + 60 * 60_000; // one hour from now
  }
}
```

`clock.now()` returns milliseconds since the epoch, like `Date.now()`. Outside tests the container binds `SystemClock`, the real
time. Every test app binds a `TestClock` instead, which the test moves. The framework's own services read the time the same way:
cache expiry, locks, rate limits, the session's lifetime and the scheduler.

`Clock` is a token, so import it as a value. Do not give the parameter a default such as `clock: Clock = new SystemClock()`: the
container never injects a defaulted parameter, and the test's clock would never reach the service. In development the container
warns about it. The [service container](container.md#default-values-are-never-injected) page explains why.

### Spans of time

`Duration` describes a span of time as an object, such as `{ minutes: 5 }` or `{ hours: 1, seconds: 30 }`. It takes `days`,
`hours`, `minutes`, `seconds` and `milliseconds`, and a negative part goes back in time. `durationToMilliseconds(duration)` turns
it into a number.

## Testing

A test moves the app's clock with `app.travel()`, `app.travelTo()` and `app.freeze()`, without fake timers:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { NoteLinks } from './NoteLinks.ts';

it('lets a link expire after an hour', async () => {
  await using app = await createTestApp(application);
  const start = app.freeze();
  expect(app.container.make(NoteLinks).expiresAt()).toBe(start + 60 * 60_000);
  app.travel({ minutes: 61 });
  expect(app.clock.now()).toBe(start + 61 * 60_000);
});
```

The [time](time.md) page covers the clock in tests.
