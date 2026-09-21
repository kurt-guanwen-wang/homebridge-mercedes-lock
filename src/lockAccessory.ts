import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';
import { DoorLockStatusVehicle } from './constants';

/**
 * Exposes a single vehicle's door lock status as a read-only HomeKit
 * LockMechanism. Only `LockCurrentState` is writable by us (via
 * updateCharacteristic); `LockTargetState`'s SET handler is intentionally
 * a no-op that snaps back to the current state, so tapping the padlock in
 * the Home app never sends a command to the car.
 */
export class LockStatusAccessory {
  private readonly service: Service;
  private readonly Characteristic: typeof Characteristic;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
  ) {
    this.Characteristic = api.hap.Characteristic;
    const Service = api.hap.Service;

    this.service =
      this.accessory.getService(Service.LockMechanism) ?? this.accessory.addService(Service.LockMechanism);

    this.service
      .getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(() => this.service.getCharacteristic(this.Characteristic.LockCurrentState).value ?? 0)
      .onSet((value) => {
        // Read-only accessory: ignore the request and immediately report
        // back the real (unchanged) state so the Home app UI reverts.
        const current = this.service.getCharacteristic(this.Characteristic.LockCurrentState).value ?? 0;
        setImmediate(() => this.service.updateCharacteristic(this.Characteristic.LockTargetState, current));
        void value;
      });

    this.service.getCharacteristic(this.Characteristic.LockCurrentState).onGet(() => {
      return this.service.getCharacteristic(this.Characteristic.LockCurrentState).value ?? 0;
    });
  }

  /** Push a fresh reading from the car into HomeKit. */
  update(status: DoorLockStatusVehicle | null): void {
    const locked = status === DoorLockStatusVehicle.INTERNAL_LOCKED || status === DoorLockStatusVehicle.EXTERNAL_LOCKED;
    const unknown = status === null;

    const currentState = unknown
      ? this.Characteristic.LockCurrentState.UNKNOWN
      : locked
        ? this.Characteristic.LockCurrentState.SECURED
        : this.Characteristic.LockCurrentState.UNSECURED;

    this.service.updateCharacteristic(this.Characteristic.LockCurrentState, currentState);
    this.service.updateCharacteristic(
      this.Characteristic.LockTargetState,
      locked ? this.Characteristic.LockTargetState.SECURED : this.Characteristic.LockTargetState.UNSECURED,
    );
  }
}
