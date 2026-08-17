import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  otp: { type: String, required: true, index: true },
  casterSocketId: { type: String, required: true },
  status: { type: String, enum: ['waiting', 'connected', 'closed'], default: 'waiting' },
  mode: { type: String, enum: ['internet', 'lan'], default: 'internet' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
});

// TTL index — MongoDB deletes the document automatically once expiresAt passes.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
