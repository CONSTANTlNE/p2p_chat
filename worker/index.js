export { RoomDO } from './room.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WebSocket upgrade for room signaling
    const wsMatch = url.pathname.match(/^\/room\/([^/]+)\/ws$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      if (!roomId || !/^[0-9a-f-]{36}$/.test(roomId)) {
        return new Response('Invalid room ID', { status: 400 });
      }
      const doId = env.ROOMS.idFromName(roomId);
      const room = env.ROOMS.get(doId);
      return room.fetch(request);
    }

    // All other routes: fall through to Workers Assets (public/ directory)
    // When using [assets] in wrangler.toml, the runtime handles this automatically.
    // If env.ASSETS is available (newer Workers runtime), delegate to it.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};
