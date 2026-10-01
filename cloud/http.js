import { LIMITS, reject } from './room-state.js';

export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers,
  } });
}
export function errorResponse(error) {
  return json(error.status || 503, {
    error: error.status ? error.message : 'Cloud service is unavailable. Keep your local snapshot and try again later.',
    ...(error.status ? error.details : { errorCode: 'CLOUD_UNAVAILABLE', recoverable: true }),
  }, error.status === 429 ? { 'Retry-After': String(Math.ceil(error.details.retryAfterMs / 1000)) } : {});
}
export async function readJson(request) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') reject(415, 'Send application/json');
  if (Number(request.headers.get('Content-Length')) > LIMITS.requestBytes) reject(413, 'Request body is too large');
  if (!request.body) reject(400, 'Invalid JSON');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.requestBytes) { await reader.cancel(); reject(413, 'Request body is too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reject(400, 'Invalid JSON'); }
}
