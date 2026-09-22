import * as protobuf from 'protobufjs';
import { decodeVehicleStatusUpdate, decodePushMessageVehicleStatusUpdates } from '../proto';
import { VSU_FIELD } from '../constants';

/**
 * Independent encoder-only schema (mirrors the real wire format
 * VehicleStatusUpdate/PushMessage) used purely to build test fixtures, so
 * these tests exercise proto.ts's decode logic against genuine protobuf
 * wire bytes rather than against its own internal schema string.
 */
const ENCODER_PROTO = `
syntax = "proto3";
package test;

message VSUMetadata {
  int32 status = 2;
}
message EnumAttribute {
  int32 value = 1;
  VSUMetadata metadata = 2;
}
message RatioAttribute {
  int64 value = 1;
  VSUMetadata metadata = 2;
}
message VehicleStatusUpdate {
  string fin_or_vin = 1;
  EnumAttribute doorlockstatusvehicle = ${VSU_FIELD.doorlockstatusvehicle};
  EnumAttribute door_status_overall = ${VSU_FIELD.doorStatusOverall};
  EnumAttribute window_status_overall = ${VSU_FIELD.windowStatusOverall};
  EnumAttribute sunroofstatus = ${VSU_FIELD.sunroofstatus};
  RatioAttribute soc = ${VSU_FIELD.soc};
  RatioAttribute tanklevelpercent = ${VSU_FIELD.tanklevelpercent};
}
message VehicleStatusUpdatesEntry {
  string key = 1;
  VehicleStatusUpdate value = 2;
}
message VehicleStatusUpdates {
  int64 sequence_number = 1;
  repeated VehicleStatusUpdatesEntry vehicle_status_updates = 2;
}
message PushMessage {
  VehicleStatusUpdates vehicle_status_updates = 24;
}
message OtherPushMessage {
  string debug_message = 1;
}
`;

const encoderRoot = protobuf.parse(ENCODER_PROTO).root;

function encodeVehicleStatusUpdate(fields: Record<string, unknown>): Buffer {
  const Type = encoderRoot.lookupType('test.VehicleStatusUpdate');
  const message = Type.create(fields);
  return Buffer.from(Type.encode(message).finish());
}

function validEnum(value: number) {
  return { value, metadata: { status: 0 } };
}
function invalidEnum(status: number) {
  return { metadata: { status } };
}
function validRatio(value: number) {
  return { value, metadata: { status: 0 } };
}

describe('decodeVehicleStatusUpdate', () => {
  it('decodes valid enum/ratio fields', () => {
    const buffer = encodeVehicleStatusUpdate({
      finOrVin: 'TESTVIN0000000001',
      doorlockstatusvehicle: validEnum(2),
      doorStatusOverall: validEnum(1),
      windowStatusOverall: validEnum(1),
      sunroofstatus: validEnum(0),
      soc: validRatio(80),
      tanklevelpercent: validRatio(55),
    });

    const status = decodeVehicleStatusUpdate(buffer);

    expect(status.lock.value).toBe(2);
    expect(status.doorStatusOverall.value).toBe(1);
    expect(status.windowStatusOverall.value).toBe(1);
    expect(status.sunroofstatus.value).toBe(0);
    expect(status.soc.value).toBe(80);
    expect(status.tanklevelpercent.value).toBe(55);
  });

  it('treats NOT_AVAILABLE/INVALID metadata status as null', () => {
    const buffer = encodeVehicleStatusUpdate({
      soc: invalidEnum(4), // NOT_AVAILABLE
      tanklevelpercent: invalidEnum(3), // INVALID
    });

    const status = decodeVehicleStatusUpdate(buffer);

    expect(status.soc.value).toBeNull();
    expect(status.tanklevelpercent.value).toBeNull();
  });

  it('returns null for entirely missing fields', () => {
    const buffer = encodeVehicleStatusUpdate({ finOrVin: 'TESTVIN0000000001' });
    const status = decodeVehicleStatusUpdate(buffer);

    expect(status.lock.value).toBeNull();
    expect(status.doorStatusOverall.value).toBeNull();
    expect(status.windowStatusOverall.value).toBeNull();
    expect(status.sunroofstatus.value).toBeNull();
    expect(status.soc.value).toBeNull();
    expect(status.tanklevelpercent.value).toBeNull();
  });

  it('handles int64 ratio values larger than 32 bits without truncation', () => {
    const buffer = encodeVehicleStatusUpdate({
      tanklevelpercent: validRatio(4_000_000_000),
    });
    const status = decodeVehicleStatusUpdate(buffer);
    expect(status.tanklevelpercent.value).toBe(4_000_000_000);
  });
});

describe('decodePushMessageVehicleStatusUpdates', () => {
  function encodePushMessage(sequenceNumber: number, entries: Array<{ key: string; value: Record<string, unknown> }>) {
    const VehicleStatusUpdate = encoderRoot.lookupType('test.VehicleStatusUpdate');
    const PushMessage = encoderRoot.lookupType('test.PushMessage');
    const message = PushMessage.create({
      vehicleStatusUpdates: {
        sequenceNumber,
        vehicleStatusUpdates: entries.map((e) => ({
          key: e.key,
          value: VehicleStatusUpdate.create(e.value),
        })),
      },
    });
    return Buffer.from(PushMessage.encode(message).finish());
  }

  it('decodes a single-vehicle push with sequence number', () => {
    const buffer = encodePushMessage(42, [
      { key: 'TESTVIN0000000001', value: { doorlockstatusvehicle: validEnum(1) } },
    ]);

    const decoded = decodePushMessageVehicleStatusUpdates(buffer);

    expect(decoded).not.toBeNull();
    expect(decoded!.sequenceNumber).toBe('42');
    expect(decoded!.vehicles.size).toBe(1);
    expect(decoded!.vehicles.get('TESTVIN0000000001')?.lock.value).toBe(1);
  });

  it('decodes multiple vehicles in one push', () => {
    const buffer = encodePushMessage(1, [
      { key: 'VIN_A', value: { tanklevelpercent: validRatio(10) } },
      { key: 'VIN_B', value: { tanklevelpercent: validRatio(90) } },
    ]);

    const decoded = decodePushMessageVehicleStatusUpdates(buffer);

    expect(decoded!.vehicles.get('VIN_A')?.tanklevelpercent.value).toBe(10);
    expect(decoded!.vehicles.get('VIN_B')?.tanklevelpercent.value).toBe(90);
  });

  it('returns null for a push message of a type this plugin does not care about', () => {
    const OtherPushMessage = encoderRoot.lookupType('test.OtherPushMessage');
    const message = OtherPushMessage.create({ debugMessage: 'hello' });
    const buffer = Buffer.from(OtherPushMessage.encode(message).finish());

    // Decoding an unrelated message type as PushMessage: field 1 (string)
    // doesn't collide with field 24, so vehicle_status_updates is absent.
    const decoded = decodePushMessageVehicleStatusUpdates(buffer);
    expect(decoded).toBeNull();
  });
});
