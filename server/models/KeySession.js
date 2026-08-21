/* ═══════════════════════════════════════════
   KINGPIN 3.0 — KeySession Model (MongoDB)
   One row per betting session per user.
   ═══════════════════════════════════════════ */

const mongoose = require('mongoose');

const keySessionSchema = new mongoose.Schema({
  sessionId: {
    type:     String,
    required: true,
    unique:   true,
  },
  key: {
    type:     String,
    required: true,
    index:    true,
    uppercase: true,
  },
  phone: {
    type:     String,
    required: true,
    trim:     true,
  },
  platform: {
    type:    String,
    default: 'goa',
    trim:    true,
    lowercase: true,
  },
  balanceAtLogin: {
    type:    Number,
    default: 0,
  },
  betStartTime: {
    type:    Date,
    default: null,
  },
  betStopTime: {
    type:    Date,
    default: null,
  },
  profit: {
    type:    Number,
    default: 0,
  },
}, {
  timestamps: true,
  collection: 'key_sessions',
});

/* Compound index for quick per-key lookups */
keySessionSchema.index({ key: 1, createdAt: -1 });

module.exports = mongoose.model('KeySession', keySessionSchema);
