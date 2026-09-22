import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { MercedesOAuth } from './oauth';
import {
  applicationName,
  applicationVersion,
  Region,
  restBaseUrl,
  RIS_OS_NAME,
  RIS_OS_VERSION,
  sdkVersion,
  webApiUserAgent,
  widgetBaseUrl,
} from './constants';
import { decodeVehicleAttributes } from './proto';
import { CarStatus, interpretCarStatus } from './vehicleStatus';

export interface Vehicle {
  vin: string;
}

/**
 * Thin REST client for the two endpoints this plugin needs: listing
 * vehicles and fetching a vehicle's current attributes (door lock status
 * among them). Ported from mbapi2020's webapi.py `get_user_info` /
 * `get_car_p2b_data_via_rest`.
 */
export class MercedesApi {
  private readonly sessionId = randomUUID().toUpperCase();

  constructor(
    private readonly oauth: MercedesOAuth,
    private readonly region: Region,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.oauth.getAccessToken();
    return {
      authorization: `Bearer ${token}`,
      'x-sessionid': this.sessionId,
      'x-trackingid': randomUUID().toUpperCase(),
      'ris-os-name': RIS_OS_NAME,
      'ris-os-version': RIS_OS_VERSION,
      'x-applicationname': applicationName(this.region),
      'ris-application-version': applicationVersion(this.region),
      'ris-sdk-version': sdkVersion(this.region),
      'user-agent': webApiUserAgent(this.region),
      'x-locale': 'en-US',
      'content-type': 'application/json; charset=UTF-8',
    };
  }

  async getVehicles(): Promise<Vehicle[]> {
    const res = await request(`${restBaseUrl(this.region)}/v2/vehicles`, {
      method: 'GET',
      headers: await this.headers(),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new Error(`Failed to list vehicles: HTTP ${res.statusCode} - ${text}`);
    }
    // The response is a "masterdata" object, not a bare array: vehicles
    // live under `assignedVehicles`, plus `bookedVehicles` per fleet for
    // fleet/company accounts. Ported from mbapi2020's __init__.py.
    const body = (await res.body.json()) as Record<string, unknown>;
    const vehicles: Array<Record<string, unknown>> = [];
    const fleets = Array.isArray(body.fleets) ? (body.fleets as Array<Record<string, unknown>>) : [];
    for (const fleet of fleets) {
      if (Array.isArray(fleet.bookedVehicles)) {
        vehicles.push(...(fleet.bookedVehicles as Array<Record<string, unknown>>));
      }
    }
    if (Array.isArray(body.assignedVehicles)) {
      vehicles.push(...(body.assignedVehicles as Array<Record<string, unknown>>));
    }
    return vehicles.map((v) => ({ vin: String(v.vin ?? v.fin ?? v.finorvin) }));
  }

  /**
   * Fetches every reported vehicle attribute in a single call (lock,
   * doors, windows, fuel/EV level, interior lights) and interprets them
   * into a typed CarStatus. Ported from mbapi2020's webapi.py
   * `get_car_p2b_data_via_rest`.
   */
  async getVehicleStatus(vin: string): Promise<CarStatus> {
    const res = await request(`${widgetBaseUrl(this.region)}/v1/vehicle/${vin}/vehicleattributes`, {
      method: 'GET',
      headers: await this.headers(),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new Error(`Failed to fetch vehicle attributes: HTTP ${res.statusCode} - ${text}`);
    }
    const buffer = Buffer.from(await res.body.arrayBuffer());
    return interpretCarStatus(decodeVehicleAttributes(buffer));
  }
}
