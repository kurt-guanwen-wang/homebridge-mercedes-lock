import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { MercedesOAuth } from './oauth';
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
  private stopped = false;
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
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.log.warn('MercedesWebSocket: error: %s', err.message);
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
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
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
