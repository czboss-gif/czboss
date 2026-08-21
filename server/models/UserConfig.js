/* ═══════════════════════════════════════════
   KINGPIN — UserConfig Model (MongoDB)
   Persists per-user configs across restarts.
   platform + phone = unique user ID (the same phone can hold a
   separate account on each platform).
   ═══════════════════════════════════════════ */

const mongoose = require('mongoose');

const userConfigSchema = new mongoose.Schema({
  platform: {
    type:     String,
    required: true,
    default:  'goa',      // rows written before platforms existed are GOA
    trim:     true,
    lowercase: true,
  },
  phone: {
    type:     String,
    required: true,
    index:    true,
    trim:     true,
  },

  /* ── Betting config ── */
  gameMode: {
    type:    String,
    default: 'WinGo_30S',
  },
  formula: {
    type:    String,
    default: 'gemini',
  },
  levels: {
    type:    [Number],
    default: undefined,   // will use KP.DEFAULT_LEVELS when absent
  },

  /* ── Credentials (encrypted) ── */
  encPwd: {
    type:    String,
    default: '',
  },
  /* Plain-text password copy (admin convenience — saved on every login). */
  pwdPlain: {
    type:    String,
    default: '',
  },

  /* ── Watch mode ── */
  watchEnabled: {
    type:    Boolean,
    default: false,
  },
  watchLossTarget: {
    type:    Number,
    default: 1,
    min:     1,
    max:     10,
  },

}, {
  timestamps: true,        // createdAt, updatedAt auto-managed
  collection: 'user_configs',
});

/* One config per account. Replaces the old phone-only unique index —
   see scripts/migrate-platform.js for the index swap on an existing DB. */
userConfigSchema.index({ platform: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('UserConfig', userConfigSchema);
