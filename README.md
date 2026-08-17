# QuiiCast signaling backend

Node/Express/`ws` signaling server. Relays WebRTC offer/answer/ICE messages between a caster and up to 5 concurrent receivers paired by a 4-digit OTP, backed by MongoDB for OTP/session storage with TTL expiry.

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI and ALLOWED_ORIGINS
npm run dev
```

## Protocol (JSON over WebSocket)

The caster maintains a separate `RTCPeerConnection` per receiver (mesh, not an SFU). Messages routed to the caster are tagged with `receiverId` so it knows which connection they belong to; a receiver only ever has one connection (to the caster), so the server strips that tag before forwarding to it.

**Caster → server**
- `{ type: 'start-cast', mode: 'internet' | 'lan' }` → server replies `{ type: 'otp-created', otp, expiresInMinutes, mode, maxReceivers }`
- `{ type: 'refresh-otp' }` → generates a new OTP for the *same* session (same sessionId/room) and replies with another `otp-created` — existing receivers are untouched, only the code shown to new joiners changes
- `{ type: 'offer', receiverId, sdp }` → relayed to that receiver
- `{ type: 'ice-candidate', receiverId, candidate }` → relayed to that receiver
- `{ type: 'stop-cast' }` → ends the session for every connected receiver

**Receiver → server**
- `{ type: 'join', otp }` → server replies `{ type: 'joined', mode }` or `{ type: 'error', message }`
- `{ type: 'answer', sdp }` → relayed to the caster, tagged with this receiver's id
- `{ type: 'ice-candidate', candidate }` → relayed to the caster, tagged with this receiver's id
- `{ type: 'set-quality', quality }` → relayed to the caster (tagged); caster applies it via `RTCRtpSender.setParameters` on that receiver's connection only (no renegotiation)

**Server → caster**
- `{ type: 'receiver-joined', receiverId }` — a new receiver validated its OTP; caster should create a peer connection for it
- `{ type: 'receiver-left', receiverId }` — that receiver disconnected; the cast keeps running for everyone else
- `{ type: 'error', message }`

**Server → receiver**
- `{ type: 'peer-left' }` — the caster ended the cast
- `{ type: 'error', message }`

OTPs stay valid for the whole TTL window (`OTP_TTL_MINUTES`, default 10) rather than being single-use, which is what allows more than one receiver to join with the same code. That trade-off is mitigated by: the short default TTL, a hard cap of 5 concurrent receivers per session (`MAX_RECEIVERS` in `src/ws/signaling.js`), and per-IP rate limiting on join attempts (in-memory, single-instance).

## Deploy notes

Deploy as a normal persistent Node process (e.g. Render free Web Service) — not a serverless function, since those don't support long-lived WebSocket connections. See root `README.md` for the full deployment plan.
