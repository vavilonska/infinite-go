import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatic } from '../scripts/build-static.mjs';

// Only this generated online edition uses its own origin as the default API.
// The shared whitelist excludes servers, models, local settings and credentials.
const output = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
await rm(output, { recursive: true, force: true });
await buildStatic(output, {
  remoteConfig: 'export const DEFAULT_REMOTE_ENDPOINT = globalThis.location.origin;\nexport const ONLINE_PLAY_URL = globalThis.location.origin;\n',
  networkOnlyApi: true,
  // Cloudflare canonicalizes index.html with a redirect. Cache the directly
  // served root so navigation never receives a redirected cached response.
  navigationAsset: './',
});
console.log('Prepared Cloudflare online frontend in cloud/dist. API requests bypass offline HTML caching.');
