import type { API } from 'homebridge';
import * as hap from 'hap-nodejs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');
import { CarAccessory, CarAccessoryOptions } from '../carAccessory';
import { DoorLockStatusVehicle } from '../constants';
import { CarStatus } from '../vehicleStatus';

/** Minimal fake of the Homebridge `API` object: only `hap.Service`/`hap.Characteristic`
 * are used by CarAccessory, so we wire those to the real hap-nodejs implementations
 * (available as a transitive dependency of `homebridge`) for realistic behavior. */
const fakeApi = { hap: { Service: hap.Service, Characteristic: hap.Characteristic } } as unknown as API;

function newAccessory(): InstanceType<typeof PlatformAccessory> {
  const uuid = hap.uuid.generate(`test-${Math.random()}`);
  return new PlatformAccessory('Test Car', uuid);
}

const ALL_ENABLED: CarAccessoryOptions = {
  showLock: true,
  showDoors: true,
  showWindows: true,
  showFuelBattery: true,
  showEvBattery: true,
};

const emptyStatus: CarStatus = {
  lock: null,
  doorsOpen: null,
  windowsOpen: null,
  fuelPercent: null,
  evPercent: null,
};

describe('CarAccessory', () => {
  it('creates lock/doors/windows services when all options are enabled', () => {
    const accessory = newAccessory();
    new CarAccessory(fakeApi, accessory, ALL_ENABLED);

    expect(accessory.getServiceById(hap.Service.LockMechanism, 'lock')).toBeTruthy();
    expect(accessory.getServiceById(hap.Service.ContactSensor, 'doors')).toBeTruthy();
    expect(accessory.getServiceById(hap.Service.ContactSensor, 'windows')).toBeTruthy();
  });

  it('does not create disabled services, and removes previously-cached ones', () => {
    const accessory = newAccessory();
    // Simulate a service left over from a previous run with showDoors: true.
    accessory.addService(hap.Service.ContactSensor, 'Doors', 'doors');
    expect(accessory.getServiceById(hap.Service.ContactSensor, 'doors')).toBeTruthy();

    new CarAccessory(fakeApi, accessory, { ...ALL_ENABLED, showDoors: false });

    expect(accessory.getServiceById(hap.Service.ContactSensor, 'doors')).toBeFalsy();
  });

  it('always removes any leftover Lightbulb service (interior lights was removed as a feature)', () => {
    const accessory = newAccessory();
    accessory.addService(hap.Service.Lightbulb, 'Interior Lights', 'lights');

    new CarAccessory(fakeApi, accessory, ALL_ENABLED);

    expect(accessory.getServiceById(hap.Service.Lightbulb, 'lights')).toBeFalsy();
  });

  it('reflects EXTERNAL_LOCKED/INTERNAL_LOCKED as SECURED, others as UNSECURED', () => {
    const accessory = newAccessory();
    const carAccessory = new CarAccessory(fakeApi, accessory, ALL_ENABLED);
    const lockService = accessory.getServiceById(hap.Service.LockMechanism, 'lock')!;

    carAccessory.update({ ...emptyStatus, lock: DoorLockStatusVehicle.EXTERNAL_LOCKED });
    expect(lockService.getCharacteristic(hap.Characteristic.LockCurrentState).value).toBe(
      hap.Characteristic.LockCurrentState.SECURED,
    );

    carAccessory.update({ ...emptyStatus, lock: DoorLockStatusVehicle.UNLOCKED });
    expect(lockService.getCharacteristic(hap.Characteristic.LockCurrentState).value).toBe(
      hap.Characteristic.LockCurrentState.UNSECURED,
    );
  });

  it('reflects lock === null as LockCurrentState.UNKNOWN', () => {
    const accessory = newAccessory();
    const carAccessory = new CarAccessory(fakeApi, accessory, ALL_ENABLED);
    const lockService = accessory.getServiceById(hap.Service.LockMechanism, 'lock')!;

    carAccessory.update({ ...emptyStatus, lock: null });
    expect(lockService.getCharacteristic(hap.Characteristic.LockCurrentState).value).toBe(
      hap.Characteristic.LockCurrentState.UNKNOWN,
    );
  });

  it('only creates a fuel/EV battery service once the car actually reports that value', () => {
    const accessory = newAccessory();
    const carAccessory = new CarAccessory(fakeApi, accessory, ALL_ENABLED);

    expect(accessory.getServiceById(hap.Service.Battery, 'fuel-battery')).toBeFalsy();

    carAccessory.update({ ...emptyStatus, fuelPercent: 42 });

    const fuelService = accessory.getServiceById(hap.Service.Battery, 'fuel-battery');
    expect(fuelService).toBeTruthy();
    expect(fuelService!.getCharacteristic(hap.Characteristic.BatteryLevel).value).toBe(42);
  });

  it('never creates a fuel/EV battery service when disabled in config', () => {
    const accessory = newAccessory();
    const carAccessory = new CarAccessory(fakeApi, accessory, {
      ...ALL_ENABLED,
      showFuelBattery: false,
      showEvBattery: false,
    });

    carAccessory.update({ ...emptyStatus, fuelPercent: 42, evPercent: 88 });

    expect(accessory.getServiceById(hap.Service.Battery, 'fuel-battery')).toBeFalsy();
    expect(accessory.getServiceById(hap.Service.Battery, 'ev-battery')).toBeFalsy();
  });

  it('flags StatusLowBattery when fuel/EV level is at or below 15%', () => {
    const accessory = newAccessory();
    const carAccessory = new CarAccessory(fakeApi, accessory, ALL_ENABLED);

    carAccessory.update({ ...emptyStatus, fuelPercent: 15 });
    const fuelService = accessory.getServiceById(hap.Service.Battery, 'fuel-battery')!;
    expect(fuelService.getCharacteristic(hap.Characteristic.StatusLowBattery).value).toBe(
      hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );

    carAccessory.update({ ...emptyStatus, fuelPercent: 16 });
    expect(fuelService.getCharacteristic(hap.Characteristic.StatusLowBattery).value).toBe(
      hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  });

  it('does not touch doors/windows contact sensors when the reading is null', () => {
    const accessory = newAccessory();
    const carAccessory = new CarAccessory(fakeApi, accessory, ALL_ENABLED);
    const doorsService = accessory.getServiceById(hap.Service.ContactSensor, 'doors')!;
    const before = doorsService.getCharacteristic(hap.Characteristic.ContactSensorState).value;

    carAccessory.update({ ...emptyStatus, doorsOpen: null });

    expect(doorsService.getCharacteristic(hap.Characteristic.ContactSensorState).value).toBe(before);
  });
});
