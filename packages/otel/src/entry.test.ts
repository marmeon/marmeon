import { describe, expect, it } from 'vitest';
import * as otel from './index.ts';

describe('the entry point of the OpenTelemetry package', () => {
  it('exports the provider, its config and its setup error', () => {
    expect(Object.keys(otel).sort()).toEqual(['OtelConfig', 'OtelServiceProvider', 'OtelSetupError']);
  });
});
