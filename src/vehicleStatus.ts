import {
  DOOR_LOCK_ATTRIBUTE_KEY,
  DOOR_STATUS_ATTRIBUTE_KEYS,
  DoorLockStatusVehicle,
  DoorStatus,
  EV_SOC_ATTRIBUTE_KEY,
  FUEL_LEVEL_ATTRIBUTE_KEY,
  INTERIOR_LIGHT_ATTRIBUTE_KEYS,
  SUNROOF_STATUS_ATTRIBUTE_KEY,
  SunroofStatus,
  WINDOW_STATUS_ATTRIBUTE_KEYS,
  WindowStatus,
} from './constants';
import { AttributeReading } from './proto';

/**
 * A single vehicle "snapshot" derived from the raw attribute map, using the
 * same per-attribute semantics ReneNulschDE/mbapi2020's binary_sensor.py /
 * lock.py and seydx/homebridge-mercedesme's accessory.js apply. Any field is
 * `null` when the car didn't report that attribute (e.g. no EV battery on a
 * combustion vehicle) or reported it as INVALID/NOT_AVAILABLE.
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
  /** true if any interior light is on. */
  lightsOn: boolean | null;
}

function numberValue(attrs: Record<string, AttributeReading>, key: string): number | null {
  const v = attrs[key]?.value;
  return typeof v === 'number' ? v : null;
}

function boolValue(attrs: Record<string, AttributeReading>, key: string): boolean | null {
  const v = attrs[key]?.value;
  return typeof v === 'boolean' ? v : null;
}

/** true if `some` returns true for the given keys, false if all are closed, null if none present. */
function anyOpen<T extends readonly string[]>(
  attrs: Record<string, AttributeReading>,
  keys: T,
  isOpen: (value: number) => boolean,
): boolean | null {
  const values = keys.map((k) => numberValue(attrs, k)).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return null;
  }
  return values.some(isOpen);
}

export function interpretCarStatus(attrs: Record<string, AttributeReading>): CarStatus {
  const lockRaw = numberValue(attrs, DOOR_LOCK_ATTRIBUTE_KEY);
  const lock = lockRaw === null ? null : (lockRaw as DoorLockStatusVehicle);

  const doorsOpen = anyOpen(attrs, DOOR_STATUS_ATTRIBUTE_KEYS, (v) => v === DoorStatus.OPEN);

  const windowsAnyOpen = anyOpen(attrs, WINDOW_STATUS_ATTRIBUTE_KEYS, (v) => v !== WindowStatus.COMPLETELY_CLOSED);
  const sunroof = numberValue(attrs, SUNROOF_STATUS_ATTRIBUTE_KEY);
  const sunroofOpen = sunroof === null ? null : sunroof !== SunroofStatus.CLOSED;
  const windowsOpen =
    windowsAnyOpen === null && sunroofOpen === null ? null : Boolean(windowsAnyOpen) || Boolean(sunroofOpen);

  const fuelPercent = numberValue(attrs, FUEL_LEVEL_ATTRIBUTE_KEY);
  const evPercent = numberValue(attrs, EV_SOC_ATTRIBUTE_KEY);

  const lightValues = INTERIOR_LIGHT_ATTRIBUTE_KEYS.map((k) => boolValue(attrs, k)).filter(
    (v): v is boolean => v !== null,
  );
  const lightsOn = lightValues.length ? lightValues.some((v) => v) : null;

  return { lock, doorsOpen, windowsOpen, fuelPercent, evPercent, lightsOn };
}
