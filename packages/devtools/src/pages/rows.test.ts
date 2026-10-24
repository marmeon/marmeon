import { describe, expect, it } from 'vitest';
import type { RequestEntryContent } from '../entry.ts';
import { requestBadges } from './rows.ts';

const badges = (headers: Record<string, string>) => String(requestBadges({ headers } as unknown as RequestEntryContent));

describe('requestBadges', () => {
  it('names an upload, an action and a validation by their own header, though each carries the protocol version too', () => {
    expect(badges({ 'x-marmeon': '1', 'x-marmeon-upload': 'avatar' })).toContain('upload');
    expect(badges({ 'x-marmeon': '1', 'x-marmeon-action': 'true' })).toContain('action');
    expect(badges({ 'x-marmeon': '1', 'x-marmeon-validate': 'name' })).toContain('live validation');
    expect(badges({ 'x-marmeon': '1', 'x-marmeon-upload': 'bytes' })).not.toContain('visit');
    expect(badges({ 'x-marmeon': '1' })).toContain('visit');
  });
});
