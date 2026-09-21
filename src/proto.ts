import * as protobuf from 'protobufjs';
import { DOOR_LOCK_ATTRIBUTE_KEY } from './constants';

/**
 * Minimal subset of mbapi2020's vehicle-events.proto (package `proto`),
 * field numbers verified directly against the compiled Python descriptors
 * in custom_components/mbapi2020/proto/vehicle_events_pb2.py. Only the
 * fields this plugin reads are declared - protobuf safely ignores
 * undeclared/unknown fields on decode, so trimming these does not risk
 * decode errors.
 */
const PROTO_SOURCE = `
syntax = "proto3";
package proto;

message VEPUpdate {
  map<string, VehicleAttributeStatus> attributes = 11;
}

message VehicleAttributeStatus {
  int32 status = 3;
  int64 int_value = 4;
}
`;

let root: protobuf.Root | null = null;
function getRoot(): protobuf.Root {
  if (!root) {
    root = protobuf.parse(PROTO_SOURCE).root;
  }
  return root;
}

export interface DoorLockReading {
  /** raw doorlockstatusvehicle proto enum int, or null if not present */
  value: number | null;
  /** VehicleAttributeStatus.status; per mbapi2020 this must be VALID (0) to trust `value` */
  status: number | null;
}

/**
 * Decodes a VEPUpdate protobuf payload (as returned by the
 * `/v1/vehicle/{vin}/vehicleattributes` REST endpoint) and extracts the
 * `doorlockstatusvehicle` attribute.
 */
export function decodeDoorLockStatus(buffer: Buffer): DoorLockReading {
  const VEPUpdate = getRoot().lookupType('proto.VEPUpdate');
  const message = VEPUpdate.decode(buffer) as unknown as {
    attributes: Record<string, { intValue?: number | Long; status?: number }>;
  };

  const attr = message.attributes?.[DOOR_LOCK_ATTRIBUTE_KEY];
  if (!attr) {
    return { value: null, status: null };
  }

  const status = attr.status ?? 0;
  // status 0 = VALID; 3 = INVALID; 4 = NOT_AVAILABLE (vsu_helper.py). Only
  // trust int_value when the attribute is actually valid.
  if (status !== 0) {
    return { value: null, status };
  }

  const raw = attr.intValue;
  let value: number | null = null;
  if (raw !== undefined) {
    value = typeof raw === 'number' ? raw : (raw as Long).toNumber();
  }
  return { value, status };
}

// protobufjs represents int64 fields with the `long` package's Long type.
type Long = { toNumber(): number };
