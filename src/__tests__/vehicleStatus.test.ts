import { interpretCarStatus } from '../vehicleStatus';
import { RawReading, RawVehicleStatus } from '../proto';
import { DoorLockStatusVehicle, DoorStatusOverall, SunroofStatus, WindowStatusOverall } from '../constants';

function reading(value: number | null): RawReading {
  return { value };
}

function rawStatus(overrides: Partial<Record<keyof RawVehicleStatus, number | null>>): RawVehicleStatus {
  return {
    lock: reading(overrides.lock ?? null),
    doorStatusOverall: reading(overrides.doorStatusOverall ?? null),
    windowStatusOverall: reading(overrides.windowStatusOverall ?? null),
    sunroofstatus: reading(overrides.sunroofstatus ?? null),
    soc: reading(overrides.soc ?? null),
    tanklevelpercent: reading(overrides.tanklevelpercent ?? null),
  };
}

describe('interpretCarStatus', () => {
  it('maps a fully-reported combustion car (locked, closed, no EV)', () => {
    const status = interpretCarStatus(
      rawStatus({
        lock: DoorLockStatusVehicle.EXTERNAL_LOCKED,
        doorStatusOverall: DoorStatusOverall.ALL_DOORS_CLOSED,
        windowStatusOverall: WindowStatusOverall.CLOSED,
        sunroofstatus: SunroofStatus.CLOSED,
        tanklevelpercent: 69,
      }),
    );

    expect(status).toEqual({
      lock: DoorLockStatusVehicle.EXTERNAL_LOCKED,
      doorsOpen: false,
      windowsOpen: false,
      fuelPercent: 69,
      evPercent: null,
    });
  });

  it('reports doorsOpen true when door_status_overall is ANY_DOOR_OPEN', () => {
    const status = interpretCarStatus(rawStatus({ doorStatusOverall: DoorStatusOverall.ANY_DOOR_OPEN }));
    expect(status.doorsOpen).toBe(true);
  });

  it('reports windowsOpen true if the sunroof is open even when windows are closed', () => {
    const status = interpretCarStatus(
      rawStatus({
        windowStatusOverall: WindowStatusOverall.CLOSED,
        sunroofstatus: SunroofStatus.LIFTING_OPEN,
      }),
    );
    expect(status.windowsOpen).toBe(true);
  });

  it('reports windowsOpen true for non-CLOSED window states (open/completely-open/airing)', () => {
    expect(interpretCarStatus(rawStatus({ windowStatusOverall: WindowStatusOverall.OPEN })).windowsOpen).toBe(true);
    expect(
      interpretCarStatus(rawStatus({ windowStatusOverall: WindowStatusOverall.COMPLETELY_OPEN })).windowsOpen,
    ).toBe(true);
    expect(interpretCarStatus(rawStatus({ windowStatusOverall: WindowStatusOverall.AIRING })).windowsOpen).toBe(true);
  });

  it('returns windowsOpen null when both windows and sunroof are unreported', () => {
    const status = interpretCarStatus(rawStatus({}));
    expect(status.windowsOpen).toBeNull();
  });

  it('maps UNLOCKED and SELECTIVE_UNLOCKED as distinct (non-locked) lock values', () => {
    expect(interpretCarStatus(rawStatus({ lock: DoorLockStatusVehicle.UNLOCKED })).lock).toBe(
      DoorLockStatusVehicle.UNLOCKED,
    );
    expect(interpretCarStatus(rawStatus({ lock: DoorLockStatusVehicle.SELECTIVE_UNLOCKED })).lock).toBe(
      DoorLockStatusVehicle.SELECTIVE_UNLOCKED,
    );
  });

  it('reports evPercent for an EV with no fuel level', () => {
    const status = interpretCarStatus(rawStatus({ soc: 80 }));
    expect(status.evPercent).toBe(80);
    expect(status.fuelPercent).toBeNull();
  });

  it('returns all-null when nothing is reported', () => {
    const status = interpretCarStatus(rawStatus({}));
    expect(status).toEqual({
      lock: null,
      doorsOpen: null,
      windowsOpen: null,
      fuelPercent: null,
      evPercent: null,
    });
  });
});
