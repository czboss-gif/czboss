/* ═══════════════════════════════════════════
   KINGPIN 3.0 — UserConfig Model (MongoDB)
   Persists per-user configs across restarts.
   Phone number = unique user ID.
   ═══════════════════════════════════════════ */

const mongoose = require('mongoose');

const userConfigSchema = new mongoose.Schema({
  phone: {
    type:     String,
    required: true,
    unique:   true,
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

module.exports = mongoose.model('UserConfig', userConfigSchema);
