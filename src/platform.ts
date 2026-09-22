import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { MercedesOAuth } from './oauth';
import { TokenCache } from './tokenCache';
import { MercedesApi } from './mbApi';
import { CarAccessory, CarAccessoryOptions } from './carAccessory';
import { Region } from './constants';

interface MercedesLockConfig extends PlatformConfig {
  username: string;
  password: string;
  region: Region;
  vin?: string;
  pollIntervalSeconds?: number;
  showLock?: boolean;
  showDoors?: boolean;
  showWindows?: boolean;
  showLights?: boolean;
  showFuelBattery?: boolean;
  showEvBattery?: boolean;
}

export class MercedesLockPlatform implements DynamicPlatformPlugin {
  private readonly accessories: PlatformAccessory[] = [];
  private carAccessory: CarAccessory | null = null;
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

    this.carAccessory = this.setupAccessory(this.vin, cfg);

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

  private setupAccessory(vin: string, cfg: MercedesLockConfig): CarAccessory {
    const uuid = this.api.hap.uuid.generate(`mercedes-lock-${vin}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(`Car (${vin.slice(-6)})`, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    const options: CarAccessoryOptions = {
      showLock: cfg.showLock ?? true,
      showDoors: cfg.showDoors ?? true,
      showWindows: cfg.showWindows ?? true,
      showLights: cfg.showLights ?? true,
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
    this.carAccessory.update(status);
    this.log.debug('Vehicle status: %j', status);
  }

  private hashAccount(username: string): string {
    return Buffer.from(username).toString('base64url').slice(0, 24);
  }
}
