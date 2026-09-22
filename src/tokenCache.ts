import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface TokenInfo {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** epoch seconds, computed on save */
  expires_at: number;
}

interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

const noopLogger: Logger = { debug: () => {}, warn: () => {} };

/**
 * Persists the OAuth token to a JSON file inside Homebridge's storage
 * path, so re-login isn't required on every restart (mirrors mbapi2020's
 * token file cache).
 */
export class TokenCache {
  private readonly filePath: string;

  constructor(
    storagePath: string,
    accountKey: string,
    private readonly log: Logger = noopLogger,
  ) {
    this.filePath = path.join(storagePath, `.mercedes-lock-token-${accountKey}.json`);
  }

  async load(): Promise<TokenInfo | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const token = JSON.parse(raw) as TokenInfo;
      this.log.debug('TokenCache: loaded cached token (expires_at=%s)', new Date(token.expires_at * 1000).toISOString());
      return token;
    } catch (err) {
      // ENOENT (no cache file yet) is the expected first-run case; any
      // other error (bad permissions, corrupt JSON) is worth surfacing
      // since it silently forces a full re-login otherwise.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log.debug('TokenCache: no cached token found at %s (first run or cache was cleared)', this.filePath);
      } else {
        this.log.warn('TokenCache: failed to read cached token at %s: %s', this.filePath, (err as Error).message);
      }
      return null;
    }
  }

  async save(token: TokenInfo): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(token, null, 2), { mode: 0o600 });
    this.log.debug('TokenCache: saved token to %s (expires_at=%s)', this.filePath, new Date(token.expires_at * 1000).toISOString());
  }
}

export function isTokenExpired(token: TokenInfo | null): boolean {
  if (!token) {
    return true;
  }
  const now = Math.floor(Date.now() / 1000);
  return token.expires_at - now < 60;
}
