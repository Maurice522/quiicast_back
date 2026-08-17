import { WebSocketServer } from 'ws';
import { Session } from '../models/Session.js';
import { generateUniqueOtp } from '../lib/otp.js';
import { isRateLimited } from '../lib/rateLimit.js';

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
// Each receiver is a separate peer connection on the caster's side (mesh, not
// an SFU) — the caster's own upload bandwidth/CPU is the real ceiling here.
const MAX_RECEIVERS = 5;

// sessionId -> { casterWs, mode, receivers: Map<receiverId, WebSocket> }
const rooms = new Map();
// ws -> { sessionId, role, receiverId? }
const socketMeta = new WeakMap();

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress;
}

async function handleStartCast(ws, msg) {
  const mode = msg.mode === 'lan' ? 'lan' : 'internet';
  const otp = await generateUniqueOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  const session = await Session.create({
    otp,
    casterSocketId: crypto.randomUUID(),
    status: 'waiting',
    mode,
    expiresAt
  });

  const sessionId = session._id.toString();
  rooms.set(sessionId, { casterWs: ws, mode, receivers: new Map() });
  socketMeta.set(ws, { sessionId, role: 'caster' });

  send(ws, { type: 'otp-created', otp, expiresInMinutes: OTP_TTL_MINUTES, mode, maxReceivers: MAX_RECEIVERS });
}

// Generates a new OTP for the caster's *existing* session — the sessionId
// (and therefore the room, and every already-connected receiver's routing)
// stays untouched. Used when the previous OTP expired: existing viewers keep
// watching uninterrupted, but a fresh code is needed for anyone new to join.
async function handleRefreshOtp(ws) {
  const meta = socketMeta.get(ws);
  if (!meta || meta.role !== 'caster') return;

  const room = rooms.get(meta.sessionId);
  if (!room) return;

  const otp = await generateUniqueOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  await Session.findByIdAndUpdate(meta.sessionId, { otp, expiresAt, status: 'waiting' });

  send(ws, { type: 'otp-created', otp, expiresInMinutes: OTP_TTL_MINUTES, mode: room.mode, maxReceivers: MAX_RECEIVERS });
}

async function handleJoin(ws, msg, ip) {
  if (isRateLimited(ip)) {
    send(ws, { type: 'error', message: 'Too many attempts. Please wait a few minutes and try again.' });
    return;
  }

  const otp = String(msg.otp || '').trim();
  // The OTP stays valid (and shareable with more than one receiver) for the
  // whole TTL window rather than being single-use — see MAX_RECEIVERS above
  // and the short default TTL for the security trade-off this implies.
  const session = await Session.findOne({ otp, status: 'waiting' });

  if (!session || session.expiresAt < new Date()) {
    send(ws, { type: 'error', message: 'Invalid or expired code.' });
    return;
  }

  const sessionId = session._id.toString();
  const room = rooms.get(sessionId);
  if (!room || !room.casterWs || room.casterWs.readyState !== room.casterWs.OPEN) {
    send(ws, { type: 'error', message: 'The caster is no longer available.' });
    return;
  }

  if (room.receivers.size >= MAX_RECEIVERS) {
    send(ws, { type: 'error', message: 'This cast already has the maximum number of viewers.' });
    return;
  }

  const receiverId = crypto.randomUUID();
  room.receivers.set(receiverId, ws);
  socketMeta.set(ws, { sessionId, role: 'receiver', receiverId });

  send(ws, { type: 'joined', mode: room.mode });
  send(room.casterWs, { type: 'receiver-joined', receiverId });
}

// Caster → a specific receiver. The caster tags outgoing offer/ice-candidate
// messages with the receiverId they belong to (it may be juggling several
// concurrent peer connections); we strip that tag before forwarding since a
// receiver only ever has one connection, to the caster.
function relayFromCaster(ws, msg) {
  const meta = socketMeta.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.sessionId);
  if (!room) return;

  const receiverWs = room.receivers.get(msg.receiverId);
  if (!receiverWs) return;

  const { receiverId, ...rest } = msg;
  send(receiverWs, rest);
}

// Receiver → caster. We tag the message with the sender's own receiverId
// (from server-side state, not client input) so the caster knows which of
// its several peer connections the message belongs to.
function relayFromReceiver(ws, msg) {
  const meta = socketMeta.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.sessionId);
  if (!room || !room.casterWs) return;

  send(room.casterWs, { ...msg, receiverId: meta.receiverId });
}

async function closeSession(sessionId) {
  rooms.delete(sessionId);
  await Session.findByIdAndUpdate(sessionId, { status: 'closed' }).catch(() => {});
}

async function handleClose(ws) {
  const meta = socketMeta.get(ws);
  if (!meta) return;

  const room = rooms.get(meta.sessionId);

  if (meta.role === 'caster') {
    if (room) {
      for (const receiverWs of room.receivers.values()) {
        send(receiverWs, { type: 'peer-left' });
      }
    }
    await closeSession(meta.sessionId);
  } else if (room) {
    room.receivers.delete(meta.receiverId);
    send(room.casterWs, { type: 'receiver-left', receiverId: meta.receiverId });
  }

  socketMeta.delete(ws);
}

export function attachSignalingServer(server, allowedOrigins = []) {
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, callback) => {
      if (allowedOrigins.length === 0) return callback(true);
      const origin = info.origin || info.req.headers.origin;
      callback(allowedOrigins.includes(origin));
    }
  });

  wss.on('connection', (ws, req) => {
    const ip = getClientIp(req);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', message: 'Malformed message.' });
        return;
      }

      try {
        switch (msg.type) {
          case 'start-cast':
            await handleStartCast(ws, msg);
            break;
          case 'join':
            await handleJoin(ws, msg, ip);
            break;
          case 'stop-cast':
            await handleClose(ws);
            break;
          case 'refresh-otp':
            await handleRefreshOtp(ws);
            break;
          case 'offer':
          case 'answer':
          case 'ice-candidate':
          case 'set-quality': {
            const meta = socketMeta.get(ws);
            if (meta?.role === 'caster') {
              relayFromCaster(ws, msg);
            } else {
              relayFromReceiver(ws, msg);
            }
            break;
          }
          default:
            send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
        }
      } catch (err) {
        console.error('Signaling error:', err);
        send(ws, { type: 'error', message: 'Server error, please try again.' });
      }
    });

    ws.on('close', () => {
      handleClose(ws).catch((err) => console.error('Cleanup error:', err));
    });
  });

  return wss;
}
