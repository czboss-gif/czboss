/* ═══════════════════════════════════════════
   KINGPIN 3.0 — PredHistory Model (MongoDB)
   Persists prediction history per account.
   ═══════════════════════════════════════════ */

const mongoose = require('mongoose');

const predHistorySchema = new mongoose.Schema({
  phone:    { type: String, required: true, index: true, trim: true },
  forIssue: { type: String, required: true },
  pred:     { type: String },           // BIG / SMALL
  formula:  { type: String },
  time:     { type: String },
  result:   { type: String, default: null },    // BIG / SMALL / null
  correct:  { type: Boolean, default: null },
}, {
  timestamps: true,
  collection: 'pred_history',
});

/* Compound index: phone + forIssue unique — no duplicates */
predHistorySchema.index({ phone: 1, forIssue: 1 }, { unique: true });

module.exports = mongoose.model('PredHistory', predHistorySchema);
