import { randomBytes, createHash } from 'node:crypto';
import { request } from 'undici';
import { CookieJar } from './cookieJar';
import { Region, loginBaseUrl, loginAppId, REDIRECT_URI, OAUTH_SCOPE, MOBILE_SAFARI_USER_AGENT } from './constants';
import { TokenCache, TokenInfo, isTokenExpired } from './tokenCache';

export class MBAuthError extends Error {}
export class MBAuth2FAError extends MBAuthError {}

interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/**
 * Ports mbapi2020's oauth.py PKCE login flow (id.mercedes-benz.com CIAM) to
 * Node.js, so credentials never have to leave Homebridge (no Home Assistant
 * dependency). MFA is not supported by this flow - disable it on the
 * account used with this plugin.
 */
export class MercedesOAuth {
  private readonly jar = new CookieJar();
  private codeVerifier = '';
  private codeChallenge = '';
  private readonly loginBase: string;
  private readonly clientId: string;
  token: TokenInfo | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly region: Region,
    private readonly tokenCache: TokenCache,
    private readonly log: Logger,
  ) {
    this.loginBase = loginBaseUrl(region);
    this.clientId = loginAppId(region);
  }

  /** Returns a valid access token, logging in or refreshing as needed. */
  async getAccessToken(): Promise<string> {
    if (!this.token) {
      this.token = await this.tokenCache.load();
    }

    if (isTokenExpired(this.token)) {
      if (this.token?.refresh_token) {
        try {
          await this.refresh(this.token.refresh_token);
        } catch (err) {
          this.log.warn('Token refresh failed, falling back to full login: %s', (err as Error).message);
          await this.login();
        }
      } else {
        await this.login();
      }
    }

    return this.token!.access_token;
  }

  private generatePkce(): void {
    this.codeVerifier = randomBytes(32).toString('base64url');
    this.codeChallenge = createHash('sha256').update(this.codeVerifier).digest('base64url');
  }

  private mobileHeaders(includeReferer = true): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: this.loginBase,
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': MOBILE_SAFARI_USER_AGENT,
      cookie: this.jar.header(),
    };
    if (includeReferer) {
      headers.referer = `${this.loginBase}/ciam/auth/login`;
    }
    return headers;
  }

  async login(): Promise<TokenInfo> {
    this.log.info('Starting Mercedes Me OAuth2 login');
    this.generatePkce();
    this.jar.set('CIAM.DEVICE', randomBytes(16).toString('hex'));

    const resumeUrl = await this.getAuthorizationResume();
    await this.sendUserAgentInfo();
    await this.submitUsername();

    const rid = randomBytes(18).toString('base64url');
    const preLogin = await this.submitPassword(rid);

    if (preLogin.result !== 'RESUME2OIDCP') {
      if (preLogin.result === 'GOTO_LOGIN_OTP') {
        throw new MBAuth2FAError(
          'Two-factor authentication (2FA) is enabled on this account. Disable MFA to use this plugin.',
        );
      }
      throw new MBAuthError(`Unexpected login result: ${JSON.stringify(preLogin)}`);
    }

    if (typeof preLogin.token !== 'string' || !preLogin.token) {
      throw new MBAuthError('Login response did not include a resume token');
    }

    const code = await this.resumeAuthorization(resumeUrl, preLogin.token);
    const tokenResponse = await this.exchangeCodeForTokens(code);

    const token = this.finalizeToken(tokenResponse);
    this.token = token;
    await this.tokenCache.save(token);
    this.codeVerifier = '';
    this.codeChallenge = '';
    this.log.info('Mercedes Me OAuth2 login successful');
    return token;
  }

  private async getAuthorizationResume(): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      code_challenge: this.codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: OAUTH_SCOPE,
    });

    const finalUrl = await this.followRedirectsCapturingUrl(
      `${this.loginBase}/as/authorization.oauth2?${params.toString()}`,
      { 'user-agent': MOBILE_SAFARI_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    );

    const resume = new URL(finalUrl).searchParams.get('resume');
    if (!resume) {
      throw new MBAuthError('Resume parameter not found in authorization response');
    }
    return resume;
  }

  /** GETs a URL following redirects manually so we can capture cookies + the final URL. */
  private async followRedirectsCapturingUrl(url: string, headers: Record<string, string>): Promise<string> {
    let current = url;
    for (let i = 0; i < 10; i++) {
      const res = await request(current, {
        method: 'GET',
        headers: { ...headers, cookie: this.jar.header() },
        maxRedirections: 0,
      });
      this.jar.absorb(res.headers['set-cookie'] as string | string[] | undefined);

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        current = new URL(res.headers.location as string, current).toString();
        await res.body.dump();
        continue;
      }
      await res.body.dump();
      return current;
    }
    throw new MBAuthError('Too many redirects during authorization');
  }

  private async sendUserAgentInfo(): Promise<void> {
    const res = await request(`${this.loginBase}/ciam/auth/ua`, {
      method: 'POST',
      headers: { ...this.mobileHeaders(false), accept: '*/*' },
      body: JSON.stringify({ browserName: 'Mobile Safari', browserVersion: '15.6.6', osName: 'iOS' }),
    });
    this.jar.absorb(res.headers['set-cookie'] as string | string[] | undefined);
    await res.body.dump();
  }

  private async submitUsername(): Promise<void> {
    const res = await request(`${this.loginBase}/ciam/auth/login/user`, {
      method: 'POST',
      headers: this.mobileHeaders(),
      body: JSON.stringify({ username: this.username }),
    });
    this.jar.absorb(res.headers['set-cookie'] as string | string[] | undefined);
    const body = await res.body.text();
    if (res.statusCode >= 400) {
      throw new MBAuthError(`Username submission failed: ${res.statusCode} - ${body}`);
    }
  }

  private async submitPassword(rid: string): Promise<Record<string, unknown>> {
    const res = await request(`${this.loginBase}/ciam/auth/login/pass`, {
      method: 'POST',
      headers: this.mobileHeaders(),
      body: JSON.stringify({ username: this.username, password: this.password, rememberMe: false, rid }),
    });
    this.jar.absorb(res.headers['set-cookie'] as string | string[] | undefined);
    const body = (await res.body.json()) as Record<string, unknown>;
    if (res.statusCode >= 400) {
      throw new MBAuthError(`Password submission failed: ${res.statusCode} - ${JSON.stringify(body)}`);
    }
    return body;
  }

  private async resumeAuthorization(resumeUrl: string, token: string): Promise<string> {
    const res = await request(`${this.loginBase}${resumeUrl}`, {
      method: 'POST',
      headers: {
        ...this.mobileHeaders(),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
      },
      body: new URLSearchParams({ token }).toString(),
      maxRedirections: 0,
    });

    const location = res.headers.location as string | undefined;
    if ((res.statusCode === 301 || res.statusCode === 302) && location?.startsWith('rismycar://')) {
      await res.body.dump();
      const code = new URL(location).searchParams.get('code');
      if (!code) {
        throw new MBAuthError('Authorization code not found in redirect URL');
      }
      return code;
    }
    const body = await res.body.text();
    throw new MBAuthError(`Unexpected response during authorization resume: ${res.statusCode} - ${body}`);
  }

  private async exchangeCodeForTokens(code: string): Promise<Record<string, unknown>> {
    const form = new URLSearchParams({
      client_id: this.clientId,
      code,
      code_verifier: this.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    });

    const res = await request(`${this.loginBase}/as/token.oauth2`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const body = (await res.body.json()) as Record<string, unknown>;
    if (res.statusCode >= 400) {
      throw new MBAuthError(`Token exchange failed: ${res.statusCode} - ${JSON.stringify(body)}`);
    }
    return body;
  }

  async refresh(refreshToken: string): Promise<TokenInfo> {
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });

    const res = await request(`${this.loginBase}/as/token.oauth2`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const body = (await res.body.json()) as Record<string, unknown>;
    if (res.statusCode >= 400) {
      throw new MBAuthError(`Token refresh failed: ${res.statusCode} - ${JSON.stringify(body)}`);
    }
    if (!body.refresh_token) {
      body.refresh_token = refreshToken;
    }

    const token = this.finalizeToken(body);
    this.token = token;
    await this.tokenCache.save(token);
    return token;
  }

  private finalizeToken(body: Record<string, unknown>): TokenInfo {
    const expiresIn = Number(body.expires_in ?? 3600);
    return {
      access_token: String(body.access_token),
      refresh_token: String(body.refresh_token),
      expires_in: expiresIn,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    };
  }
}
