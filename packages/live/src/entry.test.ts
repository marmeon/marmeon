import { describe, expect, it } from 'vitest';
import * as live from './index.ts';

describe('the entry point of the live package', () => {
  it('keeps what an app and the test app use', () => {
    for (const name of ['Broadcaster', 'notificationsChannel', 'LiveSetupError', 'LiveServiceProvider', 'LiveConfig', 'LiveBackend', 'BroadcastRecorder', 'LiveStreamReader']) expect(live, name).toHaveProperty(name);
  });

  it('drops the hub, the backends and the wire constants', () => {
    for (const name of ['LiveHub', 'MemoryLiveBackend', 'RedisLiveBackend', 'LiveTokens', 'LiveStreamController', 'LIVE_PATH', 'CONNECTION_HEADER', 'STREAM_HEADERS']) {
      expect(live, name).not.toHaveProperty(name);
    }
  });
});
