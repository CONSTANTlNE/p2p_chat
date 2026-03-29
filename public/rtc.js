const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

const CHUNK_SIZE = 16384;
const MAX_BUFFERED = 1024 * 1024;

export class RTCPeer extends EventTarget {
  constructor(isOfferer, signaling) {
    super();
    this.isOfferer = isOfferer;
    this.signaling = signaling;
    this.pc = null;
    this.channel = null;
    this._makingOffer = false;
    this._pendingCandidates = [];
    this._incoming = new Map();
    this._localStream = null;
    this._remoteStream = null;
  }

  init() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this._remoteStream = new MediaStream();

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signaling.send({ type: 'ice-candidate', candidate });
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      this.dispatchEvent(new CustomEvent('ice-state', { detail: state }));
      if (state === 'failed') this.dispatchEvent(new CustomEvent('ice-failed'));
    };

    this.pc.onconnectionstatechange = () => {
      this.dispatchEvent(new CustomEvent('connection-state', { detail: this.pc.connectionState }));
    };

    this.pc.ontrack = (e) => {
      this._remoteStream.addTrack(e.track);
      this.dispatchEvent(new CustomEvent('remote-track', { detail: this._remoteStream }));
    };

    if (this.isOfferer) {
      this.channel = this.pc.createDataChannel('chat');
      this._setupChannel(this.channel);

      // Only offerer renegotiates (for ICE restarts etc.)
      this.pc.onnegotiationneeded = () => {
        if (!this._makingOffer && this.pc.signalingState === 'stable') {
          this.startOffer();
        }
      };
    } else {
      this.pc.ondatachannel = (e) => {
        this.channel = e.channel;
        this._setupChannel(this.channel);
      };
    }
  }

  _setupChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen  = () => this.dispatchEvent(new CustomEvent('channel-open'));
    channel.onclose = () => this.dispatchEvent(new CustomEvent('channel-close'));
    channel.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        this._handleJsonMessage(data);
      } else {
        this._handleBinaryChunk(e.data);
      }
    };
  }

  _handleJsonMessage(data) {
    if (data.type === 'file-start') {
      this._incoming.set(data.transferId, { meta: data, chunks: new Array(data.totalChunks), received: 0 });
      this.dispatchEvent(new CustomEvent('file-start', { detail: data }));
      return;
    }
    if (data.type === 'file-end') {
      const transfer = this._incoming.get(data.transferId);
      if (!transfer) return;
      const blob = new Blob(transfer.chunks, { type: transfer.meta.mimeType });
      const url = URL.createObjectURL(blob);
      this._incoming.delete(data.transferId);
      this.dispatchEvent(new CustomEvent('file-complete', { detail: { meta: transfer.meta, url } }));
      return;
    }
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  _handleBinaryChunk(buffer) {
    const header = new Uint8Array(buffer, 0, 40);
    const transferId = String.fromCharCode(...header.slice(0, 36));
    const chunkIndex = new DataView(buffer, 36, 4).getUint32(0);
    const payload = buffer.slice(40);
    const transfer = this._incoming.get(transferId);
    if (!transfer) return;
    transfer.chunks[chunkIndex] = payload;
    transfer.received++;
    const progress = Math.round((transfer.received / transfer.meta.totalChunks) * 100);
    this.dispatchEvent(new CustomEvent('file-progress', {
      detail: { transferId, progress, received: transfer.received, total: transfer.meta.totalChunks }
    }));
  }

  async startOffer() {
    if (!this.pc || this._makingOffer) return;
    if (this.pc.signalingState !== 'stable') return;
    this._makingOffer = true;
    try {
      const offer = await this.pc.createOffer();
      if (this.pc.signalingState !== 'stable') return;
      await this.pc.setLocalDescription(offer);
      this.signaling.send({ type: 'offer', sdp: this.pc.localDescription });
    } catch (e) {
      console.error('Offer error:', e);
    } finally {
      this._makingOffer = false;
    }
  }

  async handleSignal(data) {
    if (!this.pc) return;
    try {
      if (data.type === 'offer') {
        // Only answerer should receive offers
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.send({ type: 'answer', sdp: this.pc.localDescription });
        for (const c of this._pendingCandidates) {
          await this.pc.addIceCandidate(new RTCIceCandidate(c));
        }
        this._pendingCandidates = [];

      } else if (data.type === 'answer') {
        if (this.pc.signalingState !== 'have-local-offer') return;
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const c of this._pendingCandidates) {
          await this.pc.addIceCandidate(new RTCIceCandidate(c));
        }
        this._pendingCandidates = [];

      } else if (data.type === 'ice-candidate') {
        if (this.pc.remoteDescription === null) {
          this._pendingCandidates.push(data.candidate);
        } else {
          try {
            await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            if (!this._makingOffer) console.error('ICE candidate error:', e);
          }
        }
      }
    } catch (e) {
      console.error('Signal handling error:', e);
    }
  }

  // ─── Media ──────────────────────────────────────────────────────────────────

  async addMedia(video = true) {
    this._localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { width: 1280, height: 720 } : false
    });

    for (const track of this._localStream.getTracks()) {
      // Reuse existing transceiver of same kind to keep m-line order stable
      const transceiver = this.pc.getTransceivers().find(
        t => t.receiver.track.kind === track.kind
      );
      if (transceiver) {
        await transceiver.sender.replaceTrack(track);
      } else {
        this.pc.addTrack(track, this._localStream);
      }
    }
    return this._localStream;
  }

  removeMedia() {
    if (!this._localStream) return;
    for (const track of this._localStream.getTracks()) {
      track.stop();
    }
    for (const sender of this.pc.getSenders()) {
      if (sender.track) {
        sender.replaceTrack(null).catch(() => {});
      }
    }
    this._localStream = null;
  }

  setAudioMuted(muted) {
    if (!this._localStream) return;
    this._localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }

  setVideoMuted(muted) {
    if (!this._localStream) return;
    this._localStream.getVideoTracks().forEach(t => { t.enabled = !muted; });
  }

  // ─── Data ───────────────────────────────────────────────────────────────────

  send(message) {
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  async sendFile(file, transferId, senderName, senderIsCreator) {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    this.channel.send(JSON.stringify({
      type: 'file-start', transferId,
      name: file.name, size: file.size, mimeType: file.type,
      totalChunks, senderName, senderIsCreator, createdAt: Date.now()
    }));
    const buffer = await file.arrayBuffer();
    for (let i = 0; i < totalChunks; i++) {
      while (this.channel.bufferedAmount > MAX_BUFFERED) {
        await new Promise(r => setTimeout(r, 50));
      }
      const payload = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunk = new ArrayBuffer(40 + payload.byteLength);
      const view = new Uint8Array(chunk);
      for (let j = 0; j < 36; j++) view[j] = transferId.charCodeAt(j);
      new DataView(chunk, 36, 4).setUint32(0, i);
      view.set(new Uint8Array(payload), 40);
      this.channel.send(chunk);
      const progress = Math.round(((i + 1) / totalChunks) * 100);
      this.dispatchEvent(new CustomEvent('file-send-progress', { detail: { transferId, progress } }));
    }
    this.channel.send(JSON.stringify({ type: 'file-end', transferId }));
    return transferId;
  }

  restartIce() {
    if (this.pc && this.isOfferer) this.pc.restartIce();
  }

  get remoteStream() { return this._remoteStream; }

  close() {
    this.removeMedia();
    this._remoteStream = null;
    if (this.channel) { this.channel.close(); this.channel = null; }
    if (this.pc) { this.pc.close(); this.pc = null; }
  }
}
