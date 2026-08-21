/* ═══════════════════════════════════════════
   KINGPIN 3.0 — PredHistory Model (MongoDB)
   Persists prediction history per account.
   ═══════════════════════════════════════════ */

const mongoose = require('mongoose');

const predHistorySchema = new mongoose.Schema({
  platform: { type: String, required: true, default: 'goa', trim: true, lowercase: true },
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

/* Compound index: platform + phone + forIssue unique — no duplicates */
predHistorySchema.index({ platform: 1, phone: 1, forIssue: 1 }, { unique: true });

module.exports = mongoose.model('PredHistory', predHistorySchema);
