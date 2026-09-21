import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { MercedesOAuth } from './oauth';
import { TokenCache } from './tokenCache';
import { MercedesApi } from './mbApi';
import { LockStatusAccessory } from './lockAccessory';
import { Region } from './constants';

interface MercedesLockConfig extends PlatformConfig {
  username: string;
  password: string;
  region: Region;
  vin?: string;
  pollIntervalSeconds?: number;
}

export class MercedesLockPlatform implements DynamicPlatformPlugin {
  private readonly accessories: PlatformAccessory[] = [];
  private lockAccessory: LockStatusAccessory | null = null;
  private api2!: MercedesApi;
  private vin: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

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
      this.start().catch((err) => this.log.error('Startup failed: %s', (err as Error).message));
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    });
  }

  /** Called by Homebridge for every cached accessory restored from disk. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  private async start(): Promise<void> {
    const cfg = this.config as MercedesLockConfig;
    const region: Region = cfg.region ?? 'North America';
    const oauth = new MercedesOAuth(
      cfg.username,
      cfg.password,
      region,
      new TokenCache(this.api.user.storagePath(), this.hashAccount(cfg.username)),
      this.log,
    );
    this.api2 = new MercedesApi(oauth, region);

    this.vin = cfg.vin?.trim() || (await this.discoverVin());
    if (!this.vin) {
      this.log.error('No vehicles found on this Mercedes Me account.');
      return;
    }

    this.lockAccessory = this.setupAccessory(this.vin);

    const pollMs = Math.max(60, cfg.pollIntervalSeconds ?? 180) * 1000;
    await this.refresh();
    this.pollTimer = setInterval(() => {
      this.refresh().catch((err) => this.log.warn('Poll failed: %s', (err as Error).message));
    }, pollMs);
  }

  private async discoverVin(): Promise<string | null> {
    const vehicles = await this.api2.getVehicles();
    return vehicles[0]?.vin ?? null;
  }

  private setupAccessory(vin: string): LockStatusAccessory {
    const uuid = this.api.hap.uuid.generate(`mercedes-lock-${vin}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(`Car Door Lock (${vin.slice(-6)})`, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    return new LockStatusAccessory(this.api, accessory);
  }

  private async refresh(): Promise<void> {
    if (!this.vin || !this.lockAccessory) {
      return;
    }
    const reading = await this.api2.getDoorLockStatus(this.vin);
    this.lockAccessory.update(reading.value);
    this.log.debug('Door lock status raw value: %s (status=%s)', reading.value, reading.status);
  }

  private hashAccount(username: string): string {
    return Buffer.from(username).toString('base64url').slice(0, 24);
  }
}
