import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface TokenInfo {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** epoch seconds, computed on save */
  expires_at: number;
}

/**
 * Persists the OAuth token to a JSON file inside Homebridge's storage
 * path, so re-login isn't required on every restart (mirrors mbapi2020's
 * token file cache).
 */
export class TokenCache {
  private readonly filePath: string;

  constructor(storagePath: string, accountKey: string) {
    this.filePath = path.join(storagePath, `.mercedes-lock-token-${accountKey}.json`);
  }

  async load(): Promise<TokenInfo | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as TokenInfo;
    } catch {
      return null;
    }
  }

  async save(token: TokenInfo): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(token, null, 2), { mode: 0o600 });
  }
}

export function isTokenExpired(token: TokenInfo | null): boolean {
  if (!token) {
    return true;
  }
  const now = Math.floor(Date.now() / 1000);
  return token.expires_at - now < 60;
}
