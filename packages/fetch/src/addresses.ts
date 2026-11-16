import { isIP } from 'node:net';

/** An IP address as bytes: 4 for IPv4, 16 for IPv6. */
export type Address = { readonly family: 4 | 6; readonly bytes: Uint8Array };

/** A CIDR range, e.g. `10.0.0.0/8`. */
export type AddressRange = { readonly family: 4 | 6; readonly bytes: Uint8Array; readonly prefix: number };

function parseV4(text: string): Uint8Array | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return undefined;
    bytes[index] = Number(part);
  }
  return bytes;
}

function parseV6(text: string): Uint8Array | undefined {
  if (text.includes('%')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (side: string): number[] | undefined => {
    if (side === '') return [];
    const out: number[] = [];
    const parts = side.split(':');
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes('.')) {
        const v4 = parseV4(part);
        if (!v4) return undefined;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        out.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const all = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => 0), ...tail];
  const bytes = new Uint8Array(16);
  for (const [index, group] of all.entries()) {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/**
 * Reads a canonical address: the hostname of a WHATWG `URL` (which already turns `0x7f.1` and `2130706433` into `127.0.0.1`)
 * or an entry of a `dns.lookup` answer. Brackets around an IPv6 address are accepted. Anything else is `undefined`.
 */
export function parseAddress(text: string): Address | undefined {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const family = isIP(bare);
  if (family === 4) {
    const bytes = parseV4(bare);
    return bytes && { family: 4, bytes };
  }
  if (family === 6) {
    const bytes = parseV6(bare);
    return bytes && { family: 6, bytes };
  }
  return undefined;
}

/** Reads a CIDR range such as `10.0.0.0/8` or `2001:db8::/32`; the prefix is required. Throws on anything else. */
export function parseRange(text: string): AddressRange {
  const slash = text.indexOf('/');
  const address = slash === -1 ? undefined : parseAddress(text.slice(0, slash));
  const prefixText = text.slice(slash + 1);
  if (!address || slash === -1 || !/^(0|[1-9]\d{0,2})$/.test(prefixText) || Number(prefixText) > address.bytes.length * 8) {
    throw new TypeError(`"${text}" is not an address range. Write an IP address, a slash and a prefix length, for example "10.0.0.0/8" or "2001:db8::/32".`);
  }
  return { family: address.family, bytes: address.bytes, prefix: Number(prefixText) };
}

/** Whether the range contains the address. A range of the other family contains nothing. */
export function covers(range: AddressRange, address: Address): boolean {
  if (range.family !== address.family) return false;
  const whole = range.prefix >> 3;
  for (let index = 0; index < whole; index++) if (range.bytes[index] !== address.bytes[index]) return false;
  const rest = range.prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (range.bytes[whole]! & mask) === (address.bytes[whole]! & mask);
}

const ranges = (...texts: string[]): AddressRange[] => texts.map(parseRange);

/**
 * IPv4 ranges that are not public: this network, private use, shared address space, loopback, link-local, the IETF protocol
 * assignments, documentation, the 6to4 relay anycast block, benchmarking, multicast, and the reserved block with the broadcast address.
 */
const REFUSED_V4 = ranges(
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
);

/** The only IPv6 space a public host lives in: global unicast. A deny-list would miss the next special range. */
const GLOBAL_V6 = parseRange('2000::/3');

/**
 * Special ranges inside global unicast: the IETF protocol assignment block 2001::/23 (the registry's few reachable anycast
 * addresses are refused too), and the documentation ranges 2001:db8::/32 and 3fff::/20.
 */
const REFUSED_V6 = ranges('2001::/23', '2001:db8::/32', '3fff::/20');

const EMBEDDING_V6 = ranges('::ffff:0:0/96', '::/96', '64:ff9b::/96');
const SIX_TO_FOUR = parseRange('2002::/16');

/** The IPv4 address inside a mapped, compatible, NAT64 or 6to4 IPv6 address. */
function embeddedV4(address: Address): Address | undefined {
  if (address.family !== 6) return undefined;
  if (EMBEDDING_V6.some((range) => covers(range, address))) return { family: 4, bytes: address.bytes.slice(12, 16) };
  if (covers(SIX_TO_FOUR, address)) return { family: 4, bytes: address.bytes.slice(2, 6) };
  return undefined;
}

/**
 * Whether a request may go to the address: it is public, or one of the `allow` ranges contains it. An IPv6 address that
 * embeds an IPv4 address (mapped, compatible, NAT64, 6to4) is judged as that IPv4 address.
 */
export function isPublic(address: Address, allow: readonly AddressRange[]): boolean {
  if (allow.some((range) => covers(range, address))) return true;
  const embedded = embeddedV4(address);
  if (embedded) return isPublic(embedded, allow);
  if (address.family === 4) return !REFUSED_V4.some((range) => covers(range, address));
  return covers(GLOBAL_V6, address) && !REFUSED_V6.some((range) => covers(range, address));
}
