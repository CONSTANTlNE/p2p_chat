# P2P Chat

A private, end-to-end encrypted peer-to-peer chat application built on WebRTC and Cloudflare Workers. No messages are stored on any server — all data lives on your device.

**Live app: [chat.ews.ge](https://chat.ews.ge/)**

![Home screen](docs/screenshots/home.png)

## Features

- **Peer-to-peer messaging** — direct connection between two users, no server relay
- **Audio & video calls** — full WebRTC media with independent audio/video tracks
- **File transfer** — send files up to 100MB via chunked data channel with progress tracking
- **Room-based sessions** — shareable URLs using UUID room IDs
- **Local-first storage** — messages, files, and identity persisted in IndexedDB only
- **Room moderation** — room creator can kick or ban users
- **No account required** — auto-generated identity on first visit

## Architecture

```
Browser A  ──── WebSocket signaling ────  Cloudflare Workers (Durable Object)
    │                                                │
    └─────────────── WebRTC (P2P) ──────────────── Browser B
```

The Cloudflare Worker handles WebSocket signaling and room state (capacity enforcement, bans). Once the WebRTC connection is established, all messages, calls, and file transfers flow directly between peers.

**Stack:**
- **Frontend** — Vanilla JavaScript, HTML5, CSS3 (no build step)
- **Backend** — Cloudflare Workers + Durable Objects (SQLite)
- **P2P** — WebRTC data channels and media streams
- **Storage** — Dexie.js (IndexedDB wrapper)
- **Deploy** — Wrangler (Cloudflare CLI)

## Getting Started

**Prerequisites:** A [Cloudflare account](https://dash.cloudflare.com/sign-up) and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

```bash
# Install Wrangler if needed
npm install -g wrangler

# Authenticate
wrangler login

# Run locally
wrangler dev

# Deploy to production
wrangler deploy
```

Local dev runs at `http://localhost:8787`.

## Project Structure

```
webchat/
├── wrangler.toml          # Cloudflare Workers configuration
├── worker/
│   ├── index.js           # HTTP request router
│   └── room.js            # Durable Object — room state, bans, signaling relay
└── public/
    ├── index.html         # App markup and styles
    ├── chat.js            # Main application logic
    ├── signaling.js       # WebSocket signaling channel
    ├── rtc.js             # WebRTC peer connection management
    └── db.js              # IndexedDB operations (Dexie)
```

## Screenshots

| Chat | Video call | File transfer |
|------|------------|---------------|
| ![Chat view](docs/screenshots/chat.png) | ![Video call](docs/screenshots/video-call.png) | ![File transfer](docs/screenshots/file-transfer.png) |

## How It Works

1. **Create or join a room** — rooms are identified by UUID in the URL hash (`/#<uuid>`)
2. **Signaling** — both peers connect via WebSocket through the Cloudflare Worker, which relays SDP offers/answers and ICE candidates
3. **P2P connection** — once negotiated, the Worker is no longer in the data path
4. **Local persistence** — messages and transferred files are saved to IndexedDB

Rooms support a maximum of two peers. The first peer becomes the creator (offerer); the second is the participant (answerer).

## Privacy

- No user accounts or registration
- No server-side message storage
- All chat history and files stored locally in the browser
- Room creator identity is not transmitted to any server

## Configuration

`wrangler.toml` — no changes required for basic deployment:

```toml
name = "p2p-chat"
main = "worker/index.js"
compatibility_date = "2024-01-01"

[assets]
directory = "public"
binding = "ASSETS"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "RoomDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RoomDO"]
```

## License

MIT
