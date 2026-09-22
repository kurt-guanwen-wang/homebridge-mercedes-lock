/**
 * Standalone CLI to test the Mercedes login + full vehicle-status fetch
 * without running Homebridge at all. Useful for verifying credentials/
 * region work before wiring this into the actual plugin.
 *
 * Usage:
 *   MB_USERNAME=you@example.com MB_PASSWORD='...' MB_REGION="North America" \
 *     npx ts-node scripts/test-login.ts
 *
 * Token is cached to ./.mercedes-lock-test-token-test.json in the current
 * directory (gitignored) so re-runs don't need a fresh login every time.
 */
import { MercedesOAuth } from '../src/oauth';
import { TokenCache } from '../src/tokenCache';
import { MercedesApi } from '../src/mbApi';
import { Region } from '../src/constants';

const consoleLogger = {
  debug: (...a: unknown[]) => console.debug('[debug]', ...a),
  info: (...a: unknown[]) => console.info('[info]', ...a),
  warn: (...a: unknown[]) => console.warn('[warn]', ...a),
  error: (...a: unknown[]) => console.error('[error]', ...a),
};

async function main() {
  const username = process.env.MB_USERNAME;
  const password = process.env.MB_PASSWORD;
  const region = (process.env.MB_REGION ?? 'North America') as Region;
  const vin = process.env.MB_VIN;

  if (!username || !password) {
    console.error('Set MB_USERNAME and MB_PASSWORD environment variables.');
    process.exit(1);
  }

  const tokenCache = new TokenCache(process.cwd(), 'test');
  const oauth = new MercedesOAuth(username, password, region, tokenCache, consoleLogger);
  const api = new MercedesApi(oauth, region);

  console.log(`Logging in (region=${region})...`);
  await oauth.getAccessToken();
  console.log('Login OK, token acquired.');

  const targetVin = vin ?? (await api.getVehicles())[0]?.vin;
  if (!targetVin) {
    console.error('No vehicles found on this account.');
    process.exit(1);
  }
  console.log(`Using VIN: ${targetVin}`);

  const reading = await api.getVehicleStatus(targetVin);
  console.log('Vehicle status:', reading);
  console.log(
    reading.lock === 1 || reading.lock === 2
      ? 'Lock: LOCKED'
      : reading.lock === 0 || reading.lock === 3
        ? 'Lock: UNLOCKED'
        : 'Lock: UNKNOWN',
  );
  console.log('Doors open:', reading.doorsOpen ?? 'not reported');
  console.log('Windows/sunroof open:', reading.windowsOpen ?? 'not reported');
  console.log('Interior lights on:', reading.lightsOn ?? 'not reported');
  console.log('Fuel level %:', reading.fuelPercent ?? 'not reported');
  console.log('EV charge %:', reading.evPercent ?? 'not reported');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
