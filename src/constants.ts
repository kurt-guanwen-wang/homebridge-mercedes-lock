/**
 * Region-specific endpoint constants, ported from mbapi2020's const.py / helper.py.
 * https://github.com/ReneNulschDE/mbapi2020
 */

export type Region = 'Europe' | 'North America' | 'Asia-Pacific' | 'China';

const LOGIN_APP_ID_EU = '62778dc4-1de3-44f4-af95-115f06a3a008';
const LOGIN_APP_ID_CN = '3f36efb1-f84b-4402-b5a2-68a118fec33e';
const LOGIN_BASE_URI = 'https://id.mercedes-benz.com';
const LOGIN_BASE_URI_CN = 'https://ciam-1.mercedes-benz.com.cn';
export const REDIRECT_URI = 'rismycar://login-callback';
export const OAUTH_SCOPE = 'email profile ciam-uid phone openid offline_access';

export function loginBaseUrl(region: Region): string {
  return region === 'China' ? LOGIN_BASE_URI_CN : LOGIN_BASE_URI;
}

export function loginAppId(region: Region): string {
  return region === 'China' ? LOGIN_APP_ID_CN : LOGIN_APP_ID_EU;
}

const REST_API_BASE: Record<Region, string> = {
  Europe: 'https://bff.emea-prod.mobilesdk.mercedes-benz.com',
  'North America': 'https://bff.amap-prod.mobilesdk.mercedes-benz.com',
  'Asia-Pacific': 'https://bff.amap-prod.mobilesdk.mercedes-benz.com',
  China: 'https://bff.cn-prod.mobilesdk.mercedes-benz.com',
};

const WIDGET_ENV: Record<Region, string> = {
  Europe: 'emea',
  'North America': 'amap',
  'Asia-Pacific': 'amap',
  China: 'cn',
};

export function restBaseUrl(region: Region): string {
  return REST_API_BASE[region];
}

export function widgetBaseUrl(region: Region): string {
  return `https://widget.${WIDGET_ENV[region]}-prod.mobilesdk.mercedes-benz.com`;
}

/**
 * Per-app-request fingerprint fields the Mercedes Me mobile app sends on
 * every REST call (`app_version.py`'s `apply_webapi_headers`). Without
 * these (X-ApplicationName, ris-application-version, ris-sdk-version, and
 * a real app User-Agent instead of a generic HTTP client's), the backend's
 * bot detection can reject requests outright (observed as HTTP 418).
 */
const APPLICATION_NAME: Record<Region, string> = {
  Europe: 'mycar-store-ece',
  'North America': 'mycar-store-us',
  'Asia-Pacific': 'mycar-store-ap',
  China: 'mycar-store-cn',
};

const APPLICATION_VERSION: Record<Region, string> = {
  Europe: '1.68.0 (3060)',
  'North America': '3.67.0',
  'Asia-Pacific': '1.67.0',
  China: '1.67.0',
};

const RIS_SDK_VERSION = '4.10.0';
const RIS_SDK_VERSION_CN = '2.132.2';

const WEBAPI_USER_AGENT = 'Mercedes-Benz/3044 CFNetwork/3860.400.22 Darwin/25.3.0';
const WEBAPI_USER_AGENT_CN =
  'MyStarCN/1.63.0 (com.daimler.ris.mercedesme.cn.ios; build:1758; iOS 16.3.1) Alamofire/5.4.0';

export function applicationName(region: Region): string {
  return APPLICATION_NAME[region];
}

export function applicationVersion(region: Region): string {
  return APPLICATION_VERSION[region];
}

export function sdkVersion(region: Region): string {
  return region === 'China' ? RIS_SDK_VERSION_CN : RIS_SDK_VERSION;
}

export function webApiUserAgent(region: Region): string {
  return region === 'China' ? WEBAPI_USER_AGENT_CN : WEBAPI_USER_AGENT;
}

export const RIS_OS_NAME = 'ios';
export const RIS_OS_VERSION = '26.3';

export const MOBILE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1';

/**
 * doorlockstatusvehicle proto enum values (vsu_enums.py / DoorlockstatusvehicleEnumAttribute).
 * Verified against lock.py: status in (1,2) => locked, (0,3) => unlocked.
 */
export enum DoorLockStatusVehicle {
  UNLOCKED = 0,
  INTERNAL_LOCKED = 1,
  EXTERNAL_LOCKED = 2,
  SELECTIVE_UNLOCKED = 3,
}

export const DOOR_LOCK_ATTRIBUTE_KEY = 'doorlockstatusvehicle';

/**
 * doorstatus{position} / decklidstatus proto enum values, shared across all
 * per-door attributes (vsu_enums.py: DOORSTATUS_CLOSED/OPEN). Verified
 * against seydx/homebridge-mercedesme's binary_sensor door handler and
 * ReneNulschDE/mbapi2020's binary_sensor.py.
 */
export enum DoorStatus {
  CLOSED = 0,
  OPEN = 1,
}

export const DOOR_STATUS_ATTRIBUTE_KEYS = [
  'doorstatusfrontleft',
  'doorstatusfrontright',
  'doorstatusrearleft',
  'doorstatusrearright',
  'decklidstatus',
] as const;

/** windowstatus{position} proto enum values (vsu_enums.py: WINDOWSTATUS_*). */
export enum WindowStatus {
  INTERMEDIATE = 0,
  COMPLETELY_OPENED = 1,
  COMPLETELY_CLOSED = 2,
  AIRING_POSITION = 3,
}

export const WINDOW_STATUS_ATTRIBUTE_KEYS = [
  'windowstatusfrontleft',
  'windowstatusfrontright',
  'windowstatusrearleft',
  'windowstatusrearright',
] as const;

/** sunroofstatus proto enum values (vsu_enums.py: SUNROOFSTATUS_*). */
export enum SunroofStatus {
  CLOSED = 0,
  COMPLETE_OPEN = 1,
  LIFTING_OPEN = 2,
  RUNNING = 3,
}

export const SUNROOF_STATUS_ATTRIBUTE_KEY = 'sunroofstatus';

/** Fuel tank level, 0-100 (int_value). Present on combustion/hybrid vehicles. */
export const FUEL_LEVEL_ATTRIBUTE_KEY = 'tanklevelpercent';

/** EV state of charge, 0-100 (int_value). Present on EV/hybrid vehicles. */
export const EV_SOC_ATTRIBUTE_KEY = 'soc';

/**
 * Interior light attributes are booleans (bool_value), unlike the
 * enum-based door/window/sunroof statuses above - confirmed via
 * vsu_enums.py having no INTERIORLIGHTS or READINGLAMP enum entries.
 */
export const INTERIOR_LIGHT_ATTRIBUTE_KEYS = ['interiorLightsFront', 'interiorLightsRear'] as const;
