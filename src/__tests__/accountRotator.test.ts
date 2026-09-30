import { AccountRotator } from '../accountRotator';
import { MercedesOAuth } from '../oauth';
import { TokenInfo } from '../tokenCache';

function fakeToken(id: string): TokenInfo {
  return {
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
}

/** Minimal fake matching the MercedesOAuth methods AccountRotator calls. */
function fakeAccount(id: string, email = `${id}@example.com`) {
  return {
    getAccessToken: jest.fn().mockResolvedValue(`access-${id}`),
    login: jest.fn().mockResolvedValue(fakeToken(id)),
    maskedUsername: email,
  } as unknown as MercedesOAuth;
}

const logger = { info: jest.fn() };

describe('AccountRotator', () => {
  beforeEach(() => {
    logger.info.mockClear();
  });

  it('throws if constructed with zero accounts', () => {
    expect(() => new AccountRotator([], logger)).toThrow('at least one account');
  });

  it('delegates getAccessToken/login to the current account', async () => {
    const a = fakeAccount('a');
    const b = fakeAccount('b');
    const rotator = new AccountRotator([a, b], logger);

    await expect(rotator.getAccessToken()).resolves.toBe('access-a');
    await expect(rotator.login()).resolves.toEqual(fakeToken('a'));
    expect(a.getAccessToken).toHaveBeenCalledTimes(1);
    expect(a.login).toHaveBeenCalledTimes(1);
    expect(b.getAccessToken).not.toHaveBeenCalled();
  });

  it('advanceAccount() rotates to the next account and wraps around', async () => {
    const a = fakeAccount('a');
    const b = fakeAccount('b');
    const rotator = new AccountRotator([a, b], logger);

    expect(rotator.currentAccountNumber).toBe(1);
    expect(rotator.advanceAccount()).toBe(true);
    expect(rotator.currentAccountNumber).toBe(2);
    await expect(rotator.getAccessToken()).resolves.toBe('access-b');
    expect(rotator.maskedUsername).toBe('b@example.com');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('switching'), 2, 2, 'b@example.com');

    expect(rotator.advanceAccount()).toBe(true);
    expect(rotator.currentAccountNumber).toBe(1);
    await expect(rotator.getAccessToken()).resolves.toBe('access-a');
  });

  it('advanceAccount() is a no-op returning false with only one account', () => {
    const rotator = new AccountRotator([fakeAccount('a')], logger);
    expect(rotator.advanceAccount()).toBe(false);
    expect(rotator.currentAccountNumber).toBe(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
