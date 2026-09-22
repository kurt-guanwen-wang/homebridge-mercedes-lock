import * as protobuf from 'protobufjs';

/**
 * Minimal subset of mbapi2020's vehicle-events.proto (package `proto`),
 * field numbers verified directly against the compiled Python descriptors
 * in custom_components/mbapi2020/proto/vehicle_events_pb2.py. Only the
 * fields this plugin reads are declared - protobuf safely ignores
 * undeclared/unknown fields on decode, so trimming these does not risk
 * decode errors.
 *
 * `int_value` and `bool_value` are members of the same protobuf `oneof`
 * (verified via FieldDescriptor.containing_oneof), so at most one of them
 * is ever present on a given attribute - which one depends on the
 * attribute's proto type (enum-like statuses use int_value, plain
 * booleans like interior lights use bool_value).
 */
const PROTO_SOURCE = `
syntax = "proto3";
package proto;

message VEPUpdate {
  map<string, VehicleAttributeStatus> attributes = 11;
}

message VehicleAttributeStatus {
  int32 status = 3;
  oneof attribute_type {
    int64 int_value = 4;
    bool bool_value = 5;
  }
}
`;

let root: protobuf.Root | null = null;
function getRoot(): protobuf.Root {
  if (!root) {
    root = protobuf.parse(PROTO_SOURCE).root;
  }
  return root;
}

export interface AttributeReading {
  /** int_value or bool_value, or null if not present/invalid. */
  value: number | boolean | null;
  /** VehicleAttributeStatus.status; per mbapi2020 this must be VALID (0) to trust `value`. */
  status: number | null;
}

// protobufjs represents int64 fields with the `long` package's Long type.
type Long = { toNumber(): number };

interface RawAttribute {
  intValue?: number | Long;
  boolValue?: boolean;
  status?: number;
  /** protobufjs' virtual oneof discriminator: 'intValue', 'boolValue', or '' if neither was set on the wire. */
  attributeType?: string;
}

/**
 * Decodes a VEPUpdate protobuf payload (as returned by the
 * `/v1/vehicle/{vin}/vehicleattributes` REST endpoint) into a plain map of
 * attribute key -> reading, for every attribute the car reported.
 */
export function decodeVehicleAttributes(buffer: Buffer): Record<string, AttributeReading> {
  const VEPUpdate = getRoot().lookupType('proto.VEPUpdate');
  const message = VEPUpdate.decode(buffer) as unknown as {
    attributes: Record<string, RawAttribute>;
  };

  const result: Record<string, AttributeReading> = {};
  for (const [key, attr] of Object.entries(message.attributes ?? {})) {
    const status = attr.status ?? 0;
    // status 0 = VALID; 3 = INVALID; 4 = NOT_AVAILABLE (vsu_helper.py). Only
    // trust the value when the attribute is actually valid.
    if (status !== 0) {
      result[key] = { value: null, status };
      continue;
    }

    // `int_value`/`bool_value` are proto3 scalars inside a `oneof`, so both
    // are always present on the decoded message with their zero-value
    // default (0 / false) - checking `!== undefined` would always be true.
    // The oneof's virtual discriminator (`attributeType`) tells us which
    // one was actually set on the wire.
    if (attr.attributeType === 'boolValue') {
      result[key] = { value: attr.boolValue ?? null, status };
    } else if (attr.attributeType === 'intValue') {
      const raw = attr.intValue;
      const value = raw === undefined ? null : typeof raw === 'number' ? raw : (raw as Long).toNumber();
      result[key] = { value, status };
    } else {
      result[key] = { value: null, status };
    }
  }
  return result;
}
