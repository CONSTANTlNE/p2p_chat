import { getOrCreateIdentity, saveRoom, getRoom, getRecentRooms, saveContact, saveMessage, getMessages, deleteMessages, saveFile, getFiles, deleteFiles, updateRoomName, deleteRoom, updateIdentityName } from './db.js';
import { SignalingChannel } from './signaling.js';
import { RTCPeer } from './rtc.js';

const MAX_FILE_SIZE = 205 * 1024 * 1024; // 200MB

let identity = null;
let roomId = null;
let signaling = null;
let rtcPeer = null;
let peerInfo = null;
let isOfferer = false;

// call state
let callActive = false;
let callType = null; // 'video' | 'audio'
let micMuted = false;
let camMuted = false;

// Defer incoming WebRTC offers while activateCall() is mid-flight (getUserMedia is async).
// Without this, the answerer may process an offer before their tracks are added, so the
// answer SDP won't include their media and the offerer will never receive remote video.
let _activatingCall = false;
let _pendingSignals = [];

const $ = id => document.getElementById(id);
// Register the same handler on both desktop and mobile variants of a button
function onBtn(id, handler) {
  const el = $(id);
  const elM = $(`${id}-m`);
  if (el) el.addEventListener('click', handler);
  if (elM) elM.addEventListener('click', handler);
}

function showKickBan(visible) {
  const d = visible ? '' : 'none';
  [$('kick-btn'), $('ban-btn'), $('kick-btn-m'), $('ban-btn-m')]
    .forEach(el => { if (el) el.style.display = d; });
}

function showCallButtons(visible) {
  const d = visible ? '' : 'none';
  $('call-btns').style.display = visible ? 'flex' : 'none';
  [$('video-call-btn-m'), $('audio-call-btn-m')]
    .forEach(el => { if (el) el.style.display = d; });
}

// ─── View switching ───────────────────────────────────────────────────────────

function showLanding() {
  $('landing').style.display = '';
  $('chat').style.display = 'none';
}

function showChat() {
  $('landing').style.display = 'none';
  $('chat').style.display = '';
}

// ─── Status bar ──────────────────────────────────────────────────────────────

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}

// ─── Message rendering ───────────────────────────────────────────────────────

function makeBubbleWrapper(own, senderIsCreator, senderName, createdAt) {
  const list = $('message-list');
  const div = document.createElement('div');
  let cls = 'message ' + (own ? 'own' : 'peer');
  if (!own) cls += senderIsCreator ? ' creator-msg' : ' joiner-msg';
  div.className = cls;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = `${own ? 'You' : senderName}  ${time}`;
  div.appendChild(meta);

  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  return div;
}

function renderMessage(msg, own) {
  const div = makeBubbleWrapper(own, msg.senderIsCreator, msg.senderName, msg.createdAt);
  div.dataset.id = msg.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = msg.text;
  div.appendChild(bubble);

  const list = $('message-list');
  list.scrollTop = list.scrollHeight;
}

function renderFileMessage(meta, blobUrl, own) {
  const div = makeBubbleWrapper(own, meta.senderIsCreator, meta.senderName, meta.createdAt);
  div.dataset.transferId = meta.transferId;

  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble-file';

  const isImage = meta.mimeType && meta.mimeType.startsWith('image/');

  if (isImage) {
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = blobUrl;
    img.alt = meta.name;
    img.loading = 'lazy';
    bubble.appendChild(img);
  }

  const fileRow = document.createElement('div');
  fileRow.className = 'file-row';

  const fileInfo = document.createElement('span');
  fileInfo.className = 'file-info';
  fileInfo.textContent = `${meta.name} (${formatSize(meta.size)})`;
  fileRow.appendChild(fileInfo);

  const dl = document.createElement('a');
  dl.className = 'btn-dl';
  dl.href = blobUrl;
  dl.download = meta.name;
  dl.textContent = 'Download';
  fileRow.appendChild(dl);

  bubble.appendChild(fileRow);
  div.appendChild(bubble);

  const list = $('message-list');
  list.scrollTop = list.scrollHeight;
}

function renderFileProgress(transferId, progress, own, meta) {
  // Create or update progress bubble
  let div = document.querySelector(`[data-transfer-id="${transferId}"]`);
  if (!div) {
    div = makeBubbleWrapper(own, meta?.senderIsCreator, meta?.senderName, meta?.createdAt ?? Date.now());
    div.dataset.transferId = transferId;

    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble-file';

    const label = document.createElement('div');
    label.className = 'file-info';
    label.textContent = meta?.name ?? 'File';
    bubble.appendChild(label);

    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    bar.appendChild(fill);
    bubble.appendChild(bar);

    div.appendChild(bubble);
  }

  const fill = div.querySelector('.progress-fill');
  if (fill) fill.style.width = `${progress}%`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadHistory() {
  const list = $('message-list');
  list.innerHTML = '';

  // Merge text messages and file records by createdAt
  const msgs = await getMessages(roomId);
  const files = await getFiles(roomId);

  const items = [
    ...msgs.map(m => ({ ...m, _type: 'text' })),
    ...files.map(f => ({ ...f, _type: 'file' }))
  ].sort((a, b) => a.createdAt - b.createdAt);

  for (const item of items) {
    if (item._type === 'text') {
      renderMessage(item, item.senderId === identity.userId);
    } else {
      const blob = new Blob([item.data], { type: item.mimeType });
      const url = URL.createObjectURL(blob);
      renderFileMessage(item, url, item.senderId === identity.userId);
    }
  }
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage() {
  const input = $('message-input');
  const text = input.value.trim();
  if (!text) return;
  if (!rtcPeer || !rtcPeer.send) {
    setStatus('Not connected', 'error');
    return;
  }

  const msg = {
    id: crypto.randomUUID(),
    roomId,
    senderId: identity.userId,
    senderName: identity.name,
    senderIsCreator: isOfferer,
    text,
    createdAt: Date.now()
  };

  const sent = rtcPeer.send(msg);
  if (!sent) {
    setStatus('Peer not connected yet', 'warn');
    return;
  }

  await saveMessage(msg);
  renderMessage(msg, true);
  input.value = '';
}

// ─── Send file ────────────────────────────────────────────────────────────────

async function sendFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    alert(`File too large. Maximum size is 200 MB.`);
    return;
  }
  if (!rtcPeer || !rtcPeer.channel || rtcPeer.channel.readyState !== 'open') {
    setStatus('Peer not connected yet', 'warn');
    return;
  }

  const transferId = crypto.randomUUID();
  const meta = {
    transferId,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    senderIsCreator: isOfferer,
    senderName: identity.name,
    createdAt: Date.now()
  };

  // Show progress immediately on sender's screen
  renderFileProgress(transferId, 0, true, meta);

  // Send in background — don't await, so progress events fire while it streams
  rtcPeer.sendFile(file, transferId, identity.name, isOfferer).then(async () => {
    // Save to IndexedDB after fully sent
    const data = await file.arrayBuffer();
    await saveFile({
      transferId,
      roomId,
      senderId: identity.userId,
      ...meta,
      data
    });
    // Replace progress bar with final file bubble
    const existing = document.querySelector(`[data-transfer-id="${transferId}"]`);
    if (existing) existing.remove();
    const blobUrl = URL.createObjectURL(new Blob([data], { type: file.type }));
    renderFileMessage(meta, blobUrl, true);
  });
}

// ─── Copy link ────────────────────────────────────────────────────────────────

function copyLink() {
  const url = `${location.origin}/#${roomId}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = $('copy-link');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy invite link'; }, 2000);
  });
}

// ─── Connection setup ─────────────────────────────────────────────────────────

async function startSession(id, offerer) {
  roomId = id;
  isOfferer = offerer;

  showChat();
  $('room-link').textContent = `${location.origin}/#${roomId}`;
  $('peer-name').textContent = 'Waiting for peer...';
  setStatus('Connecting...', 'connecting');

  await loadHistory();
  await updatePeerNameDisplay();

  setupSignaling();
}

function setupSignaling() {
  if (signaling) signaling.close();

  signaling = new SignalingChannel(roomId, identity, isOfferer);

  signaling.addEventListener('open', () => {
    setStatus('Waiting for peer...', 'waiting');
    if (!isOfferer) setupRTC();
  });

  signaling.addEventListener('signal', async (e) => {
    const data = e.data;

    if (data.type === 'peer-joined') {
      peerInfo = { userId: data.userId, name: data.name };
      await saveContact({ id: data.userId, name: data.name });
      $('peer-name').textContent = data.name;
      setStatus('Peer joined, connecting...', 'connecting');
      if (isOfferer) {
        showKickBan(true);
        setupRTC();
        rtcPeer.startOffer();
      }
      return;
    }

    if (data.type === 'peer-disconnected') {
      setStatus('Peer disconnected', 'disconnected');
      $('peer-name').textContent = peerInfo ? peerInfo.name : 'Peer';
      if (isOfferer) showKickBan(false);
      return;
    }

    if (data.type === 'kicked') {
      if (rtcPeer) rtcPeer.close();
      setStatus('You were kicked from this room', 'error');
      return;
    }

    if (rtcPeer) {
      // If we're mid-activateCall (getUserMedia pending), defer offers so our
      // tracks are added before we create the answer — otherwise the answer SDP
      // won't include our media and the remote side never sees our video.
      if (_activatingCall && data.type === 'offer') {
        _pendingSignals.push(data);
        return;
      }
      await rtcPeer.handleSignal(data);
    }
  });

  signaling.addEventListener('room-full', () => {
    showLanding();
    alert('This room is full. Only 2 people can join a room.');
  });

  signaling.addEventListener('kicked', () => {
    if (rtcPeer) rtcPeer.close();
    signaling.close();
    setStatus('You were kicked from this room', 'error');
  });

  signaling.addEventListener('banned', () => {
    if (rtcPeer) rtcPeer.close();
    signaling.close();
    setStatus('You were banned from this room', 'error');
  });

  signaling.addEventListener('reconnecting', (e) => {
    setStatus(`Reconnecting... (attempt ${e.detail.attempt})`, 'connecting');
  });

  signaling.addEventListener('max-retries', () => {
    setStatus('Connection lost. Please refresh.', 'error');
  });

  signaling.connect();
}

function setupRTC() {
  if (rtcPeer) rtcPeer.close();

  rtcPeer = new RTCPeer(isOfferer, signaling);

  rtcPeer.addEventListener('channel-open', () => {
    const name = peerInfo ? peerInfo.name : 'Peer';
    $('peer-name').textContent = name;
    setStatus('Connected', 'connected');
    showCallButtons(true);
  });

  rtcPeer.addEventListener('channel-close', () => {
    setStatus('Peer disconnected', 'disconnected');
    showCallButtons(false);
    if (callActive) { rtcPeer.removeMedia(); callActive = false; callType = null; hideCallPanel(); }
  });

  rtcPeer.addEventListener('remote-track', (e) => {
    $('remote-video').srcObject = e.detail;
    // Show panel on receiver side when tracks arrive
    if (!$('video-panel').classList.contains('show')) showCallPanel();
  });

  rtcPeer.addEventListener('message', async (e) => {
    const msg = e.data ?? e.detail;

    // ── Call signaling over data channel ──
    if (msg.type === 'call-request') {
      showIncomingCall(msg.callType, msg.callerName);
      return;
    }
    if (msg.type === 'call-accepted') {
      // Caller activates their own media now that peer has accepted
      await activateCall(callType === 'video');
      return;
    }
    if (msg.type === 'call-declined') {
      handleCallEnd('declined');
      return;
    }
    if (msg.type === 'call-ended') {
      // If incoming call is still pending, caller cancelled before we answered
      const wasPending = $('incoming-call').classList.contains('show');
      handleCallEnd(wasPending ? 'cancelled' : 'ended');
      return;
    }

    if (peerInfo === null && msg.senderName) {
      peerInfo = { userId: msg.senderId, name: msg.senderName };
      await saveContact({ id: msg.senderId, name: msg.senderName });
      $('peer-name').textContent = msg.senderName;
    }
    await saveMessage(msg);
    renderMessage(msg, false);
  });

  rtcPeer.addEventListener('file-start', (e) => {
    renderFileProgress(e.detail.transferId, 0, false, e.detail);
  });

  rtcPeer.addEventListener('file-progress', (e) => {
    const { transferId, progress } = e.detail;
    const fill = document.querySelector(`[data-transfer-id="${transferId}"] .progress-fill`);
    if (fill) fill.style.width = `${progress}%`;
  });

  rtcPeer.addEventListener('file-complete', async (e) => {
    const { meta, url } = e.detail;
    // Persist to IndexedDB
    const resp = await fetch(url);
    const data = await resp.arrayBuffer();
    await saveFile({
      transferId: meta.transferId,
      roomId,
      senderId: meta.userId ?? 'peer',
      ...meta,
      data
    });
    // Replace progress bubble with final file bubble
    const existing = document.querySelector(`[data-transfer-id="${meta.transferId}"]`);
    if (existing) existing.remove();
    renderFileMessage(meta, url, false);
  });

  rtcPeer.addEventListener('file-send-progress', (e) => {
    const { transferId, progress } = e.detail;
    const fill = document.querySelector(`[data-transfer-id="${transferId}"] .progress-fill`);
    if (fill) {
      fill.style.width = `${progress}%`;
      if (progress === 100) {
        // Show "Sent" label
        const bar = fill.parentElement;
        if (bar) bar.insertAdjacentHTML('afterend', '<div class="file-sent-label">Sent</div>');
        bar.remove();
      }
    }
  });

  rtcPeer.addEventListener('ice-failed', () => {
    setStatus('Connection failed', 'error');
    $('retry-btn').style.display = '';
  });

  rtcPeer.addEventListener('ice-state', (e) => {
    if (e.detail === 'connected' || e.detail === 'completed') {
      $('retry-btn').style.display = 'none';
    }
  });

  rtcPeer.init();
}

async function updatePeerNameDisplay() {
  if (peerInfo) {
    $('peer-name').textContent = peerInfo.name;
  }
}

// ─── Call logic ───────────────────────────────────────────────────────────────

function startCall(withVideo) {
  // Only send the request — no media added until peer accepts
  callType = withVideo ? 'video' : 'audio';
  callActive = false; // becomes true once accepted by both sides
  rtcPeer.send({ type: 'call-request', callType, callerName: identity.name });
  setStatus('Calling…', 'connecting');
}

async function activateCall(withVideo) {
  // Called on BOTH sides once the call is accepted.
  // Gate incoming offers so our tracks are in place before we create an answer.
  _activatingCall = true;
  let stream;
  try {
    stream = await rtcPeer.addMedia(withVideo);
  } catch {
    _activatingCall = false;
    await _flushPendingSignals();
    alert('Could not access ' + (withVideo ? 'camera/microphone' : 'microphone') + '. Please check permissions.');
    return false;
  }
  _activatingCall = false;
  await _flushPendingSignals();

  callActive = true;
  $('local-video').srcObject = stream;
  $('toggle-cam-btn').style.display = withVideo ? '' : 'none';
  showCallPanel();
  return true;
}

async function _flushPendingSignals() {
  if (!rtcPeer) { _pendingSignals = []; return; }
  const pending = _pendingSignals.splice(0);
  for (const sig of pending) {
    await rtcPeer.handleSignal(sig);
  }
}

function showCallPanel() {
  $('video-panel').classList.add('show');
  showCallButtons(false);
  // Re-attach remote stream in case srcObject was cleared by the previous call end.
  // ontrack won't fire again for reused transceivers (replaceTrack path), so we
  // must restore it manually when showing the panel for a second call.
  if (rtcPeer && rtcPeer.remoteStream && rtcPeer.remoteStream.getTracks().length > 0) {
    $('remote-video').srcObject = rtcPeer.remoteStream;
  }
}

function hideCallPanel() {
  $('video-panel').classList.remove('show');
  $('remote-video').srcObject = null;
  $('local-video').srcObject = null;
  showCallButtons(true);
  micMuted = false;
  camMuted = false;
  $('toggle-mic-btn').classList.remove('muted');
  $('toggle-mic-btn').textContent = '🎙️';
  $('toggle-cam-btn').classList.remove('muted');
  $('toggle-cam-btn').textContent = '📹';
}

function handleCallEnd(reason) {
  if (rtcPeer) rtcPeer.removeMedia();
  callActive = false;
  callType = null;
  hideCallPanel();
  hideIncomingCall();
  const peerName = peerInfo?.name ?? 'Peer';
  let msg, cls;
  if (reason === 'ended') { msg = 'Call ended'; cls = 'waiting'; }
  else if (reason === 'declined') { msg = `${peerName} declined the call`; cls = 'disconnected'; }
  else if (reason === 'cancelled') { msg = 'Call cancelled'; cls = 'waiting'; }
  else { msg = 'Call ended'; cls = 'waiting'; }
  setStatus(msg, cls);
  // Revert to "Connected" after 3 seconds if still connected
  setTimeout(() => {
    if (rtcPeer && rtcPeer.channel && rtcPeer.channel.readyState === 'open') {
      setStatus('Connected', 'connected');
    }
  }, 3000);
}

function endCall() {
  if (rtcPeer) rtcPeer.send({ type: 'call-ended' });
  handleCallEnd('ended');
}

function showIncomingCall(type, callerName) {
  $('incoming-call-label').textContent = `Incoming call from ${callerName}`;
  $('incoming-call-type').textContent = type === 'video' ? '📹 Video Call' : '🎙️ Audio Call';
  $('incoming-call').classList.add('show');
  // Store for accept handler
  $('incoming-call').dataset.callType = type;
}

function hideIncomingCall() {
  $('incoming-call').classList.remove('show');
}

// ─── Landing page actions ─────────────────────────────────────────────────────

async function createRoom() {
  const id = crypto.randomUUID();
  await saveRoom({ id, createdAt: Date.now(), name: `Room ${id.slice(0, 8)}`, isCreator: true });
  location.hash = id;
}

async function joinRoom(id) {
  const existing = await getRoom(id);
  if (existing) {
    await startSession(id, !!existing.isCreator);
  } else {
    await saveRoom({ id, createdAt: Date.now(), name: `Room ${id.slice(0, 8)}`, isCreator: false });
    await startSession(id, false);
  }
}

// ─── Recent rooms ─────────────────────────────────────────────────────────────

async function renderRecentRooms() {
  const rooms = await getRecentRooms(5);
  const list = $('recent-rooms');
  list.innerHTML = '';
  if (rooms.length === 0) {
    list.innerHTML = '<li class="empty">No recent rooms</li>';
    return;
  }
  for (const room of rooms) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/#${room.id}`;
    a.className = room.isCreator ? 'room-creator' : 'room-participant';

    const badge = document.createElement('span');
    badge.className = `room-badge ${room.isCreator ? 'creator' : 'participant'}`;
    badge.textContent = room.isCreator ? 'Host' : 'Guest';

    const name = document.createElement('span');
    name.textContent = room.name || room.id.slice(0, 8);

    a.appendChild(badge);
    a.appendChild(name);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = room.id;
    });
    li.appendChild(a);
    list.appendChild(li);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  identity = await getOrCreateIdentity();

  $('create-room-btn').addEventListener('click', createRoom);
  onBtn('copy-link', copyLink);

  $('send-btn').addEventListener('click', sendMessage);
  $('message-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // File attach
  const fileInput = $('file-input');
  $('attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) sendFile(file);
    fileInput.value = '';
  });

  $('retry-btn').addEventListener('click', () => {
    $('retry-btn').style.display = 'none';
    if (rtcPeer) rtcPeer.restartIce();
  });

  // ── Call buttons ──
  $('video-call-btn').addEventListener('click', () => startCall(true));
  $('audio-call-btn').addEventListener('click', () => startCall(false));
  $('video-call-btn-m').addEventListener('click', () => startCall(true));
  $('audio-call-btn-m').addEventListener('click', () => startCall(false));

  $('accept-call-btn').addEventListener('click', async () => {
    const type = $('incoming-call').dataset.callType;
    hideIncomingCall();
    callType = type;
    const ok = await activateCall(type === 'video');
    if (!ok) {
      rtcPeer.send({ type: 'call-declined' });
      callType = null;
      return;
    }
    rtcPeer.send({ type: 'call-accepted', callType: type });
  });

  $('decline-call-btn').addEventListener('click', () => {
    // If we're the callee (incoming-call is showing) → declined; if caller cancels via end-call → cancelled
    const isIncoming = $('incoming-call').classList.contains('show');
    rtcPeer.send({ type: isIncoming ? 'call-declined' : 'call-ended' });
    handleCallEnd(isIncoming ? 'cancelled' : 'cancelled');
  });

  $('end-call-btn').addEventListener('click', endCall);

  $('toggle-mic-btn').addEventListener('click', () => {
    micMuted = !micMuted;
    rtcPeer.setAudioMuted(micMuted);
    $('toggle-mic-btn').classList.toggle('muted', micMuted);
    $('toggle-mic-btn').textContent = micMuted ? '🔇' : '🎙️';
  });

  $('toggle-cam-btn').addEventListener('click', () => {
    camMuted = !camMuted;
    rtcPeer.setVideoMuted(camMuted);
    $('toggle-cam-btn').classList.toggle('muted', camMuted);
    $('toggle-cam-btn').textContent = camMuted ? '🚫' : '📹';
  });

  // Drag & drop (desktop only — overlay hidden on mobile via CSS)
  let dragCounter = 0;
  const chatEl = $('chat');
  const dropOverlay = $('drop-overlay');

  chatEl.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.add('active');
  });
  chatEl.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); }
  });
  chatEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
  });
  chatEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (file) sendFile(file);
  });

  onBtn('kick-btn', () => {
    if (!peerInfo) return;
    if (!confirm(`Kick ${peerInfo.name}?`)) return;
    signaling.send({ type: 'kick', targetUserId: peerInfo.userId });
    if (rtcPeer) rtcPeer.close();
    peerInfo = null;
    showKickBan(false);
    setStatus('Waiting for peer...', 'waiting');
  });

  onBtn('ban-btn', () => {
    if (!peerInfo) return;
    if (!confirm(`Ban ${peerInfo.name}? They won't be able to rejoin.`)) return;
    signaling.send({ type: 'ban', targetUserId: peerInfo.userId });
    if (rtcPeer) rtcPeer.close();
    peerInfo = null;
    showKickBan(false);
    setStatus('Waiting for peer...', 'waiting');
  });

  onBtn('rename-btn', async () => {
    const room = await getRoom(roomId);
    const name = prompt('Room name:', room?.name || '');
    if (name && name.trim()) {
      await updateRoomName(roomId, name.trim());
    }
  });

  onBtn('delete-btn', async () => {
    if (!confirm('Delete this chat and all its messages?')) return;
    if (signaling) signaling.close();
    if (rtcPeer) rtcPeer.close();
    await deleteRoom(roomId);
    location.hash = '';
    showLanding();
    await renderRecentRooms();
  });

  onBtn('clear-btn', async () => {
    if (!confirm('Delete all messages in this chat?')) return;
    await deleteMessages(roomId);
    await deleteFiles(roomId);
    $('message-list').innerHTML = '';
  });

  onBtn('leave-btn', () => {
    if (signaling) signaling.close();
    if (rtcPeer) rtcPeer.close();
    location.hash = '';
    showLanding();
    renderRecentRooms();
  });

  $('my-name').textContent = identity.name;
  $('my-name').addEventListener('click', async () => {
    const name = prompt('Enter your name:', identity.name);
    if (name && name.trim()) {
      identity.name = name.trim();
      await updateIdentityName(identity.name);
      $('my-name').textContent = identity.name;
    }
  });

  const hash = location.hash.slice(1);
  if (hash && /^[0-9a-f-]{36}$/.test(hash)) {
    await joinRoom(hash);
  } else {
    showLanding();
    await renderRecentRooms();
  }

  window.addEventListener('hashchange', async () => {
    const h = location.hash.slice(1);
    if (h && /^[0-9a-f-]{36}$/.test(h)) {
      if (signaling) signaling.close();
      if (rtcPeer) rtcPeer.close();
      peerInfo = null;
      await joinRoom(h);
    } else {
      if (signaling) signaling.close();
      if (rtcPeer) rtcPeer.close();
      showLanding();
      await renderRecentRooms();
    }
  });
}

init().catch(console.error);
