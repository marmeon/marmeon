import type { EventDispatcher, Logger } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import type { AccountSessions } from './account-sessions.ts';
import { TwoFactorDisabled } from './events.ts';
import { AuthServiceProvider, type AuthUser } from './index.ts';
import { ResetTwoFactorCommand } from './reset-two-factor.ts';
import { TwoFactorState, type SecondFactor } from './two-factor/state.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

/** Holds factors for the one account, the way a bound source does; `removeAll()` can lose a race to an enrolment. */
class Factors extends TwoFactorState {
  held: SecondFactor[] = ['totp', 'passkey'];
  enrolDuringRemoval = false;
  override async factors() {
    return this.held;
  }
  override async enabledSince() {
    return undefined;
  }
  override async removeAll() {
    this.held = this.enrolDuringRemoval ? ['totp'] : [];
  }
}

function setup(ended: 'ok' | 'missing' = 'ok') {
  const users = new MemoryUsers<AuthUser>();
  users.add(ada);
  const state = new Factors();
  const order: string[] = [];
  const end = vi.fn(async () => {
    order.push('end');
    return ended === 'ok' ? { ok: true, value: { removed: 1 } } : { ok: false, error: { kind: 'missing' } };
  });
  const removeAll = vi.spyOn(state, 'removeAll');
  removeAll.mockImplementationOnce(async () => {
    order.push('removeAll');
    state.held = state.enrolDuringRemoval ? ['totp'] : [];
  });
  const dispatch = vi.fn(async (event: unknown) => void order.push(event instanceof TwoFactorDisabled ? `event:${event.via}` : 'event'));
  const info = vi.fn();
  const lines: string[] = [];
  const output = { line: (line: string) => lines.push(line), success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
  const command = new ResetTwoFactorCommand(users, { end } as unknown as AccountSessions, state, { dispatch } as unknown as EventDispatcher, { info } as unknown as Logger);
  const run = (args: string[], options: Record<string, boolean> = { force: true }) => command.handle({ args, options, output, root: '/', spawn: async () => 0 } as never);
  return { run, lines, state, order, end, removeAll, dispatch, info };
}

describe('auth:reset-two-factor', () => {
  it('ends the sessions, then removes the factors, then tells the owner and the log', async () => {
    const { run, lines, state, order, info } = setup();
    expect(await run([' ada@example.com '])).toBe(0);
    expect(order).toEqual(['end', 'removeAll', 'event:operator']);
    expect(state.held).toEqual([]);
    expect(lines).toEqual(['Removed the authenticator app, the passkeys and the recovery codes of ada@example.com, and ended its sessions.']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('second factor'), { userId: 1 });
  });

  it('exits 1 for an unknown identifier or none, and changes nothing', async () => {
    const { run, lines, end, removeAll, state } = setup();
    expect(await run(['nobody@example.com'])).toBe(1);
    expect(await run([])).toBe(1);
    expect(lines).toEqual(['✗ No account has the identifier nobody@example.com: the lookup is exact (only trimmed), so type it as it is stored, e.g. nobody@example.com.', '✗ Usage: marmeon auth:reset-two-factor <identifier> --force']);
    expect(end).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
    expect(state.held).toHaveLength(2);
  });

  it('does not find an address typed in capitals, says how to type it, and calls neither end nor removeAll', async () => {
    const { run, lines, end, removeAll, state } = setup();
    expect(await run(['ADA@Example.com'])).toBe(1);
    expect(lines).toEqual([expect.stringContaining('e.g. ada@example.com')]);
    expect(end).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
    expect(state.held).toHaveLength(2);
  });

  it('changes nothing without --force: sessions and factors stay', async () => {
    const { run, lines, end, removeAll, dispatch, state } = setup();
    expect(await run(['ada@example.com'], {})).toBe(1);
    expect(lines[0]).toContain('pass --force');
    expect(end).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.held).toHaveLength(2);
  });

  it('keeps the factors when the sessions cannot be ended, so the order cannot leave a half state', async () => {
    const { run, lines, removeAll, dispatch, state } = setup('missing');
    expect(await run(['ada@example.com'])).toBe(1);
    expect(lines).toEqual(['✗ The account ada@example.com vanished while its sessions were ended.']);
    expect(removeAll).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.held).toHaveLength(2);
  });

  it('exits 1 with a hint when a factor was enrolled while it ran', async () => {
    const { run, lines, state } = setup();
    state.enrolDuringRemoval = true;
    expect(await run(['ada@example.com'])).toBe(1);
    expect(lines).toEqual(['✗ A second factor was enrolled for ada@example.com while the command ran. Run it again.']);
  });

  it('says so, and does nothing, for an account without a second factor', async () => {
    const { run, lines, state, end } = setup();
    state.held = [];
    expect(await run(['ada@example.com'])).toBe(0);
    expect(lines).toEqual(['ada@example.com has no second factor.']);
    expect(end).not.toHaveBeenCalled();
  });

  it('is registered by the auth provider', () => {
    expect(AuthServiceProvider.commands).toContain(ResetTwoFactorCommand);
  });
});
