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
