import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { MercedesOAuth } from './oauth';
import { TokenCache } from './tokenCache';
import { MercedesApi } from './mbApi';
import { MercedesWebSocket } from './websocket';
import { CarAccessory, CarAccessoryOptions } from './carAccessory';
import { CarStatus } from './vehicleStatus';
import { Region } from './constants';
import { createLogger, Logger } from './logger';

interface MercedesLockConfig extends PlatformConfig {
  username: string;
  password: string;
  region: Region;
  vin?: string;
  pollIntervalSeconds?: number;
  showLock?: boolean;
  showDoors?: boolean;
  showWindows?: boolean;
  showFuelBattery?: boolean;
  showEvBattery?: boolean;
  debug?: boolean;
}

export class MercedesLockPlatform implements DynamicPlatformPlugin {
  private static readonly START_RETRY_INITIAL_MS = 30_000; // 30s
  private static readonly START_RETRY_MAX_MS = 30 * 60_000; // 30min

  private readonly accessories: PlatformAccessory[] = [];
  private carAccessory: CarAccessory | null = null;
  private api2!: MercedesApi;
  private websocket: MercedesWebSocket | null = null;
  private vin: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private startRetryTimer: NodeJS.Timeout | null = null;
  private startRetryDelayMs = MercedesLockPlatform.START_RETRY_INITIAL_MS;
  private lastStatus: CarStatus | null = null;
  private debugLog!: Logger;

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    if (!this.config.username || !this.config.password) {
      this.log.error('MercedesLock: username/password not configured, plugin disabled.');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.startWithRetry();
    });

    this.api.on('shutdown', () => {
      if (this.startRetryTimer) {
        clearTimeout(this.startRetryTimer);
        this.startRetryTimer = null;
      }
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.websocket?.stop();
    });
  }

  /** Called by Homebridge for every cached accessory restored from disk. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  /**
   * Runs start(), retrying with a doubling backoff (30s -> 30min) if it
   * fails (e.g. the very first login attempt hits a transient network
   * error). Actual login attempts are separately throttled inside
   * MercedesOAuth, so retrying this wrapper more often never translates
   * into hammering Mercedes' login endpoint - it just re-checks whether
   * enough time has passed to try again.
   */
  private startWithRetry(): void {
    this.start()
      .then(() => {
        this.startRetryDelayMs = MercedesLockPlatform.START_RETRY_INITIAL_MS;
      })
      .catch((err) => {
        const delay = this.startRetryDelayMs;
        this.log.error('Startup failed, retrying in %ds: %s', Math.ceil(delay / 1000), (err as Error).message);
        this.startRetryTimer = setTimeout(() => {
          this.startRetryTimer = null;
          this.startWithRetry();
        }, delay);
        this.startRetryDelayMs = Math.min(delay * 2, MercedesLockPlatform.START_RETRY_MAX_MS);
      });
  }

  private async start(): Promise<void> {
    const cfg = this.config as MercedesLockConfig;
    const region: Region = cfg.region ?? 'North America';
    this.debugLog = createLogger(this.log, cfg.debug ?? false);
    if (cfg.debug) {
      this.log.info('MercedesLock: debug logging enabled via plugin config');
    }
    const oauth = new MercedesOAuth(
      cfg.username,
      cfg.password,
      region,
      new TokenCache(this.api.user.storagePath(), this.hashAccount(cfg.username), this.debugLog),
      this.debugLog,
    );
    this.api2 = new MercedesApi(oauth, region, this.debugLog);

    this.vin = cfg.vin?.trim() || (await this.discoverVin());
    if (!this.vin) {
      throw new Error('No vehicles found on this Mercedes Me account.');
    }
    this.debugLog.debug('MercedesLock: using VIN %s (region=%s)', this.vin, region);

    this.carAccessory = this.setupAccessory(this.vin, cfg);

    // Lock/door/window status is only ever delivered over the websocket
    // push channel (the REST snapshot below only has fuel/range/position),
    // so it's the primary, real-time data source.
    this.websocket = new MercedesWebSocket(oauth, region, this.debugLog, (vin, status) => {
      if (vin !== this.vin) {
        return;
      }
      this.applyStatus(status);
    });
    this.websocket.connect();

    // REST poll is a slower-cadence fallback/supplement, mainly useful for
    // fuel/EV level (and to re-populate state quickly after a Homebridge
    // restart, before the websocket reconnects). A failure here shouldn't
    // abort the rest of startup (the websocket above is already
    // connecting) - just log and let the poll timer's own retry cadence
    // pick it up.
    const pollMs = Math.max(60, cfg.pollIntervalSeconds ?? 180) * 1000;
    try {
      await this.refresh();
    } catch (err) {
      this.log.warn('Initial status refresh failed (will retry on next poll): %s', (err as Error).message);
    }
    this.debugLog.debug('MercedesLock: polling REST status every %ds', pollMs / 1000);
    this.pollTimer = setInterval(() => {
      this.refresh().catch((err) => this.log.warn('Poll failed: %s', (err as Error).message));
    }, pollMs);
  }

  private async discoverVin(): Promise<string | null> {
    const vehicles = await this.api2.getVehicles();
    return vehicles[0]?.vin ?? null;
  }

  private setupAccessory(vin: string, cfg: MercedesLockConfig): CarAccessory {
    const uuid = this.api.hap.uuid.generate(`mercedes-lock-${vin}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    const name = `Car ${vin.slice(-6)}`;

    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else if (accessory.displayName !== name) {
      // Self-heal accessories cached from an older plugin version that
      // used a HomeKit-invalid name (e.g. "Car (810963)" - parentheses
      // aren't allowed and trigger a HAP-NodeJS "invalid Name
      // characteristic" warning).
      accessory.displayName = name;
      const infoService = accessory.getService(this.api.hap.Service.AccessoryInformation);
      infoService?.updateCharacteristic(this.api.hap.Characteristic.Name, name);
    }

    const options: CarAccessoryOptions = {
      showLock: cfg.showLock ?? true,
      showDoors: cfg.showDoors ?? true,
      showWindows: cfg.showWindows ?? true,
      showFuelBattery: cfg.showFuelBattery ?? true,
      showEvBattery: cfg.showEvBattery ?? true,
    };

    return new CarAccessory(this.api, accessory, options);
  }

  private async refresh(): Promise<void> {
    if (!this.vin || !this.carAccessory) {
      return;
    }
    const status = await this.api2.getVehicleStatus(this.vin);
    // Don't let a REST poll (fuel/range only) clobber lock/door/window
    // values already learned from the websocket with nulls.
    this.applyStatus(status);
  }

  /** Merges a partial CarStatus update into the accessory, keeping any
   * previously-known field the new update doesn't report (null). */
  private applyStatus(status: CarStatus): void {
    if (!this.carAccessory) {
      return;
    }
    const merged: CarStatus = {
      lock: status.lock ?? this.lastStatus?.lock ?? null,
      doorsOpen: status.doorsOpen ?? this.lastStatus?.doorsOpen ?? null,
      windowsOpen: status.windowsOpen ?? this.lastStatus?.windowsOpen ?? null,
      fuelPercent: status.fuelPercent ?? this.lastStatus?.fuelPercent ?? null,
      evPercent: status.evPercent ?? this.lastStatus?.evPercent ?? null,
    };
    this.lastStatus = merged;
    this.carAccessory.update(merged);
    this.debugLog.debug('Vehicle status: %j', merged);
  }

  private hashAccount(username: string): string {
    return Buffer.from(username).toString('base64url').slice(0, 24);
  }
}
