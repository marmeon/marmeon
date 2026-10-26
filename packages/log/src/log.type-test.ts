// Type guarantees of createPinoLogger — compiled by the package build, never run.
import type { Application } from '@marmeon/core';
import type { Writable } from 'node:stream';
import { createPinoLogger } from './index.ts';

declare const stream: Writable;
declare const app: Application;

createPinoLogger({ level: 'info', format: 'json' });
createPinoLogger({ level: 'info', format: 'json' }, { destination: stream, app });
// @ts-expect-error — the stream goes in the options: `{ destination }`
createPinoLogger({ level: 'info', format: 'json' }, stream);
// @ts-expect-error — the options are the last argument: `{ destination, app }`
createPinoLogger({ level: 'info', format: 'json' }, { destination: stream }, app);
