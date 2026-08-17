// Simple in-memory sliding-window rate limiter for OTP join attempts.
// Good enough for a single-instance free-tier deployment; not shared across
// processes, so it resets if the server restarts or is scaled out.
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 20;

const attemptsByIp = new Map();

export function isRateLimited(ip) {
  const now = Date.now();
  const entry = attemptsByIp.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attemptsByIp.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_ATTEMPTS_PER_WINDOW;
}

// Periodically drop stale entries so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attemptsByIp) {
    if (now - entry.windowStart > WINDOW_MS) attemptsByIp.delete(ip);
  }
}, WINDOW_MS).unref();
