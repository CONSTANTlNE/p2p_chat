const MAX_RETRIES = 5;
const BACKOFF_BASE = 1000;

export class SignalingChannel extends EventTarget {
  constructor(roomId, identity, isCreator) {
    super();
    this.roomId = roomId;
    this.identity = identity;
    this.isCreator = isCreator;
    this.ws = null;
    this.retries = 0;
    this.closed = false;
    this._pingInterval = null;
  }

  connect() {
    if (this.closed) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ userId: this.identity.userId });
    const url = `${proto}://${location.host}/room/${this.roomId}/ws?${params}`;

    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.retries = 0;
      this.send({ type: 'join', userId: this.identity.userId, name: this.identity.name, isCreator: this.isCreator });
      this._startPing();
      this.dispatchEvent(new Event('open'));
    });

    this.ws.addEventListener('message', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.type === 'pong') return;
      this.dispatchEvent(new MessageEvent('signal', { data }));
    });

    this.ws.addEventListener('close', (e) => {
      this._stopPing();
      if (e.code === 4001) {
        this.dispatchEvent(new CustomEvent('room-full'));
        return;
      }
      if (e.code === 4002) {
        this.dispatchEvent(new CustomEvent('kicked'));
        return;
      }
      if (e.code === 4003) {
        this.dispatchEvent(new CustomEvent('banned'));
        return;
      }
      if (!this.closed) {
        this._scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', () => {
      this._stopPing();
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  close() {
    this.closed = true;
    this._stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _scheduleReconnect() {
    if (this.retries >= MAX_RETRIES) {
      this.dispatchEvent(new CustomEvent('max-retries'));
      return;
    }
    const delay = BACKOFF_BASE * Math.pow(2, this.retries);
    this.retries++;
    this.dispatchEvent(new CustomEvent('reconnecting', { detail: { attempt: this.retries, delay } }));
    setTimeout(() => this.connect(), delay);
  }

  _startPing() {
    this._pingInterval = setInterval(() => {
      this.send({ type: 'ping' });
    }, 20000);
  }

  _stopPing() {
    clearInterval(this._pingInterval);
    this._pingInterval = null;
  }
}
