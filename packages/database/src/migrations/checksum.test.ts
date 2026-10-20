import { describe, expect, it } from 'vitest';
import { migrationChecksum } from './checksum.ts';

describe('migrationChecksum', () => {
  it('is sha256:<hex> of the bytes', () => {
    expect(migrationChecksum(Buffer.from('export default {};\n'))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reads CRLF as LF, so a checkout with converted line endings gives the same checksum', () => {
    expect(migrationChecksum(Buffer.from('a\r\nb\r\n'))).toBe(migrationChecksum(Buffer.from('a\nb\n')));
  });

  it('changes with any other byte', () => {
    expect(migrationChecksum(Buffer.from('a\n'))).not.toBe(migrationChecksum(Buffer.from('a \n')));
  });
});
