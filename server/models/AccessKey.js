/* ═══════════════════════════════════════════
   KINGPIN 3.0 — AccessKey Model (MongoDB)
   One key = one licensed user.
   boundPhone is locked after first successful login.
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
  isDefault: {
    type:    Boolean,
    default: false,
  },
}, {
  timestamps: true,
  collection: 'access_keys',
});

module.exports = mongoose.model('AccessKey', accessKeySchema);
