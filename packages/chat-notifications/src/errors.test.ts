import { describe, expect, it } from 'vitest';
import { ChatDeliveryError, ChatError } from './errors.ts';

describe('ChatError', () => {
  it('is named, and keeps its cause', () => {
    const cause = new Error('inner');
    const error = new ChatError('x', { cause });
    expect(error.name).toBe('ChatError');
    expect(error.cause).toBe(cause);
    expect(new ChatError('y').cause).toBeUndefined();
  });
});

describe('ChatDeliveryError', () => {
  it('is a ChatError that keeps reason, status, provider code, delay and cause', () => {
    const cause = new Error('socket');
    const error = new ChatDeliveryError('throttled', 'slow down', { status: 429, providerCode: 'rate_limited', retryAfterSeconds: 1.5, cause });
    expect(error).toBeInstanceOf(ChatError);
    expect(error.name).toBe('ChatDeliveryError');
    expect(error).toMatchObject({ reason: 'throttled', status: 429, providerCode: 'rate_limited', retryAfterSeconds: 1.5 });
    expect(error.cause).toBe(cause);
  });

  it('is permanent for refused, rejected and gone, and not for throttled and unavailable', () => {
    const permanent = (reason: ConstructorParameters<typeof ChatDeliveryError>[0]): boolean => new ChatDeliveryError(reason, 'x').permanent;
    expect([permanent('refused'), permanent('rejected'), permanent('gone')]).toEqual([true, true, true]);
    expect([permanent('throttled'), permanent('unavailable')]).toEqual([false, false]);
  });

  it('has no own key for an option that is absent', () => {
    const error = new ChatDeliveryError('refused', 'x');
    for (const key of ['status', 'providerCode', 'retryAfterSeconds', 'cause']) expect(error, key).not.toHaveProperty(key);
    expect(Object.keys(error)).toEqual(['name', 'reason']);
  });
});
