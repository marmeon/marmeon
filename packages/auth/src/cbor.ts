/** Just enough CBOR (RFC 8949) for an attestation object and a COSE key: integers, byte and text strings, maps. */
export function cbor(value: unknown): Buffer {
  const head = (major: number, length: number): Buffer => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    if (length < 65_536) {
      const two = Buffer.alloc(3);
      two[0] = (major << 5) | 25;
      two.writeUInt16BE(length, 1);
      return two;
    }
    const four = Buffer.alloc(5);
    four[0] = (major << 5) | 26;
    four.writeUInt32BE(length, 1);
    return four;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error('cbor(): cannot encode this value.');
}
