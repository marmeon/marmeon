import { describe, expect, it } from 'vitest';
import { isPublic, parseAddress, parseRange } from './addresses.ts';

function judge(text: string, allow: string[] = []): boolean {
  const address = parseAddress(text);
  if (!address) throw new Error(`not an address: ${text}`);
  return isPublic(address, allow.map(parseRange));
}

describe('isPublic — IPv4 ranges: first, last, one outside', () => {
  const refused: [string, string, string, string][] = [
    ['0.0.0.0/8', '0.0.0.0', '0.255.255.255', '1.0.0.0'],
    ['10.0.0.0/8', '10.0.0.0', '10.255.255.255', '11.0.0.0'],
    ['100.64.0.0/10', '100.64.0.0', '100.127.255.255', '100.128.0.0'],
    ['127.0.0.0/8', '127.0.0.0', '127.255.255.255', '128.0.0.0'],
    ['169.254.0.0/16', '169.254.0.0', '169.254.255.255', '169.255.0.0'],
    ['172.16.0.0/12', '172.16.0.0', '172.31.255.255', '172.32.0.0'],
    ['192.0.0.0/24', '192.0.0.0', '192.0.0.255', '192.0.1.0'],
    ['192.0.2.0/24', '192.0.2.0', '192.0.2.255', '192.0.3.0'],
    ['192.88.99.0/24', '192.88.99.0', '192.88.99.255', '192.88.100.0'],
    ['192.168.0.0/16', '192.168.0.0', '192.168.255.255', '192.169.0.0'],
    ['198.18.0.0/15', '198.18.0.0', '198.19.255.255', '198.20.0.0'],
    ['198.51.100.0/24', '198.51.100.0', '198.51.100.255', '198.51.101.0'],
    ['203.0.113.0/24', '203.0.113.0', '203.0.113.255', '203.0.114.0'],
    ['224.0.0.0/4', '224.0.0.0', '239.255.255.255', '223.255.255.255'],
    ['240.0.0.0/4', '240.0.0.0', '255.255.255.255', '239.255.255.255'],
  ];
  it.each(refused)('%s', (_range, first, last, outside) => {
    expect(judge(first)).toBe(false);
    expect(judge(last)).toBe(false);
    // The one outside address that is refused anyway is the multicast block's last, next to the reserved block.
    expect(judge(outside)).toBe(outside !== '239.255.255.255');
  });

  it('lets a public address through', () => {
    expect(judge('93.184.216.34')).toBe(true);
    expect(judge('8.8.8.8')).toBe(true);
  });

  it('treats the neighbours of the multicast and reserved blocks as the edge they are', () => {
    expect(judge('223.255.255.255')).toBe(true);
    expect(judge('239.255.255.255')).toBe(false);
  });
});

describe('isPublic — IPv6', () => {
  it('refuses everything outside 2000::/3', () => {
    for (const text of ['::', '::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', '100::1', '1fff::1', '4000::1']) {
      expect(judge(text), text).toBe(false);
    }
  });

  it('lets global unicast through', () => {
    for (const text of ['2000::1', '2606:4700:4700::1111', '3fef:ffff::1']) expect(judge(text), text).toBe(true);
  });

  it('refuses the special ranges inside 2000::/3', () => {
    for (const text of ['2001::1', '2001:0:ffff::1', '2001:1::1', '2001:2::1', '2001:10::1', '2001:30::1', '2001:1ff:ffff::1', '2001:db8::1', '2001:db8:ffff::1', '3fff::1', '3fff:0fff:ffff::1']) {
      expect(judge(text), text).toBe(false);
    }
  });

  it('lets the neighbours of the special ranges through', () => {
    for (const text of ['2001:200::1', '2001:db9::1', '2001:db7::1', '3fff:1000::1', '2000::1']) expect(judge(text), text).toBe(true);
  });

  const embeds = (v4: [number, number, number, number]) => {
    const [a, b, c, d] = v4.map((byte) => byte.toString(16).padStart(2, '0')) as [string, string, string, string];
    return {
      mapped: [`::ffff:${v4.join('.')}`, `::ffff:${a}${b}:${c}${d}`, `0:0:0:0:0:ffff:${a}${b}:${c}${d}`],
      compatible: [`::${v4.join('.')}`, `::${a}${b}:${c}${d}`],
      nat64: [`64:ff9b::${v4.join('.')}`, `64:ff9b::${a}${b}:${c}${d}`],
      sixToFour: [`2002:${a}${b}:${c}${d}::1`, `2002:${a}${b}:${c}${d}::`],
    };
  };

  it.each([[[127, 0, 0, 1]], [[10, 0, 0, 1]], [[169, 254, 169, 254]]] as [[number, number, number, number]][])('refuses the mapped, compatible, NAT64 and 6to4 forms of %j', (v4) => {
    for (const forms of Object.values(embeds(v4))) for (const text of forms) expect(judge(text), text).toBe(false);
  });

  it('judges the embedded IPv4 address, so a public one passes in every form', () => {
    for (const forms of Object.values(embeds([93, 184, 216, 34]))) for (const text of forms) expect(judge(text), text).toBe(true);
  });
});

describe('isPublic — allow ranges', () => {
  it('lets a covered address through, also in its embedded forms, and nothing next to it', () => {
    expect(judge('127.0.0.1', ['127.0.0.1/32'])).toBe(true);
    expect(judge('::ffff:127.0.0.1', ['127.0.0.1/32'])).toBe(true);
    expect(judge('127.0.0.2', ['127.0.0.1/32'])).toBe(false);
    expect(judge('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(judge('11.0.0.1', ['10.0.0.0/8'])).toBe(true);
    expect(judge('192.168.0.1', ['10.0.0.0/8'])).toBe(false);
  });

  it('keeps a range of one family from covering the other', () => {
    expect(judge('::1', ['127.0.0.0/8'])).toBe(false);
    expect(judge('::1', ['::1/128'])).toBe(true);
    expect(judge('fd00:ec2::254', ['fc00::/7'])).toBe(true);
    expect(judge('fe80::1', ['fc00::/7'])).toBe(false);
  });
});

describe('parseAddress', () => {
  it('reads canonical IPv4 and IPv6 text', () => {
    expect(parseAddress('127.0.0.1')).toEqual({ family: 4, bytes: Uint8Array.of(127, 0, 0, 1) });
    expect(parseAddress('[::1]')?.bytes).toEqual(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1));
    expect(parseAddress('::ffff:1.2.3.4')?.bytes.slice(10)).toEqual(Uint8Array.of(0xff, 0xff, 1, 2, 3, 4));
    expect(parseAddress('2001:db8:0:0:0:0:0:1')?.bytes.slice(0, 4)).toEqual(Uint8Array.of(0x20, 0x01, 0x0d, 0xb8));
  });

  it('reads what a URL makes of a disguised IPv4 address', () => {
    expect(parseAddress(new URL('http://0x7f.1/').hostname)?.bytes).toEqual(Uint8Array.of(127, 0, 0, 1));
    expect(parseAddress(new URL('http://2130706433/').hostname)?.bytes).toEqual(Uint8Array.of(127, 0, 0, 1));
  });

  it('refuses what is not an address', () => {
    for (const text of ['', 'localhost', '127.1', '0x7f.0.0.1', '1.2.3.256', 'fe80::1%eth0', '1:2:3', '::1::2']) expect(parseAddress(text), text).toBeUndefined();
  });
});

describe('parseRange', () => {
  it('reads a range', () => {
    expect(parseRange('10.0.0.0/8')).toEqual({ family: 4, bytes: Uint8Array.of(10, 0, 0, 0), prefix: 8 });
    expect(parseRange('2001:db8::/32').prefix).toBe(32);
    expect(parseRange('0.0.0.0/0').prefix).toBe(0);
  });

  it.each(['10.0.0.0', '10.0.0.0/', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/08', '::/129', 'localhost/8', '/8', '10.0.0.0/8/8'])('refuses %j with the exact message', (text) => {
    expect(() => parseRange(text)).toThrow(
      `"${text}" is not an address range. Write an IP address, a slash and a prefix length, for example "10.0.0.0/8" or "2001:db8::/32".`,
    );
  });
});
