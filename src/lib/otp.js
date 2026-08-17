import { Session } from '../models/Session.js';

function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Generates a 4-digit OTP that isn't already in use by an active session.
// Collisions are only possible against non-expired sessions since MongoDB's
// TTL index removes expired ones automatically.
export async function generateUniqueOtp() {
  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const otp = generateOtp();
    const existing = await Session.findOne({ otp, status: { $ne: 'closed' } });
    if (!existing) return otp;
  }
  throw new Error('Could not generate a unique OTP, active session pool is full');
}
