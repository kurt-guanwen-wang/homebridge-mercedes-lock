import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { MercedesOAuth } from './oauth';
import { Region, restBaseUrl, widgetBaseUrl } from './constants';
import { decodeDoorLockStatus, DoorLockReading } from './proto';

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
      'ris-os-name': 'ios',
      'ris-os-version': '26.3',
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
    const body = (await res.body.json()) as Array<Record<string, unknown>>;
    return body.map((v) => ({ vin: String(v.vin ?? v.finorvin) }));
  }

  async getDoorLockStatus(vin: string): Promise<DoorLockReading> {
    const res = await request(`${widgetBaseUrl(this.region)}/v1/vehicle/${vin}/vehicleattributes`, {
      method: 'GET',
      headers: await this.headers(),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new Error(`Failed to fetch vehicle attributes: HTTP ${res.statusCode} - ${text}`);
    }
    const buffer = Buffer.from(await res.body.arrayBuffer());
    return decodeDoorLockStatus(buffer);
  }
}
