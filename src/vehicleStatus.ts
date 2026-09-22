import { DoorLockStatusVehicle, DoorStatusOverall, SunroofStatus, WindowStatusOverall } from './constants';
import { RawVehicleStatus } from './proto';

/**
 * A single vehicle "snapshot" derived from a decoded VehicleStatusUpdate,
 * using the same per-attribute semantics ReneNulschDE/mbapi2020's lock.py
 * applies. Any field is `null` when the car didn't report that attribute
 * (e.g. no EV battery on a combustion vehicle) or reported it as
 * INVALID/NOT_AVAILABLE.
 */
export interface CarStatus {
  lock: DoorLockStatusVehicle | null;
  /** true if any door or the trunk/decklid is open. */
  doorsOpen: boolean | null;
  /** true if any window or the sunroof is open/not fully closed. */
  windowsOpen: boolean | null;
  /** Fuel tank level, 0-100. Present on combustion/hybrid vehicles. */
  fuelPercent: number | null;
  /** EV state of charge, 0-100. Present on EV/hybrid vehicles. */
  evPercent: number | null;
}

export function interpretCarStatus(raw: RawVehicleStatus): CarStatus {
  const lock = raw.lock.value === null ? null : (raw.lock.value as DoorLockStatusVehicle);

  const doorsOpen =
    raw.doorStatusOverall.value === null ? null : raw.doorStatusOverall.value === DoorStatusOverall.ANY_DOOR_OPEN;

  const windowOverall = raw.windowStatusOverall.value;
  const windowsOpenFromWindows = windowOverall === null ? null : windowOverall !== WindowStatusOverall.CLOSED;
  const sunroof = raw.sunroofstatus.value;
  const sunroofOpen = sunroof === null ? null : sunroof !== SunroofStatus.CLOSED;
  const windowsOpen =
    windowsOpenFromWindows === null && sunroofOpen === null
      ? null
      : Boolean(windowsOpenFromWindows) || Boolean(sunroofOpen);

  const fuelPercent = raw.tanklevelpercent.value;
  const evPercent = raw.soc.value;

  return { lock, doorsOpen, windowsOpen, fuelPercent, evPercent };
}
