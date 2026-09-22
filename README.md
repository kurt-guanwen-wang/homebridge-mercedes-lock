# homebridge-mercedes-lock

Shows your Mercedes-Benz vehicle's status in Apple Home — door lock,
doors, windows, interior lights, and fuel/EV level — as a single **read-only**
HomeKit accessory. Nothing here can send a lock/unlock or other command to
the car; every writable characteristic snaps back to the real status.

Standalone Homebridge plugin: it logs into your Mercedes Me account
directly (PKCE OAuth2 against `id.mercedes-benz.com`), no Home Assistant
required. The login flow, endpoints, and protobuf schema are ported from
the community project [`mbapi2020`](https://github.com/ReneNulschDE/mbapi2020),
with the additional attribute mappings cross-checked against
[`seydx/homebridge-mercedesme`](https://github.com/seydx/homebridge-mercedesme)
(a Homebridge plugin built against Mercedes' now-discontinued official
"Connect Your Car"/BYOC developer API, which used the same attribute-key
naming as the app API this plugin talks to).

## ⚠️ Important / risk disclosure

This uses an **unofficial, reverse-engineered API** that mimics the
Mercedes Me mobile app. It is not affiliated with or endorsed by
Mercedes-Benz and could break or get your account flagged at any time.

- **MFA must be disabled** on the account used here — the login flow
  cannot answer 2FA/OTP challenges.
- **Use a dedicated secondary Mercedes Me account**, invited as an
  additional driver on your vehicle (Mercedes allows up to 6 per car), and
  don't use that account simultaneously in the official app.
- **Legal-consent / passkey-setup prompts are not handled.** If your
  account is prompted for these on first login, log in once via the
  official Mercedes Me app with that account to clear them before using
  this plugin.
- Keep the poll interval reasonable (default 180s) to reduce the risk of
  rate limiting.
- **China region is included for parity with `mbapi2020` but is currently
  non-functional** — Mercedes' China CIAM login presents a CAPTCHA that
  this (and the upstream) login flow cannot solve.

## Install

```bash
npm install -g homebridge-mercedes-lock
```

Or via Homebridge UI: search for "Mercedes Lock".

## Configuration

Configure via Homebridge UI (recommended) or `config.json`:

```json
{
  "platform": "MercedesLock",
  "name": "Mercedes Lock",
  "username": "your-dedicated-account@example.com",
  "password": "your-password",
  "region": "North America",
  "pollIntervalSeconds": 180,
  "showLock": true,
  "showDoors": true,
  "showWindows": true,
  "showLights": true,
  "showFuelBattery": true,
  "showEvBattery": true
}
```

| Field | Required | Description |
|---|---|---|
| `username` / `password` | yes | Mercedes Me account credentials (MFA disabled) |
| `region` | yes | `Europe`, `North America`, `Asia-Pacific`, or `China` |
| `vin` | no | Set if the account has multiple vehicles; otherwise the first one is used |
| `pollIntervalSeconds` | no | Default 180 |
| `showLock` | no | Show the door lock service. Default `true` |
| `showDoors` | no | Show the doors contact sensor. Default `true` |
| `showWindows` | no | Show the windows/sunroof contact sensor. Default `true` |
| `showLights` | no | Show the interior lights service. Default `true` |
| `showFuelBattery` | no | Show fuel level (if reported by the car). Default `true` |
| `showEvBattery` | no | Show EV charge level (if reported by the car). Default `true` |

The Homebridge UI groups the `show*` toggles under a "HomeKit Services"
section in the plugin settings form. Turning a toggle off removes that
service from the accessory (including one restored from a previous
Homebridge run) the next time the plugin starts.

The OAuth token is cached to disk under Homebridge's storage directory, so
you won't need to re-login on every restart until the refresh token
expires or login fails.

## What shows up in HomeKit

One accessory named "Car (last 6 of VIN)" with several read-only services,
each independently toggleable in config (see above):

| Service | Reflects | Notes |
|---|---|---|
| `LockMechanism` | Central door lock | Locked if `doorlockstatusvehicle` is internal- or externally-locked |
| `ContactSensor` "Doors" | Any door or the trunk/decklid open | "Not Detected" (open) if any of the 4 doors or the decklid is open |
| `ContactSensor` "Windows" | Any window or the sunroof open | Includes sunroof tilt/lift positions |
| `Lightbulb` "Interior Lights" | Interior lights on/off | On/off only, no brightness |
| `Battery` "Fuel Level" | Fuel tank %, 0-100 | Only created if the car reports `tanklevelpercent` (combustion/hybrid) |
| `Battery` "EV Charge" | EV state of charge %, 0-100 | Only created if the car reports `soc` (EV/hybrid) |

Any attribute the car doesn't report (e.g. no EV battery on a combustion
car) is simply left out rather than shown as a false reading.

## Ported from the Home Assistant plugin (`mbapi2020`)

This plugin is not a wrapper around Home Assistant — it's a from-scratch
Node.js/TypeScript **port** of the relevant pieces of
[`ReneNulschDE/mbapi2020`](https://github.com/ReneNulschDE/mbapi2020) (a
Python Home Assistant custom component), so it can run standalone inside
Homebridge. Nothing here talks to an official Mercedes-Benz developer API —
it reproduces the same requests the Mercedes Me mobile app makes.

| This plugin | Ported from (mbapi2020) | What was ported |
|---|---|---|
| `src/oauth.ts` | `custom_components/mbapi2020/oauth.py` | The PKCE OAuth2 login flow against `id.mercedes-benz.com` CIAM: authorization request → resume-parameter extraction → username/password submission → resume-authorization redirect (custom `rismycar://` scheme) → code-for-token exchange, plus refresh-token flow. Legal-consent and passkey-setup prompt handling from the Python version were **not** ported (see risk disclosure above). |
| `src/constants.ts` | `custom_components/mbapi2020/const.py`, `helper.py`, `vsu_enums.py` | Per-region endpoint tables (`Rest_url`, `Widget_url`, `Login_Base_Url`, `Login_App_Id`) for Europe, North America, Asia-Pacific, and China, plus the proto enum values for door lock, per-door status, window status, and sunroof status. |
| `src/proto.ts` | `custom_components/mbapi2020/proto/vehicle_events_pb2.py` | A minimal `.proto` schema for `VEPUpdate`/`VehicleAttributeStatus`, generically decoding every attribute the car reports (not just the door lock). Field numbers were **not guessed** — they were extracted by loading the compiled Python protobuf descriptors at runtime and inspecting the real `FieldDescriptor`s (message/field numbers/types, and the `int_value`/`bool_value` `oneof` grouping), then hand-written into a compact proto3 definition usable by `protobufjs`. |
| `src/vehicleStatus.ts` | `custom_components/mbapi2020/binary_sensor.py`, `lock.py`; cross-checked against `seydx/homebridge-mercedesme`'s `src/accessories/accessory.js` | Interprets the raw attribute map into lock/doors/windows/fuel/EV/lights booleans and percentages, using the same per-attribute enum semantics (e.g. `doorstatusfrontleft` 0=closed/1=open, `windowstatus*` 2=closed/else=open, `sunroofstatus` 0=closed/else=open) both projects rely on. |
| `src/carAccessory.ts` | `custom_components/mbapi2020/lock.py`; `seydx/homebridge-mercedesme`'s `accessory.js` (service layout: one accessory, multiple services) | `doorlockstatusvehicle` values `1` (`INTERNAL_LOCKED`) and `2` (`EXTERNAL_LOCKED`) map to locked; `0` (`UNLOCKED`) and `3` (`SELECTIVE_UNLOCKED`) map to unlocked — verified against the Python source rather than assumed. All writable characteristics (lock target state, light on/off) are no-ops. |
| Attribute validity check in `proto.ts` | `custom_components/mbapi2020/vsu_helper.py` (`_VSU_STATUS_TO_LEGACY`) | `VehicleAttributeStatus.status` must be `0` (valid) before a value is trusted; `3` (invalid) / `4` (not available) are treated as unknown rather than a stale reading. |
| `src/mbApi.ts` | `custom_components/mbapi2020/webapi.py` (`get_user_info`, `get_car_p2b_data_via_rest`) | Vehicle list (`/v2/vehicles`) and the REST (non-websocket) vehicle-attributes endpoint (`/v1/vehicle/{vin}/vehicleattributes`), which returns the same protobuf payload as the real-time websocket push without needing a persistent connection — a single call per poll now covers all attributes above. |

**Deliberately not ported:** the websocket real-time push client
(`websocket.py`), remote commands (lock/unlock/climate/etc. in
`services.py`, `lock.py`, `switch.py`), and attributes with no sensible
native HomeKit mapping (odometer, tire pressure, GPS location, charging
schedules, etc. — these would need Eve app custom characteristics).

## Development

```bash
npm install
npm run build
```

To exercise the login + door-lock fetch without Homebridge, see
[Testing without Homebridge](#testing-without-homebridge) below.

## Testing without Homebridge

`src/oauth.ts` / `src/mbApi.ts` / `src/proto.ts` have no runtime dependency
on Homebridge, so you can test login + door-lock status directly:

```bash
MB_USERNAME='you@example.com' MB_PASSWORD='yourpassword' MB_REGION='North America' npm run test:login
```

Optional: `MB_VIN` to target a specific vehicle. The token is cached to
`.mercedes-lock-test-token-test.json` (gitignored) so repeat runs skip a
full login until it expires.

