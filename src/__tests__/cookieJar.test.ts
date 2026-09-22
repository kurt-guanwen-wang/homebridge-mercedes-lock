/**
 * Minimal cookie jar: accumulates Set-Cookie response headers and renders
 * them back as a single Cookie request header.
 */
import { CookieJar } from '../cookieJar';

describe('CookieJar', () => {
  it('renders no cookies as an empty header', () => {
    expect(new CookieJar().header()).toBe('');
  });

  it('parses a single Set-Cookie header', () => {
    const jar = new CookieJar();
    jar.absorb('sessionid=abc123; Path=/; HttpOnly');
    expect(jar.header()).toBe('sessionid=abc123');
  });

  it('parses multiple Set-Cookie headers (array form)', () => {
    const jar = new CookieJar();
    jar.absorb(['a=1; Path=/', 'b=2; Secure']);
    expect(jar.header()).toBe('a=1; b=2');
  });

  it('overwrites an existing cookie with the same name', () => {
    const jar = new CookieJar();
    jar.absorb('a=1');
    jar.absorb('a=2');
    expect(jar.header()).toBe('a=2');
  });

  it('ignores malformed Set-Cookie entries with no "="', () => {
    const jar = new CookieJar();
    jar.absorb('malformed-cookie-no-equals');
    expect(jar.header()).toBe('');
  });

  it('does nothing when absorb is called with undefined', () => {
    const jar = new CookieJar();
    jar.set('a', '1');
    jar.absorb(undefined);
    expect(jar.header()).toBe('a=1');
  });

  it('merges manually-set cookies with absorbed ones', () => {
    const jar = new CookieJar();
    jar.set('CIAM.DEVICE', 'abcd');
    jar.absorb('sessionid=xyz; Path=/');
    expect(jar.header()).toBe('CIAM.DEVICE=abcd; sessionid=xyz');
  });
});
