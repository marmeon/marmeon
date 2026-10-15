import { describe, expect, it } from 'vitest';
import { isSensitiveRememberField, loadSensitiveFields, rememberable, Remembered } from './remember.ts';

// The rules load on first use and stay loaded: this file runs its one test before anything loads them.
describe('the rules that tell sensitive fields load on first use', () => {
  it('keep nothing — and call everything sensitive — until they are loaded; a write waits for them, and a later one or a delete cancels it', async () => {
    expect(isSensitiveRememberField('name')).toBe(true);
    expect(rememberable({ name: 'Ada' })).toBeUndefined();

    const store = new Remembered();
    store.set('draft', { name: 'Ada', password: 'hunter2' });
    expect(store.has('draft')).toBe(false);

    // Written, then reverted: the first value is not stored when the rules arrive.
    store.set('reverted', { name: 'v1' });
    store.delete('reverted');
    // Written twice: the later one wins.
    store.set('twice', { name: 'v1' });
    store.set('twice', () => ({ name: 'v2' }));
    // A key that is itself a field name of a password is never kept.
    store.set('secret-tab', 'a', [], 'secret-tab');
    // Forgotten while it waited.
    const forgotten = new Remembered();
    forgotten.set('draft', { name: 'Ada' });
    forgotten.clear();

    await loadSensitiveFields();
    expect(store.get('draft')).toEqual({ name: 'Ada' });
    expect(store.has('reverted')).toBe(false);
    expect(store.get('twice')).toEqual({ name: 'v2' });
    expect(store.has('secret-tab')).toBe(false);
    expect(forgotten.has('draft')).toBe(false);
    expect(isSensitiveRememberField('name')).toBe(false);
  });
});
