import { describe, expect, it } from 'vitest';
import { isLiveValidation, issueOfFields, liveValidationFields, VALIDATE_HEADER } from './live-validation.ts';

const request = (header?: string) => new Request('http://localhost/x', { method: 'POST', headers: header === undefined ? {} : { [VALIDATE_HEADER]: header } });

describe('live validation', () => {
  it('reads the named fields — trimmed, deduplicated, paths allowed, nonsense left out', () => {
    expect(liveValidationFields(request())).toBeUndefined();
    expect(liveValidationFields(request(' name , email,name ,address.city, links.0.url'))).toEqual(['name', 'email', 'address.city', 'links.0.url']);
    expect(liveValidationFields(request('a b,<script>,..,x.'))).toEqual([]);
    expect(liveValidationFields(request(Array.from({ length: 100 }, (_, i) => `f${i}`).join(',')))).toHaveLength(64);
  });

  it('a request with the header is a live validation even when no usable field is left (it never becomes a submit)', () => {
    expect(isLiveValidation(request(''))).toBe(true);
    expect(isLiveValidation(request())).toBe(false);
  });

  it('an issue belongs to a named field when its path is that field or lies under it', () => {
    expect(issueOfFields({ message: '', path: ['email'] }, ['email'])).toBe(true);
    expect(issueOfFields({ message: '', path: [{ key: 'address' }, { key: 'city' }] }, ['address'])).toBe(true);
    expect(issueOfFields({ message: '', path: ['address', 'city'] }, ['address.city'])).toBe(true);
    expect(issueOfFields({ message: '', path: ['address', 'zip'] }, ['address.city'])).toBe(false);
    expect(issueOfFields({ message: '', path: ['emailAddress'] }, ['email'])).toBe(false);
    expect(issueOfFields({ message: '', path: ['links', 0, 'url'] }, ['links.0'])).toBe(true);
    // A check over the whole body belongs to no field.
    expect(issueOfFields({ message: '' }, ['email'])).toBe(false);
  });
});
