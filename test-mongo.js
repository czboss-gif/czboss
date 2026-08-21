/* Quick MongoDB connection tester.
   Usage:  node test-mongo.js "mongodb+srv://user:PASSWORD@cluster0.xxxx.mongodb.net/kingpin?..."
   (It masks your password in the output, so it's safe to run.) */
const mongoose = require('mongoose');
const uri = process.argv[2] || process.env.MONGO_URI;
if (!uri) { console.log('Usage: node test-mongo.js "<your full MONGO_URI>"'); process.exit(1); }
console.log('Testing:', uri.replace(/\/\/([^:]+):[^@]+@/, '//$1:****@'));
mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 })
  .then(async () => {
    console.log('✅ CONNECTED!  database =', mongoose.connection.name || '(none — add /kingpin to the URI)');
    await mongoose.disconnect(); process.exit(0);
  })
  .catch(err => { console.log('❌ FAILED:', err.message); process.exit(1); });
