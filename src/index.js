import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { connectDb } from './db.js';
import { attachSignalingServer } from './ws/signaling.js';

const PORT = process.env.PORT || 8080;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true
  })
);

// Health check — also useful as an uptime-pinger target to mitigate Render cold starts.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Short-lived TURN relay credentials (Cloudflare Realtime) for peers that
// can't establish a direct P2P path via STUN alone — e.g. either side is
// behind a symmetric/carrier-grade NAT, which is common on mobile networks.
app.get('/api/turn-credentials', async (_req, res) => {
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ttl: 3600 })
      }
    );
    if (!response.ok) throw new Error(`Cloudflare TURN request failed: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Failed to generate TURN credentials:', err);
    res.status(502).json({ error: 'Could not generate TURN credentials' });
  }
});

const server = http.createServer(app);
attachSignalingServer(server, allowedOrigins);

async function start() {
  await connectDb();
  server.listen(PORT, () => {
    console.log(`QuiiCast signaling server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
