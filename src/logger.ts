/** Minimal logger shape shared by oauth.ts/mbApi.ts/websocket.ts/tokenCache.ts. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/**
 * Wraps a Homebridge Logging instance so that, when `debugEnabled` is true,
 * `debug()` calls are emitted as regular (always-visible) log lines instead
 * of being silently dropped unless Homebridge's own global/child-bridge
 * debug mode is on. This lets the plugin's own config toggle
 * (`config.schema.json`'s `debug` option) reliably surface diagnostics
 * without depending on Homebridge UI features that may not be available
 * in every install (e.g. older Homebridge core versions).
 */
export function createLogger(log: Logger, debugEnabled: boolean): Logger {
  if (!debugEnabled) {
    return log;
  }
  return {
    debug: (msg: string, ...args: unknown[]) => log.info(`[debug] ${msg}`, ...args),
    info: (msg: string, ...args: unknown[]) => log.info(msg, ...args),
    warn: (msg: string, ...args: unknown[]) => log.warn(msg, ...args),
    error: (msg: string, ...args: unknown[]) => log.error(msg, ...args),
  };
}
