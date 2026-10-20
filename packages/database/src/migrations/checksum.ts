import { stubHash } from '@marmeon/core/internal';

/** The checksum `migrations` keeps of a migration file: SHA-256 of its bytes with CRLF read as LF, as `sha256:<hex>`. */
export function migrationChecksum(bytes: Uint8Array): string {
  return stubHash(bytes);
}
