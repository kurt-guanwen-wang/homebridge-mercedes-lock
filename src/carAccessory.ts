import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';
import { DoorLockStatusVehicle } from './constants';
import { CarStatus } from './vehicleStatus';

/**
 * A single HomeKit "device" for the car, exposing everything as separate
 * read-only services on one PlatformAccessory (matches how
 * seydx/homebridge-mercedesme grouped car.js's services under one
 * accessory): door lock, doors, windows, interior lights, and (if
 * applicable) fuel/EV battery level.
 *
 * All writable characteristics (LockTargetState, the lights' On) are
 * intentionally no-ops that snap back to the last known reading - this
 * plugin never sends commands to the car.
 */
export class CarAccessory {
  private readonly Characteristic: typeof Characteristic;
  private readonly lockService: Service;
  private readonly doorsService: Service;
  private readonly windowsService: Service;
  private readonly lightsService: Service;
  private fuelBatteryService: Service | null = null;
  private evBatteryService: Service | null = null;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
  ) {
    this.Characteristic = api.hap.Characteristic;
    const Service = api.hap.Service;

    this.lockService =
      this.accessory.getServiceById(Service.LockMechanism, 'lock') ??
      this.accessory.addService(Service.LockMechanism, 'Door Lock', 'lock');
    this.lockService.getCharacteristic(this.Characteristic.LockTargetState).onSet((value) => {
      const current = this.lockService.getCharacteristic(this.Characteristic.LockCurrentState).value ?? 0;
      setImmediate(() => this.lockService.updateCharacteristic(this.Characteristic.LockTargetState, current));
      void value;
    });

    this.doorsService =
      this.accessory.getServiceById(Service.ContactSensor, 'doors') ??
      this.accessory.addService(Service.ContactSensor, 'Doors', 'doors');

    this.windowsService =
      this.accessory.getServiceById(Service.ContactSensor, 'windows') ??
      this.accessory.addService(Service.ContactSensor, 'Windows', 'windows');

    this.lightsService =
      this.accessory.getServiceById(Service.Lightbulb, 'lights') ??
      this.accessory.addService(Service.Lightbulb, 'Interior Lights', 'lights');
    this.lightsService.getCharacteristic(this.Characteristic.On).onSet((value) => {
      const current = this.lightsService.getCharacteristic(this.Characteristic.On).value ?? false;
      setImmediate(() => this.lightsService.updateCharacteristic(this.Characteristic.On, current));
      void value;
    });
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

    if (status.doorsOpen !== null) {
      this.doorsService.updateCharacteristic(
        this.Characteristic.ContactSensorState,
        status.doorsOpen
          ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
    }

    if (status.windowsOpen !== null) {
      this.windowsService.updateCharacteristic(
        this.Characteristic.ContactSensorState,
        status.windowsOpen
          ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
    }

    if (status.lightsOn !== null) {
      this.lightsService.updateCharacteristic(this.Characteristic.On, status.lightsOn);
    }

    // Only add a battery service for whichever the car actually reports
    // (combustion cars report fuel only, EVs report SoC only, some hybrids
    // report both).
    if (status.fuelPercent !== null) {
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
    if (status.evPercent !== null) {
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
