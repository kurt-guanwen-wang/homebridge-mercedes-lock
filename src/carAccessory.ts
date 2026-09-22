import type { API, Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { DoorLockStatusVehicle } from './constants';
import { CarStatus } from './vehicleStatus';

/** Per-service on/off switches, wired to config.schema.json's `show*` toggles. */
export interface CarAccessoryOptions {
  showLock: boolean;
  showDoors: boolean;
  showWindows: boolean;
  showFuelBattery: boolean;
  showEvBattery: boolean;
}

/**
 * A single HomeKit "device" for the car, exposing everything as separate
 * read-only services on one PlatformAccessory (matches how
 * seydx/homebridge-mercedesme grouped car.js's services under one
 * accessory): door lock, doors, windows, and (if applicable) fuel/EV
 * battery level. Each service is independently toggleable via
 * `CarAccessoryOptions`; disabled services are removed from the accessory
 * (including previously cached ones) so they don't linger.
 *
 * All writable characteristics (LockTargetState) are intentionally no-ops
 * that snap back to the last known reading - this plugin never sends
 * commands to the car.
 */
export class CarAccessory {
  private readonly Characteristic: typeof Characteristic;
  private lockService: Service | null = null;
  private doorsService: Service | null = null;
  private windowsService: Service | null = null;
  private fuelBatteryService: Service | null = null;
  private evBatteryService: Service | null = null;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
    private readonly options: CarAccessoryOptions,
  ) {
    this.Characteristic = api.hap.Characteristic;
    const Service = api.hap.Service;

    if (options.showLock) {
      this.lockService =
        this.accessory.getServiceById(Service.LockMechanism, 'lock') ??
        this.accessory.addService(Service.LockMechanism, 'Door Lock', 'lock');
      this.lockService.getCharacteristic(this.Characteristic.LockTargetState).onSet((value) => {
        const service = this.lockService!;
        const current = service.getCharacteristic(this.Characteristic.LockCurrentState).value ?? 0;
        setImmediate(() => service.updateCharacteristic(this.Characteristic.LockTargetState, current));
        void value;
      });
    } else {
      this.removeServiceById(Service.LockMechanism, 'lock');
    }

    if (options.showDoors) {
      this.doorsService =
        this.accessory.getServiceById(Service.ContactSensor, 'doors') ??
        this.accessory.addService(Service.ContactSensor, 'Doors', 'doors');
    } else {
      this.removeServiceById(Service.ContactSensor, 'doors');
    }

    if (options.showWindows) {
      this.windowsService =
        this.accessory.getServiceById(Service.ContactSensor, 'windows') ??
        this.accessory.addService(Service.ContactSensor, 'Windows', 'windows');
    } else {
      this.removeServiceById(Service.ContactSensor, 'windows');
    }

    this.removeServiceById(Service.Lightbulb, 'lights');

    if (!options.showFuelBattery) {
      this.removeServiceById(Service.Battery, 'fuel-battery');
    }
    if (!options.showEvBattery) {
      this.removeServiceById(Service.Battery, 'ev-battery');
    }
  }

  private removeServiceById(serviceType: WithUUID<typeof Service>, subtype: string): void {
    const existing = this.accessory.getServiceById(serviceType, subtype);
    if (existing) {
      this.accessory.removeService(existing);
    }
  }

  /** Returns the fuel/EV battery service for `subtype`, creating it on first use. */
  private getOrAddBattery(subtype: 'fuel-battery' | 'ev-battery', name: string): Service {
    const Service = this.api.hap.Service;
    const existing = subtype === 'fuel-battery' ? this.fuelBatteryService : this.evBatteryService;
    if (existing) {
      return existing;
    }
    const service =
      this.accessory.getServiceById(Service.Battery, subtype) ??
      this.accessory.addService(Service.Battery, name, subtype);
    if (subtype === 'fuel-battery') {
      this.fuelBatteryService = service;
    } else {
      this.evBatteryService = service;
    }
    return service;
  }

  /** Push a fresh reading from the car into HomeKit. */
  update(status: CarStatus): void {
    if (this.lockService) {
      const locked =
        status.lock === DoorLockStatusVehicle.INTERNAL_LOCKED || status.lock === DoorLockStatusVehicle.EXTERNAL_LOCKED;
      const lockUnknown = status.lock === null;
      const currentLockState = lockUnknown
        ? this.Characteristic.LockCurrentState.UNKNOWN
        : locked
          ? this.Characteristic.LockCurrentState.SECURED
          : this.Characteristic.LockCurrentState.UNSECURED;
      this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, currentLockState);
      this.lockService.updateCharacteristic(
        this.Characteristic.LockTargetState,
        locked ? this.Characteristic.LockTargetState.SECURED : this.Characteristic.LockTargetState.UNSECURED,
      );
    }

    if (this.doorsService && status.doorsOpen !== null) {
      this.doorsService.updateCharacteristic(
        this.Characteristic.ContactSensorState,
        status.doorsOpen
          ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
    }

    if (this.windowsService && status.windowsOpen !== null) {
      this.windowsService.updateCharacteristic(
        this.Characteristic.ContactSensorState,
        status.windowsOpen
          ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
    }

    // Only add a battery service for whichever the car actually reports
    // (combustion cars report fuel only, EVs report SoC only, some hybrids
    // report both), and only if that service is enabled in config.
    if (this.options.showFuelBattery && status.fuelPercent !== null) {
      const service = this.getOrAddBattery('fuel-battery', 'Fuel Level');
      service.updateCharacteristic(this.Characteristic.BatteryLevel, status.fuelPercent);
      service.updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        status.fuelPercent <= 15
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
      service.updateCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGEABLE);
    }
    if (this.options.showEvBattery && status.evPercent !== null) {
      const service = this.getOrAddBattery('ev-battery', 'EV Charge');
      service.updateCharacteristic(this.Characteristic.BatteryLevel, status.evPercent);
      service.updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        status.evPercent <= 15
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
      service.updateCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGEABLE);
    }
  }
}
