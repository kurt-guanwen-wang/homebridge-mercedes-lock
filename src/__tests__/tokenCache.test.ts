import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TokenCache, isTokenExpired, TokenInfo } from '../tokenCache';

describe('TokenCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mercedes-lock-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null when no token file exists yet', async () => {
    const cache = new TokenCache(dir, 'account1');
    expect(await cache.load()).toBeNull();
  });

  it('round-trips a saved token', async () => {
    const cache = new TokenCache(dir, 'account1');
    const token: TokenInfo = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };

    await cache.save(token);
    expect(await cache.load()).toEqual(token);
  });

  it('keys the cache file by account so different accounts do not collide', async () => {
    const cacheA = new TokenCache(dir, 'accountA');
    const cacheB = new TokenCache(dir, 'accountB');
    const tokenA: TokenInfo = { access_token: 'a', refresh_token: 'ra', expires_in: 60, expires_at: 0 };

    await cacheA.save(tokenA);

    expect(await cacheA.load()).toEqual(tokenA);
    expect(await cacheB.load()).toBeNull();
  });
});

describe('isTokenExpired', () => {
  it('treats a null token as expired', () => {
    expect(isTokenExpired(null)).toBe(true);
  });

  it('treats a token expiring in more than 60s as valid', () => {
    const token: TokenInfo = {
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 120,
    };
    expect(isTokenExpired(token)).toBe(false);
  });

  it('treats a token expiring within 60s as expired (safety margin)', () => {
    const token: TokenInfo = {
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 30,
    };
    expect(isTokenExpired(token)).toBe(true);
  });

  it('treats an already-past expiry as expired', () => {
    const token: TokenInfo = {
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 10,
    };
    expect(isTokenExpired(token)).toBe(true);
  });
});
