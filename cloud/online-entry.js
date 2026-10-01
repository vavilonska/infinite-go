import api from './worker.js';
export { GameRoom, RoomCreationLimiter, MatchmakingQueue } from './worker.js';

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    // API errors and room WebSocket upgrades always stay with the authority.
    // Assets may carry the generated cache-version query; API queries may not.
    if (pathname === '/api' || pathname.startsWith('/api/') || request.headers.has('Upgrade')) {
      return api.fetch(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
