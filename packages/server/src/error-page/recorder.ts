import { currentRequest, type Application, type RequestInfo } from '@marmeon/core';
import { channels, type DbQueryMessage, type LogMessage } from '@marmeon/core/diagnostics';
import { MAX_RECORDED, type RequestRecorder, type RequestRecording } from './recorder-token.ts';

interface Recording {
  queries: DbQueryMessage[];
  droppedQueries: number;
  logs: LogMessage[];
  droppedLogs: number;
}

/**
 * The error page's recorder (E119): listens to `db.query` and `marmeon:log` of `app` and keeps, per request, its first
 * {@link MAX_RECORDED} queries and log entries. Keyed by the request's context object (a WeakMap): what a request records
 * goes when the request does, and a request resolved in-process for another (an island) records its own.
 */
export function createRequestRecorder(app: Application): RequestRecorder {
  const recordings = new WeakMap<RequestInfo, Recording>();
  const current = () => {
    const info = currentRequest();
    return info ? recordings.get(info) : undefined;
  };
  const off = [
    channels.subscribe(app, 'db.query', {
      end: (query) => {
        const recording = current();
        if (!recording) return;
        if (recording.queries.length < MAX_RECORDED) recording.queries.push(query);
        else recording.droppedQueries++;
      },
    }),
    channels.subscribe(app, 'log', (entry) => {
      const recording = current();
      if (!recording) return;
      if (recording.logs.length < MAX_RECORDED) recording.logs.push(entry);
      else recording.droppedLogs++;
    }),
  ];
  return {
    begin: (info) => void recordings.set(info, { queries: [], droppedQueries: 0, logs: [], droppedLogs: 0 }),
    recording: (info): RequestRecording | undefined => {
      const recording = recordings.get(info);
      return recording && { queries: [...recording.queries], droppedQueries: recording.droppedQueries, logs: [...recording.logs], droppedLogs: recording.droppedLogs };
    },
    close: () => {
      for (const unsubscribe of off) unsubscribe();
      off.length = 0;
    },
  };
}
