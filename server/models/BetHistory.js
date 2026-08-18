/* ═══════════════════════════════════════════
   KINGPIN 3.0 — BetHistory Model (MongoDB)
   Persists bot bet history per account.
   ═══════════════════════════════════════════ */

const mongoose = require('mongoose');

const betHistorySchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true, trim: true },
  issue: { type: String, required: true },
  pred:  { type: String },           // Big / Small
  level: { type: Number },
  amount:   { type: Number },
  won:      { type: Boolean },
  pnl:      { type: Number },
  winAmount:{ type: Number, default: 0 },
  time:     { type: String },
}, {
  timestamps: true,
  collection: 'bet_history',
});

/* Compound index: phone + issue unique — no duplicates */
betHistorySchema.index({ phone: 1, issue: 1 }, { unique: true });

module.exports = mongoose.model('BetHistory', betHistorySchema);
