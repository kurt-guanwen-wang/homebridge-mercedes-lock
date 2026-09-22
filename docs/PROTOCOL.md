# Mercedes Me API/Protocol Notes

This document records how this plugin talks to Mercedes' backend, and —
more importantly — **how to re-diagnose things when Mercedes changes
something**. It exists because this protocol is unofficial and
reverse-engineered (mirroring the Mercedes Me mobile app via
[`ReneNulschDE/mbapi2020`](https://github.com/ReneNulschDE/mbapi2020)), so
it *will* break eventually. Read this before re-guessing from scratch.

## 1. Architecture in one paragraph

Login is normal OAuth2/PKCE REST. Once you have an access token, there are
**two separate data channels**, and they report **different, non-overlapping
sets of vehicle attributes**:

- **REST** `/v1/vehicle/{vin}/vehicleattributes` — fuel level, range, GPS
  position. **Does not include lock/door/window status**, even though it
  returns the same protobuf message type that theoretically has fields for
  everything.
- **WebSocket** (`wss://websocket.{region}.../v2/ws`) — a persistent push
  connection that streams **everything**, including lock/door/window
  status, as `PushMessage.vehicle_status_updates`. This is the *only*
  channel with lock/door/window data.

If a future symptom is "some field is always null/not reported," the first
question is always: **which channel is supposed to report that field?**
Don't assume REST has it just because the message type has a field for it.

## 2. Regions & base URLs

| Region | REST base | Widget base | WebSocket | Notes |
|---|---|---|---|---|
| Europe | `bff.emea-prod...` | `widget.emea-prod...` | `websocket.emea-prod...` | |
| North America | `bff.amap-prod...` | `widget.amap-prod...` | `websocket.amap-prod...` | shares `amap` env with Asia-Pacific |
| Asia-Pacific | `bff.amap-prod...` | `widget.amap-prod...` | `websocket.amap-prod...` | |
| China | `bff.cn-prod...` | `widget.cn-prod...` | `websocket.cn-prod...` | login currently blocked by CAPTCHA |

All hosts are `*.mobilesdk.mercedes-benz.com`. See `src/constants.ts` for
the exact literal strings (`restBaseUrl`, `widgetBaseUrl`, `websocketUrl`).

Login (OAuth2) always goes to `id.mercedes-benz.com` (China:
`ciam-1.mercedes-benz.com.cn`), regardless of the four regions above.

## 3. REST app-fingerprint headers (bot detection)

Every REST/widget call **must** include these headers or the backend
returns **HTTP 418** (this was the very first bug hit in this project):

```
X-ApplicationName: mycar-store-{us|ap|ece|cn}   # per region
ris-application-version: <version string>       # per region, see below
ris-sdk-version: 4.10.0 (2.132.2 for China)
User-Agent: <real app UA, NOT a generic HTTP client string>
```

Plus the usual session/tracking headers (`x-sessionid`, `x-trackingid`,
`ris-os-name: ios`, `ris-os-version`, `x-locale`).

**Where these values come from**: the real Mercedes Me app calls a
version-check endpoint on startup and gets a live `application_version`
back (see `mbapi2020`'s `app_version.py`, `APP_VERSION_CHECK_INTERVAL_SECONDS`).
This plugin hardcodes the values that worked at the time of writing
(`src/constants.ts` → `APPLICATION_VERSION`, `WEBAPI_USER_AGENT`, etc.)
rather than fetching them live. **If REST calls start failing with 418
again in the future, the first thing to check is whether these hardcoded
version/UA strings have gone stale** — compare against a current
`mbapi2020` checkout's `const.py`/`app_version.py`, or capture real values
from a rooted/jailbroken device or MITM proxy on the real app.

## 4. REST endpoints used

- `GET /v2/vehicles` — returns a "masterdata" object, **not a bare array**.
  Vehicles live under `body.assignedVehicles` (and `body.fleets[].bookedVehicles`
  for fleet accounts). This shape bit us once already (`TypeError: body.map
  is not a function`) — don't assume the response is a plain array if this
  ever changes again; log the raw JSON and re-inspect the shape.
- `GET /v1/vehicle/{vin}/vehicleattributes` (widget host) — returns a binary
  protobuf `VehicleStatusUpdate` message (see §6). **Only fuel/range/GPS
  fields are populated**; lock/door/window fields are present in the
  schema but always empty/NOT_AVAILABLE on this endpoint.

## 5. WebSocket protocol

URL: `wss://websocket.{env}-prod.mobilesdk.mercedes-benz.com/v2/ws` where
`{env}` is `emea`/`amap`/`cn` (NA and APAC share `amap`).

### Connection headers

```
Authorization: <raw access token, NO "Bearer " prefix>   # different from REST!
APP-SESSION-ID: <uuid, uppercase>
OUTPUT-FORMAT: PROTO
X-SessionId: <same uuid>
X-TrackingId: <uuid, uppercase>
ris-os-name / ris-os-version / ris-sdk-version / X-ApplicationName / ris-application-version
User-Agent: <region-specific, see below>
```

**North America/Asia-Pacific only** also need, and this is the single
trickiest gotcha in the whole integration:

```
Accept-Encoding: gzip
Sec-WebSocket-Extensions: permessage-deflate
```

These must be sent as **plain request headers you set yourself**, with the
WebSocket client library's own automatic permessage-deflate negotiation
**disabled** (`perMessageDeflate: false` in the `ws` library). If you
instead let the client library auto-negotiate compression (its default
`Sec-WebSocket-Extensions` value differs slightly, e.g. it may add
`client_max_window_bits` parameters), **the server completes the HTTP
handshake successfully (101 Switching Protocols) but then silently closes
the connection with code 1000 and zero data a moment later** — no error is
ever surfaced. If a future symptom is "the websocket connects fine (you
see the 101 upgrade) but closes immediately with no messages and no
apparent error," **this exact header mismatch is the first thing to
re-check**, not an auth/token problem.

The User-Agent for the websocket also differs by region:

- Europe / China: same static string as the REST `webapi_user_agent()`.
- North America / Asia-Pacific: a **templated** string embedding the live
  app version, e.g. `mycar-store-us v3.67.0, ios 26.3, SDK 4.10.0` — not
  the generic CFNetwork string used for REST on those regions.

### Message flow

- No explicit "subscribe" message is needed — the server streams updates
  for every vehicle on the authenticated account automatically once
  connected.
- All data frames are **binary** (`PushMessage` protobuf, see §6). Text
  frames don't carry vehicle data.
- Every `vehicle_status_updates` push should be acknowledged by sending a
  `ClientMessage` back with `acknowledge_vehicle_status_updates` (field 28)
  containing `{sequence_number}` (field 1) — the same sequence number the
  push carried. Untested whether omitting acks eventually stalls the
  stream; implemented defensively to match the real client
  (`src/websocket.ts`'s `sendAck`, hand-encoded varint since only this one
  small message is needed — didn't bother declaring the full ~20-field
  `ClientMessage` schema).
- Send a WebSocket ping every ~25-30s for keepalive (mirrors the real
  client's watchdog-triggered ping). Reconnect with exponential backoff on
  close/error.

## 6. Protobuf schema — the single most important section

There are **two different, easily-confused message shapes** in this API.
Getting this wrong is what caused the "all vehicle status fields are
always null" bug during initial development.

### `VehicleStatusUpdate` (the one this plugin uses)

A **flat** message — one distinctly-numbered field per named car
attribute (NOT a generic string-keyed map). Both the REST
`vehicleattributes` endpoint and the websocket's `vehicle_status_updates`
push return this same message type. It has 270+ fields in the real
schema; this plugin only declares the handful it needs in `src/proto.ts`
(protobuf safely ignores undeclared fields on decode, so this is safe and
low-maintenance — you don't need the whole schema, just the fields you
care about).

Every attribute is wrapped in a small "attribute" submessage carrying a
value plus validity metadata:

```proto
message VSUMetadata {
  int32 status = 2;   // 0=VALUE_VALID, 1=NOT_RECEIVED, 3=INVALID, 4=NOT_AVAILABLE
}
message EnumAttribute {   // used for lock/door/window/sunroof (all int enums)
  int32 value = 1;
  VSUMetadata metadata = 2;
}
message RatioAttribute {  // used for tank level %, SoC %
  int64 value = 1;
  VSUMetadata metadata = 2;
}
```

**Only trust a value when `metadata.status == 0`** — this plugin returns
`null` for anything else (see `src/proto.ts`'s `isValid()`), since
`NOT_AVAILABLE`/`INVALID` are common and legitimate (e.g. `soc` is always
NOT_AVAILABLE on a combustion car).

Field numbers currently used (verified against `mbapi2020`'s compiled
Python descriptors — see §7 for how):

| Attribute | Field # | Type | Notes |
|---|---|---|---|
| `doorlockstatusvehicle` | 74 | EnumAttribute | 0=UNLOCKED, 1=INTERNAL_LOCKED, 2=EXTERNAL_LOCKED, 3=SELECTIVE_UNLOCKED |
| `door_status_overall` | 266 | EnumAttribute | 0=ANY_DOOR_OPEN, 1=ALL_DOORS_CLOSED, 3=UNKNOWN |
| `window_status_overall` | 272 | EnumAttribute | 0=OPEN, 1=CLOSED, 2=COMPLETELY_OPEN, 3=AIRING |
| `sunroofstatus` | 212 | EnumAttribute | 0=CLOSED, 1=COMPLETE_OPEN, 2=LIFTING_OPEN, 3=RUNNING |
| `soc` (EV battery %) | 196 | RatioAttribute | NOT_AVAILABLE on combustion cars |
| `tanklevelpercent` (fuel %) | 214 | RatioAttribute | NOT_AVAILABLE on pure EVs |

These live in `src/constants.ts`'s `VSU_FIELD` and are consumed by the
hand-written `.proto` source string in `src/proto.ts`. **If Mercedes ever
renumbers fields (unlikely but possible on a major app version bump), only
`VSU_FIELD` needs updating** — nothing else references raw field numbers.

### `PushMessage` (websocket envelope)

```proto
message VehicleStatusUpdatesEntry { string key = 1; VehicleStatusUpdate value = 2; }
message VehicleStatusUpdates {
  int64 sequence_number = 1;
  repeated VehicleStatusUpdatesEntry vehicle_status_updates = 2;  // map<vin, VehicleStatusUpdate>
}
message PushMessage {
  VehicleStatusUpdates vehicle_status_updates = 24;
  // other fields (vepUpdate, assigned_vehicles, debugMessage, etc.) exist
  // at other field numbers and are safely ignored by not declaring them.
}
```

`vehicle_status_updates` is field **24** on `PushMessage`. If a future
capture shows pushes with no field 24 present, or you need a different
push type (e.g. remote-command acknowledgements), you'll need to find its
field number the same way (§7).

### ⚠️ The `protobufjs` camelCase gotcha (caused a real, hard-to-spot bug)

**`protobufjs`'s `Message.decode()` returns objects with camelCase property
names**, derived from your declared field name, **regardless of whether you
wrote the field as `snake_case` or `camelCase` in the `.proto` source.**
E.g. a field declared `door_status_overall = 266;` is accessed at runtime
as `decoded.doorStatusOverall`, **not** `decoded.door_status_overall`.

This caused a real bug in this codebase: the websocket decoder used
snake_case property access (`decoded.vehicle_status_updates`,
`vsu.sequence_number`) matching the `.proto` field names literally, so
every lookup silently returned `undefined` and the code always treated
valid pushes as "not the message type we want" — with **no error, no
warning, just silent nulls**. The connection, auth, and wire bytes were
all correct the entire time; only the JS property names were wrong.

**Lesson for future debugging**: if a decode call runs without throwing
but produces empty/null results, don't assume the wire bytes or field
numbers are wrong — check `console.log(Type.decode(buffer))` and inspect
the *actual* property names on the returned object first. This is a 30-second
check that would have caught the bug immediately instead of requiring the
full field-number archaeology in §7.

## 7. How to re-derive protobuf field numbers when Mercedes changes something

If lock/door/window (or any attribute) suddenly stops decoding correctly,
the field numbers may have shifted, or the schema may have grown new
required framing. Here's the fastest path to ground truth — this is
exactly how the current field numbers in this file were verified:

1. **Get a real payload.** Add a temporary debug hook that dumps the raw
   bytes of a decoded message as hex — a small standalone script using the
   cached OAuth token (see §8) that logs
   `field=<n> bytes/varint len=... preview=<hex>` for every top-level
   field without assuming any schema (walk the buffer: read a varint tag,
   split into `fieldNumber = tag >> 3` / `wireType = tag & 0x7`, then
   branch on wire type 0/1/2/5).
2. **Get the real Python protobuf descriptors.** `mbapi2020` ships
   compiled `_pb2.py` files (e.g. `vehicle_events_pb2.py`) generated from
   Mercedes' actual `.proto` sources. Clone/fetch the current version of
   <https://github.com/ReneNulschDE/mbapi2020> and load the relevant
   `_pb2.py` module in Python — it's authoritative, not a guess:
   ```python
   from custom_components.mbapi2020.proto import vehicle_events_pb2 as pb
   msg = pb.VehicleStatusUpdate()
   for f in msg.DESCRIPTOR.fields:
       print(f.number, f.name, f.type)
   ```
3. **Decode the real captured bytes with that same Python module** to
   confirm field numbers/types match what you see in the raw hex dump from
   step 1, and to get human-readable values to sanity check (e.g. "is 69
   the right tank level for this car?").
4. **Cross-reference semantics**, not just field numbers, against the
   Python integration's own logic — e.g. `mbapi2020`'s `lock.py`,
   `binary_sensor.py`, `vsu_helper.py`, `vsu_enums.py` — to confirm which
   enum values mean "locked"/"open"/etc., rather than guessing from field
   names alone.
5. Only then update `VSU_FIELD` in `src/constants.ts` and the enum values
   in the same file, and re-run the unit tests in `src/__tests__/proto.test.ts`
   (which encode/decode against the real wire format independent of
   `proto.ts`'s internal schema, so they'll catch a field-number mismatch).

## 8. Debugging tools available in this repo

- `scripts/test-login.ts` — standalone CLI, no Homebridge needed. Prints a
  REST snapshot; set `MB_WEBSOCKET=1` (`MB_WEBSOCKET_SECONDS` to control
  duration) to also watch live websocket pushes.
- The OAuth token is cached to `.mercedes-lock-token-{account}.json`
  (gitignored) so repeat test runs don't need a fresh login every time and
  don't risk the account getting rate-limited/flagged for logging in too
  often. **Never commit this file** — it contains a real refresh token.
- For low-level wire debugging (dumping raw top-level protobuf fields
  without assuming a schema, saving raw message bytes to disk for offline
  Python-side decoding), write a small throwaway script following the
  pattern in §7 step 1 — don't leave this kind of scaffolding committed
  long-term; it's a one-off diagnostic tool, not part of the plugin.
- `src/__tests__/proto.test.ts` encodes fixtures with an *independent*
  protobuf schema definition (not `proto.ts`'s own), so it validates true
  wire-format compatibility rather than just round-tripping through the
  same code being tested.

## 9. Known failure modes → root cause quick-reference

| Symptom | Likely cause | Where to look |
|---|---|---|
| REST calls return HTTP 418 | Missing/stale app-fingerprint headers (§3) | `src/constants.ts` version/UA strings, `src/mbApi.ts` `headers()` |
| `TypeError: body.map is not a function` on vehicle list | `/v2/vehicles` response shape changed | `src/mbApi.ts` `getVehicles()` — re-inspect raw JSON |
| All `VehicleStatusUpdate` fields null from REST | Normal — REST never has lock/door/window (§1); only fuel/range/position. Not a bug. | n/a |
| Websocket connects (101) then closes immediately, code 1000, no data | NA/APAC `permessage-deflate` header mismatch (§5) | `src/websocket.ts` connection headers, `perMessageDeflate` option |
| Websocket messages arrive but nothing happens / no pushes logged | Check property-name casing on the decoded object first (§6 camelCase gotcha) before assuming field numbers are wrong | `src/proto.ts` |
| 2FA/OTP error on login | MFA is enabled on the account; this login flow can't answer it | Disable MFA on the dedicated account used with this plugin |
| Login stuck on legal-consent/passkey prompts | First-time account setup screens the automated flow doesn't handle | Log in once via the official Mercedes Me app with that account first |
