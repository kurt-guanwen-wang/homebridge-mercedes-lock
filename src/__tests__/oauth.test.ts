import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MercedesOAuth, MBAuthError } from '../oauth';
import { TokenCache, TokenInfo } from '../tokenCache';

const noopLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** Exposes a stubbable `login()` so these tests exercise getAccessToken()'s
 * dedup/backoff logic without making any real network calls. `login()` is
 * only ever invoked internally via `this.login()`, so overriding it here
 * is picked up by the base class's private `loginWithBackoff()`. */
class TestableOAuth extends MercedesOAuth {
  loginImpl: () => Promise<TokenInfo> = () => Promise.reject(new Error('not configured'));
  loginCallCount = 0;

  async login(): Promise<TokenInfo> {
    this.loginCallCount++;
    return this.loginImpl();
  }
}

function fakeToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe('MercedesOAuth.getAccessToken', () => {
  let dir: string;
  let tokenCache: TokenCache;
  let now: number;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mercedes-lock-oauth-test-'));
    tokenCache = new TokenCache(dir, 'test-account');
    now = 1_700_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(async () => {
    nowSpy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function newOauth(): TestableOAuth {
    return new TestableOAuth('user@example.com', 'password', 'North America', tokenCache, noopLogger);
  }

  it('logs in once when there is no cached token, and returns the resulting access token', async () => {
    const oauth = newOauth();
    oauth.loginImpl = async () => {
      const token = fakeToken();
      oauth.token = token;
      return token;
    };

    const accessToken = await oauth.getAccessToken();

    expect(accessToken).toBe('access-1');
    expect(oauth.loginCallCount).toBe(1);
  });

  it('does not log in again while the cached token is still valid', async () => {
    const oauth = newOauth();
    oauth.token = fakeToken({ expires_at: Math.floor(now / 1000) + 3600 });

    const accessToken = await oauth.getAccessToken();

    expect(accessToken).toBe('access-1');
    expect(oauth.loginCallCount).toBe(0);
  });

  it('coalesces concurrent getAccessToken() calls into a single login attempt', async () => {
    const oauth = newOauth();
    // No refresh_token, so getAccessTokenInternal() reaches login()
    // synchronously (no prior `await` on a file read or a refresh call),
    // letting both calls below observe the same in-flight promise.
    oauth.token = fakeToken({ expires_at: 0, refresh_token: undefined });
    let resolveLogin!: (token: TokenInfo) => void;
    oauth.loginImpl = () =>
      new Promise((resolve) => {
        resolveLogin = resolve;
      });

    const first = oauth.getAccessToken();
    const second = oauth.getAccessToken();

    resolveLogin(fakeToken());
    oauth.token = fakeToken();
    await Promise.all([first, second]);

    expect(oauth.loginCallCount).toBe(1);
  });

  it('does not retry login immediately after a failure (backs off)', async () => {
    const oauth = newOauth();
    oauth.loginImpl = () => Promise.reject(new Error('bad credentials'));

    await expect(oauth.getAccessToken()).rejects.toThrow('bad credentials');
    expect(oauth.loginCallCount).toBe(1);

    // A second call made immediately after the failure should be rejected
    // by the backoff guard itself, without attempting another login.
    await expect(oauth.getAccessToken()).rejects.toThrow(MBAuthError);
    expect(oauth.loginCallCount).toBe(1);
  });

  it('allows a retry once the backoff window (30s) has elapsed, and doubles the backoff on a second failure', async () => {
    const oauth = newOauth();
    oauth.loginImpl = () => Promise.reject(new Error('still bad'));

    await expect(oauth.getAccessToken()).rejects.toThrow('still bad');
    expect(oauth.loginCallCount).toBe(1);

    now += 31_000; // past the initial 30s backoff
    await expect(oauth.getAccessToken()).rejects.toThrow('still bad');
    expect(oauth.loginCallCount).toBe(2);

    // Backoff should have doubled to ~60s: retrying after only 31s more
    // should still be blocked (no third login attempt).
    now += 31_000;
    await expect(oauth.getAccessToken()).rejects.toThrow(MBAuthError);
    expect(oauth.loginCallCount).toBe(2);

    // But after the full doubled window, it should try again.
    now += 30_000;
    await expect(oauth.getAccessToken()).rejects.toThrow('still bad');
    expect(oauth.loginCallCount).toBe(3);
  });

  it('resets the backoff to the initial delay after a successful login', async () => {
    const oauth = newOauth();
    oauth.loginImpl = () => Promise.reject(new Error('fail once'));
    await expect(oauth.getAccessToken()).rejects.toThrow('fail once');
    expect(oauth.loginCallCount).toBe(1);

    now += 31_000;
    oauth.loginImpl = async () => {
      const token = fakeToken();
      oauth.token = token;
      return token;
    };
    await expect(oauth.getAccessToken()).resolves.toBe('access-1');
    expect(oauth.loginCallCount).toBe(2);

    // Force expiry again and fail: should back off by the *initial* 30s,
    // not a further-doubled amount, since the previous login succeeded.
    oauth.token = fakeToken({ expires_at: 0 });
    oauth.loginImpl = () => Promise.reject(new Error('fail again'));
    await expect(oauth.getAccessToken()).rejects.toThrow('fail again');
    expect(oauth.loginCallCount).toBe(3);

    now += 29_000; // just under 30s: should still be blocked
    await expect(oauth.getAccessToken()).rejects.toThrow(MBAuthError);
    expect(oauth.loginCallCount).toBe(3);

    now += 2_000; // now past 30s
    await expect(oauth.getAccessToken()).rejects.toThrow('fail again');
    expect(oauth.loginCallCount).toBe(4);
  });

  it('retries refresh-token renewal without any backoff (only full login is throttled)', async () => {
    const oauth = newOauth();
    oauth.token = fakeToken({ expires_at: 0 }); // expired, but has a refresh_token
    const refreshSpy = jest
      .spyOn(oauth, 'refresh')
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(fakeToken());
    oauth.loginImpl = () => Promise.reject(new Error('login should back off, not matter here'));

    // First call: refresh fails, falls back to login (which also fails).
    await expect(oauth.getAccessToken()).rejects.toThrow();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(oauth.loginCallCount).toBe(1);

    // Refresh itself should be retried immediately next time (no backoff),
    // even though login is still within its backoff window.
    oauth.token = fakeToken({ expires_at: 0 });
    await expect(oauth.getAccessToken()).resolves.toBe('access-1');
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    expect(oauth.loginCallCount).toBe(1);
  });
});
