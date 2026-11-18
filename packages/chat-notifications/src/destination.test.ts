import { describe, expect, it } from 'vitest';
import { checkSinkAddress, checkWebhook, describeDestination, hostPatternProblem, pathPrefixProblem } from './destination.ts';

const token = ['T0', 'B0', 'x'.repeat(24)].join('/');
const slack = { hosts: ['hooks.slack.com'], paths: ['/services/'] };
const teams = { hosts: ['*.environment.api.powerplatform.com'], paths: ['/powerautomate/automations/direct/'] };
const slackUrl = (host: string, path = `/services/${token}`): string => `https://${host}${path}`;

function problem(url: string, rule: { hosts: string[]; paths: string[] } = slack, name = 'slack'): string {
  const result = checkWebhook(url, rule, name);
  if (result.ok) throw new Error('expected a refusal');
  expect('href' in result).toBe(false);
  return result.problem;
}

function href(url: string, rule: { hosts: string[]; paths: string[] } = slack): string {
  const result = checkWebhook(url, rule, 'slack');
  if (!result.ok) throw new Error(result.problem);
  return result.href;
}

describe('the written form of an address', () => {
  const teamsPath = `/powerautomate/automations/direct/${token}?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sig=${'q'.repeat(20)}`;
  const accepted: [string, string, { hosts: string[]; paths: string[] }, string][] = [
    ['canonical', slackUrl('hooks.slack.com'), slack, `https://hooks.slack.com/services/${token}`],
    ['an upper-case address', slackUrl('HOOKS.SLACK.COM').replace('https', 'HTTPS'), slack, `https://hooks.slack.com/services/${token}`],
    ['port 443', slackUrl('hooks.slack.com:443'), slack, `https://hooks.slack.com/services/${token}`],
    ['a trailing dot', slackUrl('hooks.slack.com.'), slack, `https://hooks.slack.com/services/${token}`],
    ['a trailing dot and port 443', slackUrl('hooks.slack.com.:443'), slack, `https://hooks.slack.com/services/${token}`],
    ['a query on Discord', `https://discord.com/api/webhooks/${token}?thread_id=42`, { hosts: ['discord.com'], paths: ['/api/webhooks/'] }, `https://discord.com/api/webhooks/${token}?thread_id=42`],
    [
      'a full Teams address with :443 and %2F in the query',
      `https://prod-12.westeurope.environment.api.powerplatform.com:443${teamsPath}`,
      teams,
      `https://prod-12.westeurope.environment.api.powerplatform.com${teamsPath}`,
    ],
  ];

  it.each(accepted)('accepts %s', (_name, url, rule, expected) => {
    expect(href(url, rule)).toBe(expected);
    expect(checkSinkAddress(url).ok).toBe(true);
  });

  const refused: [string, string][] = [
    ['no slashes after the scheme', `https:hooks.slack.com/services/${token}`],
    ['one slash after the scheme', `https:/hooks.slack.com/services/${token}`],
    ['three slashes after the scheme', `https:///hooks.slack.com/services/${token}`],
    ['a tab in the host', `https://hooks.sla\tck.com/services/${token}`],
    ['a newline in the path', `https://hooks.slack.com/serv\nices/${token}`],
    ['a tab in the scheme', `ht\ttps://hooks.slack.com/services/${token}`],
    ['a leading space', ` https://hooks.slack.com/services/${token}`],
    ['a dot segment', `https://hooks.slack.com/./services/${token}`],
    ['a dot-dot segment', `https://hooks.slack.com/x/../services/${token}`],
    ['an encoded dot segment', `https://hooks.slack.com/%2e/services/${token}`],
    ['a fullwidth host', `https://hooks.slack.\uFF43\uFF4F\uFF4D/services/${token}`],
    ['a percent-encoded host', `https://hooks.slack.%63om/services/${token}`],
    ['an empty port', `https://hooks.slack.com:/services/${token}`],
    ['a port with a leading zero', `https://hooks.slack.com:0443/services/${token}`],
    ['another port', `https://hooks.slack.com:8443/services/${token}`],
    ['credentials', `https://user:pw@hooks.slack.com/services/${token}`],
    ['a double quote in the secret', `https://hooks.slack.com/services/${token}"x`],
    ['a single quote in the secret', `https://hooks.slack.com/services/${token}'x`],
    ['an angle bracket in the secret', `https://hooks.slack.com/services/${token}<x`],
    ['a backslash as a separator', `https://hooks.slack.com\\services\\${token.replaceAll('/', '\\')}`],
    ['a backslash after the scheme', `https:\\\\hooks.slack.com/services/${token}`],
    ['a backslash in the query', `https://hooks.slack.com/services/${token}?a=b\\c`],
    ['a backslash in the fragment', `https://hooks.slack.com/services/${token}#a\\b`],
    ['an empty query', `https://hooks.slack.com/services/${token}?`],
    ['a non-ASCII character in the path', `https://hooks.slack.com/services/${token}\u00E9`],
    ['http', `http://hooks.slack.com/services/${token}`],
    ['no path', 'https://hooks.slack.com'],
  ];

  it.each(refused)('refuses %s, and the refusal holds neither the path nor the query', (_name, url) => {
    const found = checkWebhook(url, slack, 'slack');
    expect(found.ok, url).toBe(false);
    expect(checkSinkAddress(url).ok, url).toBe(false);
    if (!found.ok) {
      expect(found.problem).toBe('The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
      expect(found.problem).not.toContain(token);
    }
  });
});

describe('checkWebhook', () => {
  it('returns the parsed address: lower-case host, no trailing dot, no explicit default port', () => {
    expect(href(`HTTPS://HOOKS.SLACK.COM.:443/services/${token}`)).toBe(`https://hooks.slack.com/services/${token}`);
    expect(href(slackUrl('hooks.slack.com'))).toBe(`https://hooks.slack.com/services/${token}`);
    expect(href(slackUrl('HOOKS.SLACK.COM.'))).toBe(`https://hooks.slack.com/services/${token}`);
  });

  it('accepts a subdomain for a wildcard entry and keeps the query', () => {
    const url = `https://prod-12.westeurope.environment.api.powerplatform.com/powerautomate/automations/direct/${token}?sig=a%2Fb`;
    expect(href(url, teams)).toBe(url);
  });

  it('refuses every other scheme than https', () => {
    expect(problem(slackUrl('hooks.slack.com').replace('https', 'http'))).toContain('https');
    expect(problem(`ftp://hooks.slack.com/services/${token}`)).toContain('https');
  });

  it('refuses credentials, a user, a password only, and a ports other than 443', () => {
    for (const url of [`https://user:pw@hooks.slack.com/services/${token}`, `https://user@hooks.slack.com/services/${token}`, `https://:pw@hooks.slack.com/services/${token}`, slackUrl('hooks.slack.com:8443'), slackUrl('hooks.slack.com@evil.example')]) {
      expect(problem(url), url).toBe('The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
    }
  });

  it('refuses a host that merely contains or ends like a listed one', () => {
    for (const host of ['hooks.slack.com.evil.example', 'evilhooks.slack.com', 'x.hooks.slack.com', 'hooks.slack.com..']) {
      expect(problem(slackUrl(host)), host).toContain('hosts of driver "slack" (hooks.slack.com)');
    }
  });

  it('refuses the bare name of a wildcard entry and a name that only ends like its suffix', () => {
    const path = `/powerautomate/automations/direct/${token}`;
    for (const host of ['environment.api.powerplatform.com', 'evilenvironment.api.powerplatform.com', 'environment.api.powerplatform.com.evil.example']) {
      expect(problem(slackUrl(host, path), teams, 'teams'), host).toContain('hosts of driver "teams"');
    }
  });

  it('refuses IP literals, also when a rule lists the same text', () => {
    expect(problem(slackUrl('1.2.3.4'))).toContain('hosts of driver');
    for (const host of ['[::1]', '[2001:db8::1]', '0x7f.1']) expect(problem(slackUrl(host)), host).toBe('The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
    expect(problem(slackUrl('1.2.3.4'), { hosts: ['1.2.3.4'], paths: ['/services/'] })).toContain('hosts of driver');
    expect(problem(slackUrl('[::1]'), { hosts: ['[::1]'], paths: ['/services/'] })).toBe('The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
  });

  it('refuses a path outside the prefixes, also one that dots or encoded dots lead out of', () => {
    for (const path of ['/api/chat.postMessage', '/services%2Fx', '/services']) {
      expect(problem(slackUrl('hooks.slack.com', path)), path).toContain('not a webhook address of driver "slack"');
    }
    for (const path of ['/services/../api/x', '/services/%2e%2e/x', '/services/%2E%2E/x']) expect(problem(slackUrl('hooks.slack.com', path)), path).toBe('The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
  });

  it('refuses an encoded slash or backslash inside the prefix', () => {
    for (const path of ['/services/a%2fb', '/services/a%2Fb', '/services/a%5cb', '/services/a%5Cb']) {
      expect(problem(slackUrl('hooks.slack.com', path)), path).toContain('not a webhook address of driver "slack"');
    }
  });

  it('refuses everything for a rule that lists no host or no path', () => {
    expect(problem(slackUrl('hooks.slack.com'), { hosts: [], paths: ['/'] })).toBe('The webhook host "hooks.slack.com" is not one of the hosts of driver "slack" ().');
    expect(problem(slackUrl('hooks.slack.com'), { hosts: ['hooks.slack.com'], paths: [] })).toBe('The webhook address on "hooks.slack.com" is not a webhook address of driver "slack".');
  });

  it('refuses a missing rule from a caller that ignores the types', () => {
    const result = checkWebhook('https://evil.example/x', undefined as never);
    expect(result.ok).toBe(false);
    expect(checkWebhook('https://evil.example/x', null as never).ok).toBe(false);
    expect(checkWebhook('https://evil.example/x', {} as never).ok).toBe(false);
  });

  it('refuses an object that only converts to a good address', () => {
    const url = { toString: () => slackUrl('hooks.slack.com') } as unknown as string;
    expect(problem(url)).toBe('The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
  });

  it('refuses a string that is not an address, an empty one, one without a host and a non-string', () => {
    for (const url of ['not a url', '', 'https://', 5 as never, undefined as never]) {
      expect(problem(url), String(url)).toBe('The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
    }
  });

  it('never puts the path or the query of the address into a message', () => {
    const secretUrls = [
      `http://hooks.slack.com/services/${token}?k=${token}`,
      `https://u:${token}@hooks.slack.com/services/${token}`,
      `https://hooks.slack.com:8443/services/${token}?k=${token}`,
      `https://evil.example/services/${token}?k=${token}`,
      `https://1.2.3.4/services/${token}`,
      `https://hooks.slack.com/other/${token}?k=${token}`,
      `https://hooks.slack.com/services/../${token}?k=${token}`,
      `https://hooks.slack.com/services/%2f${token}?k=${token}`,
      `${token} not a url`,
    ];
    for (const url of secretUrls) {
      const message = problem(url);
      expect(message).not.toContain(token);
      expect(message).not.toContain('x'.repeat(24));
    }
  });
});

describe('checkSinkAddress', () => {
  it('accepts an https address and returns no address', () => {
    expect(checkSinkAddress('HTTPS://Anything.Example.:443/x?y=1')).toEqual({ ok: true });
  });

  it('refuses http, credentials, ports, IP literals and what is no address', () => {
    const problemOf = (url: string): string => {
      const result = checkSinkAddress(url);
      if (result.ok) throw new Error('expected a refusal');
      return result.problem;
    };
    for (const url of ['http://anything.example/x', 'https://u:p@anything.example/x', 'https://anything.example:81/x', 'https://[::1]/x', 'nope']) expect(problemOf(url), url).toBe('The webhook address must be written as https://host/path, without spaces, quotes, backslashes or a port other than 443.');
    expect(problemOf('https://1.2.3.4/x')).toContain('IP address');
  });
});

describe('hostPatternProblem', () => {
  it('accepts a DNS name and a wildcard in front of one', () => {
    for (const pattern of ['hooks.slack.com', '*.example.com', 'a-b.c1.example']) expect(hostPatternProblem(pattern), pattern).toBeUndefined();
  });

  it('refuses a bare wildcard, a top-level domain, an IP, a port, a second wildcard and upper case', () => {
    for (const pattern of ['*', '*.com', 'com', '1.2.3.4', '*.1.2.3.4', 'a.b:443', '*.*.x.y', 'a.*.y', 'Hooks.Slack.com', 'a..b', 'a.b.', '.a.b', '-a.b.c', '', 'a b.c']) {
      expect(hostPatternProblem(pattern), pattern).toContain('A host pattern is');
    }
  });

  it('accepts labels of 63 and names of 253 characters and refuses one more', () => {
    const label63 = 'a'.repeat(63);
    expect(hostPatternProblem(`${label63}.com`)).toBeUndefined();
    expect(hostPatternProblem(`${'a'.repeat(64)}.com`)).toBeDefined();
    const name = (length: number): string => [label63, label63, label63, 'a'.repeat(length - 63 * 3 - 3 - 4), 'com'].join('.');
    expect(name(253)).toHaveLength(253);
    expect(hostPatternProblem(name(253))).toBeUndefined();
    expect(name(254)).toHaveLength(254);
    expect(hostPatternProblem(name(254))).toBeDefined();
  });
});

describe('pathPrefixProblem', () => {
  it('accepts a prefix with segments, starting and ending with a slash', () => {
    for (const prefix of ['/services/', '/api/webhooks/', "/a.b_c~d!$&'()*+,;=:@-/"]) expect(pathPrefixProblem(prefix), prefix).toBeUndefined();
  });

  it('refuses every other form', () => {
    for (const prefix of ['', 'services/', '/', '/services', '/a/../b/', '/a/./b/', '/a//b/', '/%2e/', '/a%2fb/', '/a?x/', '/a#x/', '/a b/', '/a\u0000b/', '//', '/a\\b/', '/\u00e4/', '/a"b/', '/a<b/', '/a>b/', '/a^b/', '/a`b/', '/a{b/', '/a|b/', '/a}b/']) {
      expect(pathPrefixProblem(prefix), prefix).toContain('A path prefix');
    }
  });
});

describe('describeDestination', () => {
  it('names a destination and the host of a webhook, never the address', () => {
    expect(describeDestination('ops')).toBe('destination "ops"');
    expect(describeDestination({ url: `https://hooks.slack.com/services/${token}?k=${token}` })).toBe('a webhook on hooks.slack.com');
    expect(describeDestination({ url: `https://HOOKS.slack.com./services/${token}` })).toBe('a webhook on hooks.slack.com');
    expect(describeDestination({ url: `not a url ${token}` })).toBe('a webhook address that is not a URL');
  });

  it('does not repeat a string destination that is not a name, as it could be an address', () => {
    expect(describeDestination(`https://hooks.slack.com/services/${token}`)).toBe('a destination that is not a valid name');
  });
});
