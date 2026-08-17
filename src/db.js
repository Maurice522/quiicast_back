import dns from 'dns';
import mongoose from 'mongoose';

// Node's resolver can fail on mongodb+srv:// lookups when the system DNS
// server is an IPv6 link-local address (some Windows setups). Fall back to
// a public resolver so the SRV/TXT lookups Atlas needs can succeed.
dns.setServers(['8.8.8.8', '1.1.1.1']);

export async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }
  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err);
  });
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');
}
