import { describe, expect, it } from 'vitest';
import { checkWebhook } from '../destination.ts';
import { BUILT_IN_DRIVERS } from './index.ts';

const token = (...parts: string[]): string => parts.join('');
const slackUrl = ['https://hooks.slack.com/services', 'T0', 'B0', token('x', 'x'.repeat(23))].join('/');
const discordUrl = (host: string, prefix = '/api/webhooks'): string => `https://${host}${prefix}/${'1'.repeat(18)}/${token('t', 'k'.repeat(20))}`;
const teamsUrl = (host: string): string =>
  `https://${host}/powerautomate/automations/direct/workflows/${'a'.repeat(32)}/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${token('s', 'g'.repeat(20))}`;

const accepted: [keyof typeof BUILT_IN_DRIVERS, string][] = [
  ['slack', slackUrl],
  ['discord', discordUrl('discord.com')],
  ['discord', discordUrl('discord.com', '/api/v10/webhooks')],
  ['discord', discordUrl('canary.discord.com')],
  ['discord', discordUrl('ptb.discord.com')],
  ['discord', discordUrl('discordapp.com')],
  ['teams', teamsUrl('prod-12.westeurope.environment.api.powerplatform.com')],
  ['teams', teamsUrl('x.1.environment.api.powerplatform.com')],
];

describe('the built-in drivers', () => {
  it('are exactly slack, discord and teams', () => {
    expect(Object.keys(BUILT_IN_DRIVERS)).toEqual(['slack', 'discord', 'teams']);
  });

  it.each(accepted)('%s accepts %#: a real-shaped address', (name, url) => {
    expect(checkWebhook(url, BUILT_IN_DRIVERS[name]).ok).toBe(true);
  });

  it('refuses the address of another provider', () => {
    for (const [name, url] of accepted) {
      for (const other of Object.keys(BUILT_IN_DRIVERS) as (keyof typeof BUILT_IN_DRIVERS)[]) {
        if (other !== name) expect(checkWebhook(url, BUILT_IN_DRIVERS[other]).ok, `${other} took the ${name} address`).toBe(false);
      }
    }
  });

  it('refuses the old Teams trigger hosts, which stopped working', () => {
    const old = `https://prod-12.westeurope.logic.azure.com:443/workflows/${'a'.repeat(32)}/triggers/manual/paths/invoke?sig=${token('s', 'g'.repeat(20))}`;
    expect(checkWebhook(old, BUILT_IN_DRIVERS.teams).ok).toBe(false);
    expect(checkWebhook(teamsUrl('prod-12.westeurope.logic.azure.com'), BUILT_IN_DRIVERS.teams).ok).toBe(false);
    // the bare name is not a subdomain of it
    expect(checkWebhook(teamsUrl('environment.api.powerplatform.com'), BUILT_IN_DRIVERS.teams).ok).toBe(false);
  });

  it('refuse a path that is not a webhook path of their provider', () => {
    expect(checkWebhook('https://hooks.slack.com/other/T0/B0/x', BUILT_IN_DRIVERS.slack).ok).toBe(false);
    expect(checkWebhook('https://discord.com/api/channels/1/x', BUILT_IN_DRIVERS.discord).ok).toBe(false);
  });

  it('are frozen, with their hosts, their paths and the table', () => {
    expect(Object.isFrozen(BUILT_IN_DRIVERS)).toBe(true);
    for (const driver of Object.values(BUILT_IN_DRIVERS)) {
      expect(Object.isFrozen(driver)).toBe(true);
      expect(Object.isFrozen(driver.hosts)).toBe(true);
      expect(Object.isFrozen(driver.paths)).toBe(true);
      expect(() => (driver.hosts as string[]).push('evil.example')).toThrow(TypeError);
      expect(() => (driver.paths as string[]).push('/')).toThrow(TypeError);
    }
    expect(() => {
      (BUILT_IN_DRIVERS as Record<string, unknown>).evil = {};
    }).toThrow(TypeError);
  });
});
