import { MercedesOAuth, OAuthClient } from './oauth';
import { TokenInfo } from './tokenCache';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
}

/**
 * Mercedes allows up to 6 accounts to be invited as additional drivers on
 * the same car. This wraps one MercedesOAuth per configured account and
 * round-robins to the next one whenever the current account gets
 * persistently rate-limited (see MercedesWebSocket's re-login-after-429
 * handling, which calls advanceAccount() once it exhausts its retries on
 * the current account).
 *
 * MercedesApi and MercedesWebSocket only ever see this rotator (typed as
 * OAuthClient) - they always operate on "the current account" and don't
 * need to know a rotation happened; the next getAccessToken()/login()
 * call after a rotation transparently uses the new account's own token
 * cache and credentials.
 */
export class AccountRotator implements OAuthClient {
  private index = 0;

  constructor(
    private readonly accounts: MercedesOAuth[],
    private readonly log: Logger,
  ) {
    if (accounts.length === 0) {
      throw new Error('AccountRotator requires at least one account');
    }
  }

  private get current(): MercedesOAuth {
    return this.accounts[this.index];
  }

  getAccessToken(): Promise<string> {
    return this.current.getAccessToken();
  }

  login(): Promise<TokenInfo> {
    return this.current.login();
  }

  get accountCount(): number {
    return this.accounts.length;
  }

  get currentAccountNumber(): number {
    return this.index + 1;
  }

  /**
   * Rotates to the next configured account (wrapping around). Returns
   * `false` (and does nothing) if only one account is configured, since
   * there's nothing to fall back to.
   */
  advanceAccount(): boolean {
    if (this.accounts.length < 2) {
      return false;
    }
    this.index = (this.index + 1) % this.accounts.length;
    this.log.info(
      'AccountRotator: switching to Mercedes Me account %d of %d',
      this.currentAccountNumber,
      this.accounts.length,
    );
    return true;
  }
}
