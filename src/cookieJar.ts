/**
 * Minimal cookie jar: accumulates Set-Cookie response headers and renders
 * them back as a single Cookie request header. Good enough for the
 * short-lived CIAM login session (mirrors aiohttp.CookieJar usage in
 * mbapi2020's oauth.py).
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  /** Parse one or more raw Set-Cookie header values. */
  absorb(setCookieHeader: string | string[] | undefined): void {
    if (!setCookieHeader) {
      return;
    }
    // undici returns a bare string when there's exactly one Set-Cookie
    // header, and an array only when there are multiple. Normalize first -
    // iterating a raw string with for..of would iterate characters, not
    // cookies.
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const raw of headers) {
      const firstPair = raw.split(';')[0];
      const eq = firstPair.indexOf('=');
      if (eq === -1) {
        continue;
      }
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      if (name) {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}
