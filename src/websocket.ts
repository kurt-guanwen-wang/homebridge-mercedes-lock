import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { MBAuth2FAError, MercedesOAuth } from './oauth';
import {
  applicationName,
  applicationVersion,
  Region,
  RIS_OS_NAME,
  RIS_OS_VERSION,
  sdkVersion,
  websocketUrl,
  websocketUserAgent,
} from './constants';
import { decodePushMessageVehicleStatusUpdates } from './proto';
import { CarStatus, interpretCarStatus } from './vehicleStatus';

interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const PING_INTERVAL_MS = 25_000;
const INITIAL_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 120_000;
// Mercedes closes the websocket with code 1001 ("Going Away") on a
// regular server-side lifecycle timer (observed roughly every 15 min in
// practice) - this is expected/graceful, not an error. Wait a bit longer
// than the default reconnect delay before reconnecting so we don't
// immediately re-open a connection the server just intentionally closed.
const GOING_AWAY_RECONNECT_DELAY_MS = 10_000;
// Mercedes' backend rate-limits the websocket handshake (HTTP 429) if we
// reconnect too aggressively. The normal exponential backoff caps at
// MAX_RECONNECT_DELAY_MS (2 min), which is far too fast to ever let a 429
// clear - the plugin ends up hammering the endpoint every 2 minutes
// forever. Ported from mbapi2020's websocket.py: on a 429 it grows the
// retry delay quadratically (`retry_in = 10 * counter^2` seconds) rather
// than the flat doubling used for other errors, so repeated 429s back off
// far more aggressively. We cap it (mbapi2020's is unbounded) so a
// persistently blocked account still retries eventually instead of
// backing off forever.
const RATE_LIMIT_BACKOFF_BASE_MS = 10_000;
const RATE_LIMIT_MAX_RECONNECT_DELAY_MS = 2 * 60 * 60_000;
// Ported from mbapi2020's websocket.py (INITIATE_RELOGIN_AFTER_429 /
// MAX_RELOGIN_ATTEMPTS): a 429 on the websocket handshake often means the
// account's session/token got invalidated server-side, not just plain
// throttling - a full re-login (fresh PKCE flow, not just a token
// refresh) frequently clears it. Capped so a persistently blocked account
// doesn't hammer the login endpoint forever.
const MAX_RELOGIN_ATTEMPTS = 4;

/**
 * Maintains a persistent websocket connection to Mercedes' backend and
 * emits real-time CarStatus updates as they're pushed - the *only* channel
 * that reports lock/door/window status (the REST snapshot endpoint only
 * has fuel/range/position, see mbApi.ts). Ported from mbapi2020's
 * websocket.py, trimmed to the one push message type this plugin needs
 * (`vehicle_status_updates`); other message types (vepUpdate,
 * assigned_vehicles, debugMessage, etc.) are safely ignored.
 */
export class MercedesWebSocket {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  // Set while we're serving out a rate-limit backoff, so scheduleReconnect's
  // normal exponential growth (capped at MAX_RECONNECT_DELAY_MS) doesn't
  // shrink the delay back down below the quadratic 429 backoff.
  private rateLimited = false;
  private stopped = false;
  private reloginAttempts = 0;
  private reloginInFlight = false;
  // Consecutive 429s seen back-to-back (mbapi2020's ws_connect_retry_counter,
  // scoped to rate-limit events only); drives the quadratic backoff below
  // and resets on any successful connection.
  private rateLimitStreak = 0;
  // Listening for 'unexpected-response' suppresses ws's own automatic
  // abortHandshake() (see ws/lib/websocket.js), making us responsible for
  // closing the socket ourselves - our ws.terminate() call below then
  // synthesizes its own generic 'error' ("WebSocket was closed before the
  // connection was established") before 'close' fires. Set right before
  // that terminate() call so the 'error' handler can recognize it's just
  // an artifact of our own handling (already logged in detail as the 429
  // warning) rather than a second, confusing error.
  private suppressNextError = false;
  private readonly sessionId = randomUUID().toUpperCase();

  constructor(
    private readonly oauth: MercedesOAuth,
    private readonly region: Region,
    private readonly log: Logger,
    private readonly onStatus: (vin: string, status: CarStatus) => void,
  ) {}

  connect(): void {
    this.stopped = false;
    this.connectInternal().catch((err) => {
      this.log.warn('MercedesWebSocket: connect failed: %s', (err as Error).message);
      this.scheduleReconnect();
    });
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, 'Client shutdown');
    this.ws = null;
  }

  private async connectInternal(): Promise<void> {
    const token = await this.oauth.getAccessToken();
    const url = websocketUrl(this.region);

    const headers: Record<string, string> = {
      // Note: unlike REST calls, the websocket Authorization header is the
      // raw access token with no "Bearer " prefix (websocket.py
      // `_websocket_connection_headers`).
      Authorization: token,
      'APP-SESSION-ID': this.sessionId,
      'OUTPUT-FORMAT': 'PROTO',
      'X-SessionId': this.sessionId,
      'X-TrackingId': randomUUID().toUpperCase(),
      'ris-os-name': RIS_OS_NAME,
      'ris-os-version': RIS_OS_VERSION,
      'ris-sdk-version': sdkVersion(this.region),
      'X-Locale': this.region === 'North America' ? 'en-US' : 'de-DE',
      'User-Agent': websocketUserAgent(this.region),
      'X-ApplicationName': applicationName(this.region),
      'ris-application-version': applicationVersion(this.region),
    };

    // North America manually declares permessage-deflate rather than
    // letting the client negotiate it (app_version.py
    // `apply_websocket_headers`); other regions send neither header and
    // use an uncompressed connection. Mismatching this (e.g. leaving the
    // `ws` library's own auto-negotiation on, which sends its own
    // differently-shaped Sec-WebSocket-Extensions header) causes the
    // server to accept the handshake but close the connection immediately
    // afterwards with code 1000 and no data.
    if (this.region === 'North America') {
      headers['Accept-Encoding'] = 'gzip';
      headers['Sec-WebSocket-Extensions'] = 'permessage-deflate';
    }

    this.log.debug('MercedesWebSocket: connecting to %s', url);
    const ws = new WebSocket(url, {
      headers,
      perMessageDeflate: false,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.log.info('MercedesWebSocket: connected');
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.rateLimited = false;
      this.reloginAttempts = 0;
      this.rateLimitStreak = 0;
      this.startPing();
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        return;
      }
      this.handleMessage(data);
    });

    ws.on('close', (code, reason) => {
      this.log.debug('MercedesWebSocket: closed (%s) %s', code, reason?.toString() || '(empty)');
      this.clearTimers();
      if (!this.stopped) {
        if (code === 1001 && !this.rateLimited) {
          this.reconnectDelayMs = GOING_AWAY_RECONNECT_DELAY_MS;
        }
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      if (this.suppressNextError) {
        this.suppressNextError = false;
        this.log.debug('MercedesWebSocket: connection aborted after unexpected response: %s', err.message);
        return;
      }
      this.log.warn('MercedesWebSocket: error: %s', err.message);
    });

    ws.on('unexpected-response', (_req, res) => {
      this.suppressNextError = true;
      if (res.statusCode === 429) {
        this.rateLimitStreak += 1;
        const quadraticDelayMs = RATE_LIMIT_BACKOFF_BASE_MS * this.rateLimitStreak * this.rateLimitStreak;

        const retryAfterHeader = res.headers['retry-after'];
        const retryAfterSeconds = Array.isArray(retryAfterHeader)
          ? Number(retryAfterHeader[0])
          : Number(retryAfterHeader);
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;

        const delayMs = Math.min(Math.max(quadraticDelayMs, retryAfterMs), RATE_LIMIT_MAX_RECONNECT_DELAY_MS);
        this.log.warn(
          'MercedesWebSocket: rate limited (429, streak=%d), backing off for %ds',
          this.rateLimitStreak,
          Math.round(delayMs / 1000),
        );
        this.reconnectDelayMs = delayMs;
        this.rateLimited = true;
        this.attemptReloginAfterRateLimit();
      } else {
        // Handling 'unexpected-response' at all (even just for 429s above)
        // suppresses ws's own default abortHandshake(), so we must log
        // other unexpected statuses (401, 500, etc.) ourselves or that
        // diagnostic info is lost entirely.
        this.log.warn('MercedesWebSocket: unexpected server response: %d', res.statusCode);
      }
      res.resume();
      ws.terminate();
    });
  }

  /**
   * Ported from mbapi2020's websocket.py (`INITIATE_RELOGIN_AFTER_429`): a
   * 429 on the websocket handshake often means the account's session got
   * invalidated server-side, not just plain throttling, and a full
   * re-login (fresh PKCE flow) frequently clears it faster than waiting
   * out the backoff alone. Fire-and-forget - runs independently of the
   * reconnect timer, and whichever finishes first wins on the next
   * connect attempt since a successful login updates the shared token
   * cache used by getAccessToken().
   */
  private attemptReloginAfterRateLimit(): void {
    if (this.reloginInFlight) {
      this.log.debug('MercedesWebSocket: re-login already in progress, skipping this 429');
      return;
    }
    if (this.reloginAttempts >= MAX_RELOGIN_ATTEMPTS) {
      this.log.error(
        'MercedesWebSocket: re-login attempts exhausted (%d/%d), not retrying login - check credentials/2FA',
        this.reloginAttempts,
        MAX_RELOGIN_ATTEMPTS,
      );
      return;
    }
    this.reloginInFlight = true;
    this.reloginAttempts += 1;
    const attempt = this.reloginAttempts;
    this.log.info('MercedesWebSocket: 429 detected, attempting full re-login (%d/%d)', attempt, MAX_RELOGIN_ATTEMPTS);
    this.oauth
      .login()
      .then(() => {
        this.log.info('MercedesWebSocket: re-login after 429 succeeded');
        this.reloginAttempts = 0;
      })
      .catch((err) => {
        if (err instanceof MBAuth2FAError) {
          // Can't be resolved by an automated re-login; stop trying.
          this.log.error('MercedesWebSocket: re-login after 429 aborted, account requires 2FA: %s', err.message);
          this.reloginAttempts = MAX_RELOGIN_ATTEMPTS;
          return;
        }
        this.log.error(
          'MercedesWebSocket: re-login after 429 failed (%d/%d): %s',
          attempt,
          MAX_RELOGIN_ATTEMPTS,
          (err as Error).message,
        );
      })
      .finally(() => {
        this.reloginInFlight = false;
      });
  }

  private handleMessage(data: Buffer): void {
    let decoded;
    try {
      decoded = decodePushMessageVehicleStatusUpdates(data);
    } catch (err) {
      this.log.debug('MercedesWebSocket: failed to decode push message: %s', (err as Error).message);
      return;
    }
    if (!decoded) {
      return;
    }
    this.log.debug(
      'MercedesWebSocket: received status update for %d vehicle(s), seq=%s',
      decoded.vehicles.size,
      decoded.sequenceNumber,
    );
    for (const [vin, raw] of decoded.vehicles) {
      this.onStatus(vin, interpretCarStatus(raw));
    }
    this.sendAck(decoded.sequenceNumber);
  }

  /**
   * Acknowledges a vehicle_status_updates push (ClientMessage field 28,
   * AcknowledgeVehicleStatusUpdates{sequence_number}), matching
   * websocket.py/client.py's on_data handler. Hand-encoded (rather than
   * via a declared protobuf message) since it's just two small varints.
   */
  private sendAck(sequenceNumber: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const seq = BigInt(sequenceNumber);
    const inner = encodeVarintField(1, seq); // AcknowledgeVehicleStatusUpdates.sequence_number = 1
    const outer = encodeLengthDelimitedField(28, inner); // ClientMessage.acknowledge_vehicle_status_updates = 28
    this.ws.send(outer);
  }

  private startPing(): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.log.debug('MercedesWebSocket: reconnecting in %dms', this.reconnectDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
    if (!this.rateLimited) {
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  private clearTimers(): void {
    this.clearPingTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/** Encodes a single varint-value protobuf field (wiretype 0). */
function encodeVarintField(fieldNumber: number, value: bigint): Buffer {
  const tag = BigInt((fieldNumber << 3) | 0);
  return Buffer.concat([encodeVarint(tag), encodeVarint(value)]);
}

/** Wraps `payload` as a length-delimited protobuf field (wiretype 2). */
function encodeLengthDelimitedField(fieldNumber: number, payload: Buffer): Buffer {
  const tag = BigInt((fieldNumber << 3) | 2);
  return Buffer.concat([encodeVarint(tag), encodeVarint(BigInt(payload.length)), payload]);
}

function encodeVarint(value: bigint): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (v !== 0n);
  return Buffer.from(bytes);
}
