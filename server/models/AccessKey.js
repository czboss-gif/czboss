/* ═══════════════════════════════════════════
   KINGPIN — AccessKey Model (MongoDB)
   One key = one licensed account on one platform.
   boundPhone + boundPlatform are locked together on first successful
   login — a key is scoped to a single platform, matching how it'd be
   sold/billed. To run both GOA and Dhani on the same phone number,
   issue two keys. DEFAULT_KEY bypasses binding entirely, on either.
   ═══════════════════════════════════════════ */

const mongoose = require('mongoose');

const accessKeySchema = new mongoose.Schema({
  key: {
    type:     String,
    required: true,
    unique:   true,
    trim:     true,
    uppercase: true,
  },
  label: {
    type:    String,
    default: 'User',
    trim:    true,
  },
  enabled: {
    type:    Boolean,
    default: true,
  },
  boundPhone: {
    type:    String,
    default: null,
    trim:    true,
  },
  /* Platform this key is locked to, set together with boundPhone on
     first login. Null (unbound key) has no platform yet either. */
  boundPlatform: {
    type:    String,
    default: null,
    trim:    true,
    lowercase: true,
  },
  isDefault: {
    type:    Boolean,
    default: false,
  },
}, {
  timestamps: true,
  collection: 'access_keys',
});

module.exports = mongoose.model('AccessKey', accessKeySchema);
