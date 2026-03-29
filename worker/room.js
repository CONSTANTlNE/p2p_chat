export class RoomDO {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');

    // Check if user is banned
    if (userId) {
      const banned = await this.state.storage.get(`ban:${userId}`);
      if (banned) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.close(4003, 'banned');
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    const existing = this.state.getWebSockets();
    if (existing.length >= 2) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.close(4001, 'room-full');
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const socketId = crypto.randomUUID();
    this.state.acceptWebSocket(server, [socketId]);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
      return;
    }

    if (data.type === 'join') {
      ws.serializeAttachment({ userId: data.userId, name: data.name, isCreator: data.isCreator });
      this._relayTo(ws, { type: 'peer-joined', userId: data.userId, name: data.name });
      for (const other of this.state.getWebSockets()) {
        if (other !== ws) {
          const info = other.deserializeAttachment();
          if (info) {
            try { ws.send(JSON.stringify({ type: 'peer-joined', userId: info.userId, name: info.name })); } catch {}
          }
        }
      }
      return;
    }

    if (data.type === 'kick') {
      // Only the creator can kick
      const senderInfo = ws.deserializeAttachment();
      if (!senderInfo?.isCreator) return;
      // Find target and close their connection
      for (const other of this.state.getWebSockets()) {
        const info = other.deserializeAttachment();
        if (info?.userId === data.targetUserId) {
          try {
            other.send(JSON.stringify({ type: 'kicked' }));
            other.close(4002, 'kicked');
          } catch {}
        }
      }
      return;
    }

    if (data.type === 'ban') {
      // Only the creator can ban
      const senderInfo = ws.deserializeAttachment();
      if (!senderInfo?.isCreator) return;
      // Persist ban
      await this.state.storage.put(`ban:${data.targetUserId}`, true);
      // Kick them if currently connected
      for (const other of this.state.getWebSockets()) {
        const info = other.deserializeAttachment();
        if (info?.userId === data.targetUserId) {
          try {
            other.send(JSON.stringify({ type: 'kicked', banned: true }));
            other.close(4003, 'banned');
          } catch {}
        }
      }
      return;
    }

    if (data.type === 'unban') {
      const senderInfo = ws.deserializeAttachment();
      if (!senderInfo?.isCreator) return;
      await this.state.storage.delete(`ban:${data.targetUserId}`);
      return;
    }

    // 'offer', 'answer', 'ice-candidate': relay as-is
    this._relayTo(ws, data);
  }

  webSocketClose(ws, code, reason, wasClean) {
    this._relayTo(ws, { type: 'peer-disconnected' });
  }

  webSocketError(ws, error) {
    this._relayTo(ws, { type: 'peer-disconnected' });
  }

  _relayTo(fromWs, data) {
    const msg = JSON.stringify(data);
    for (const ws of this.state.getWebSockets()) {
      if (ws !== fromWs) {
        try { ws.send(msg); } catch {}
      }
    }
  }
}
