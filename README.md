# homebridge-mercedes-lock

Shows your Mercedes-Benz vehicle's **door lock status** in Apple Home, as a
**read-only** lock accessory — tapping it in the Home app never sends a
lock/unlock command to the car.

Standalone Homebridge plugin: it logs into your Mercedes Me account
directly (PKCE OAuth2 against `id.mercedes-benz.com`), no Home Assistant
required. The login flow, endpoints, and protobuf schema are ported from
the community project [`mbapi2020`](https://github.com/ReneNulschDE/mbapi2020).

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
  "pollIntervalSeconds": 180
}
```

| Field | Required | Description |
|---|---|---|
| `username` / `password` | yes | Mercedes Me account credentials (MFA disabled) |
| `region` | yes | `Europe`, `North America`, `Asia-Pacific`, or `China` |
| `vin` | no | Set if the account has multiple vehicles; otherwise the first one is used |
| `pollIntervalSeconds` | no | Default 180 |

The OAuth token is cached to disk under Homebridge's storage directory, so
you won't need to re-login on every restart until the refresh token
expires or login fails.

## What shows up in HomeKit

One `LockMechanism` accessory named "Car Door Lock (last 6 of VIN)".
Locked/unlocked state reflects the vehicle's overall central-lock status;
toggling it in the Home app has no effect on the car (it snaps back to the
real status).

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
| `src/constants.ts` | `custom_components/mbapi2020/const.py`, `helper.py` | Per-region endpoint tables (`Rest_url`, `Widget_url`, `Login_Base_Url`, `Login_App_Id`) for Europe, North America, Asia-Pacific, and China, and the `doorlockstatusvehicle` proto enum values from `vsu_enums.py`. |
| `src/proto.ts` | `custom_components/mbapi2020/proto/vehicle_events_pb2.py` | A minimal `.proto` schema for `VEPUpdate`/`VehicleAttributeStatus`. Field numbers were **not guessed** — they were extracted by loading the compiled Python protobuf descriptors at runtime and inspecting the real `FieldDescriptor`s (message/field numbers/types), then hand-written into a compact proto3 definition usable by `protobufjs`. |
| Lock semantics in `lockAccessory.ts` / `platform.ts` | `custom_components/mbapi2020/lock.py` (`is_locked` property) | `doorlockstatusvehicle` values `1` (`INTERNAL_LOCKED`) and `2` (`EXTERNAL_LOCKED`) map to locked; `0` (`UNLOCKED`) and `3` (`SELECTIVE_UNLOCKED`) map to unlocked — verified against the Python source rather than assumed. |
| Attribute validity check in `proto.ts` | `custom_components/mbapi2020/vsu_helper.py` (`_VSU_STATUS_TO_LEGACY`) | `VehicleAttributeStatus.status` must be `0` (valid) before the `int_value` is trusted; `3` (invalid) / `4` (not available) are treated as unknown rather than a stale reading. |
| `src/mbApi.ts` | `custom_components/mbapi2020/webapi.py` (`get_user_info`, `get_car_p2b_data_via_rest`) | Vehicle list (`/v2/vehicles`) and the REST (non-websocket) vehicle-attributes endpoint (`/v1/vehicle/{vin}/vehicleattributes`), which returns the same protobuf payload as the real-time websocket push without needing a persistent connection. |

**Deliberately not ported:** the websocket real-time push client
(`websocket.py`), remote commands (lock/unlock/climate/etc. in
`services.py`, `lock.py`, `switch.py`), and every non-door-lock sensor
(tires, fuel, EV charging, geofencing, etc.) — this plugin's scope is
read-only door-lock status only.

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

