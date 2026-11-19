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
    expect(problem(`https://user:pw@hooks.slack.com/services/${token}`)).toContain('credentials');
    expect(problem(`https://user@hooks.slack.com/services/${token}`)).toContain('credentials');
    expect(problem(`https://:pw@hooks.slack.com/services/${token}`)).toContain('credentials');
    expect(problem(slackUrl('hooks.slack.com:8443'))).toContain('port');
    expect(problem(slackUrl('hooks.slack.com@evil.example'))).toContain('credentials');
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
    for (const host of ['1.2.3.4', '[::1]', '[2001:db8::1]', '0x7f.1']) {
      expect(problem(slackUrl(host)), host).toContain('hosts of driver');
    }
    expect(problem(slackUrl('1.2.3.4'), { hosts: ['1.2.3.4'], paths: ['/services/'] })).toContain('hosts of driver');
    expect(problem(slackUrl('[::1]'), { hosts: ['[::1]'], paths: ['/services/'] })).toContain('hosts of driver');
  });

  it('refuses a path outside the prefixes, also one that dots or encoded dots lead out of', () => {
    for (const path of ['/api/chat.postMessage', '/services/../api/x', '/services/%2e%2e/x', '/services/%2E%2E/x', '/services%2Fx', '/services']) {
      expect(problem(slackUrl('hooks.slack.com', path)), path).toContain('not a webhook address of driver "slack"');
    }
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
    expect(problem(url)).toBe('The webhook address is not an address.');
  });

  it('refuses a string that is not an address, an empty one, one without a host and a non-string', () => {
    for (const url of ['not a url', '', 'https://', 5 as never, undefined as never]) {
      expect(problem(url), String(url)).toBe('The webhook address is not an address.');
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
    expect(problemOf('http://anything.example/x')).toContain('https');
    expect(problemOf('https://u:p@anything.example/x')).toContain('credentials');
    expect(problemOf('https://anything.example:81/x')).toContain('port');
    expect(problemOf('https://1.2.3.4/x')).toContain('IP address');
    expect(problemOf('https://[::1]/x')).toContain('IP address');
    expect(problemOf('nope')).toContain('not an address');
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
