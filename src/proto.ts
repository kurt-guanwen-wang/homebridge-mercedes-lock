import * as protobuf from 'protobufjs';
import { VSU_FIELD } from './constants';

/**
 * Minimal subset of mbapi2020's vehicle-events.proto (package `proto`),
 * field numbers verified directly against the compiled Python descriptors
 * in custom_components/mbapi2020/proto/vehicle_events_pb2.py.
 *
 * Both the `/v1/vehicle/{vin}/vehicleattributes` REST endpoint and the
 * `vehicle_status_updates` websocket push message return a
 * `VehicleStatusUpdate`: a *flat* message with one distinctly-numbered
 * field per named attribute (verified by decoding a real payload with the
 * genuine Python protobuf descriptors) - not the generic string-keyed
 * attribute map (`VEPUpdate.attributes`) an earlier version of this file
 * assumed. Only the handful of fields this plugin reads are declared here;
 * protobuf safely skips undeclared/unknown fields on decode.
 */
const PROTO_SOURCE = `
syntax = "proto3";
package proto;

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
`;

let root: protobuf.Root | null = null;
function getRoot(): protobuf.Root {
  if (!root) {
    root = protobuf.parse(PROTO_SOURCE).root;
  }
  return root;
}

// protobufjs represents int64 fields with the `long` package's Long type.
type Long = { toNumber(): number };

interface RawEnumAttribute {
  value?: number;
  metadata?: { status?: number };
}

interface RawRatioAttribute {
  value?: number | Long;
  metadata?: { status?: number };
}

interface RawVehicleStatusUpdate {
  doorlockstatusvehicle?: RawEnumAttribute;
  doorStatusOverall?: RawEnumAttribute;
  windowStatusOverall?: RawEnumAttribute;
  sunroofstatus?: RawEnumAttribute;
  soc?: RawRatioAttribute;
  tanklevelpercent?: RawRatioAttribute;
}

/** A single reported attribute value, or null if missing/invalid. */
export interface RawReading {
  value: number | null;
}

/** The subset of VehicleStatusUpdate fields this plugin cares about. */
export interface RawVehicleStatus {
  lock: RawReading;
  doorStatusOverall: RawReading;
  windowStatusOverall: RawReading;
  sunroofstatus: RawReading;
  soc: RawReading;
  tanklevelpercent: RawReading;
}

/**
 * VSUMetadata.status: 0 = VALUE_VALID, 1 = VALUE_NOT_RECEIVED,
 * 3 = VALUE_INVALID, 4 = VALUE_NOT_AVAILABLE. Only trust a value when it's
 * actually valid (vsu_helper.py).
 */
function isValid(status: number | undefined): boolean {
  return (status ?? 0) === 0;
}

function readEnum(attr: RawEnumAttribute | undefined): RawReading {
  if (!attr || !isValid(attr.metadata?.status)) {
    return { value: null };
  }
  return { value: attr.value ?? null };
}

function readRatio(attr: RawRatioAttribute | undefined): RawReading {
  if (!attr || !isValid(attr.metadata?.status)) {
    return { value: null };
  }
  const raw = attr.value;
  const value = raw === undefined ? null : typeof raw === 'number' ? raw : (raw as Long).toNumber();
  return { value };
}

function extractRawStatus(decoded: RawVehicleStatusUpdate): RawVehicleStatus {
  return {
    lock: readEnum(decoded.doorlockstatusvehicle),
    doorStatusOverall: readEnum(decoded.doorStatusOverall),
    windowStatusOverall: readEnum(decoded.windowStatusOverall),
    sunroofstatus: readEnum(decoded.sunroofstatus),
    soc: readRatio(decoded.soc),
    tanklevelpercent: readRatio(decoded.tanklevelpercent),
  };
}

/**
 * Decodes a single-vehicle VehicleStatusUpdate payload, as returned by the
 * `/v1/vehicle/{vin}/vehicleattributes` REST endpoint.
 */
export function decodeVehicleStatusUpdate(buffer: Buffer): RawVehicleStatus {
  const VehicleStatusUpdate = getRoot().lookupType('proto.VehicleStatusUpdate');
  const decoded = VehicleStatusUpdate.decode(buffer) as unknown as RawVehicleStatusUpdate;
  return extractRawStatus(decoded);
}

export interface DecodedVehicleStatusUpdates {
  sequenceNumber: string;
  vehicles: Map<string, RawVehicleStatus>;
}

interface RawPushMessage {
  vehicleStatusUpdates?: {
    sequenceNumber?: number | Long;
    vehicleStatusUpdates?: Array<{ key: string; value: RawVehicleStatusUpdate }>;
  };
}

/**
 * Decodes a websocket PushMessage binary frame, returning the per-VIN
 * status map if it's a `vehicle_status_updates` push (the only push
 * message type this plugin needs), or null for any other message type
 * (e.g. vepUpdate, debugMessage, assigned_vehicles - safely ignored).
 */
export function decodePushMessageVehicleStatusUpdates(buffer: Buffer): DecodedVehicleStatusUpdates | null {
  const PushMessage = getRoot().lookupType('proto.PushMessage');
  const decoded = PushMessage.decode(buffer) as unknown as RawPushMessage;
  const vsu = decoded.vehicleStatusUpdates;
  if (!vsu) {
    return null;
  }
  const vehicles = new Map<string, RawVehicleStatus>();
  for (const entry of vsu.vehicleStatusUpdates ?? []) {
    vehicles.set(entry.key, extractRawStatus(entry.value));
  }
  const seq = vsu.sequenceNumber;
  const sequenceNumber = seq === undefined ? '0' : typeof seq === 'number' ? String(seq) : String(seq as Long);
  return { sequenceNumber, vehicles };
}
