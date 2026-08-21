/* ═══════════════════════════════════════════════════════════
   KINGPIN — Platform Migration
   ─────────────────────────────────────────────────────────
   One-time migration for the multi-platform change. Existing rows
   predate the `platform` field; this script:

     1. Backfills platform:'goa' on every doc that's missing it, in
        user_configs, bet_history, pred_history, access_keys,
        key_sessions.
     2. Drops the old phone-only unique indexes and builds the new
        platform+phone(+issue/forIssue) compound ones.

   Idempotent — re-running is a no-op once step 1 has nothing left to
   backfill and step 2's indexes already exist in their final shape.

   Per the read-only-prod rule, this is meant to be run against a
   LOCAL copy or an explicit MONGO_URI override first, and only
   pointed at prod once verified. It never touches prod on its own.

   Usage:
     node scripts/migrate-platform.js                 # dry run (reports only)
     node scripts/migrate-platform.js --apply          # writes changes
     MONGO_URI=mongodb://... node scripts/migrate-platform.js --apply
   ═══════════════════════════════════════════════════════════ */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kingpin';

/* field: the name the schema actually uses for "which platform" — most
   collections call it `platform`, but AccessKey calls it `boundPlatform`
   (it's a binding, not a scope) and only makes sense once a phone is
   already bound. Getting this field name wrong silently no-ops the
   backfill: the write succeeds, but on the wrong field, and the one the
   code reads stays empty — which is exactly what happened here on the
   first version of this script (caught by inspecting access_keys after
   an --apply run; fixed before this ran against anything but a local
   dev copy). */
const COLLECTIONS = [
  { name: 'user_configs', field: 'platform',      unique: ['platform', 'phone'] },
  { name: 'bet_history',  field: 'platform',      unique: ['platform', 'phone', 'issue'] },
  { name: 'pred_history', field: 'platform',      unique: ['platform', 'phone', 'forIssue'] },
  { name: 'access_keys',  field: 'boundPlatform', unique: null, filter: { boundPhone: { $ne: null } } },
  { name: 'key_sessions', field: 'platform',      unique: null },
];

async function main() {
  console.log(`[MIGRATE] ${APPLY ? 'APPLY' : 'DRY RUN'} against ${MONGO_URI}`);
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  for (const { name, field, unique, filter } of COLLECTIONS) {
    const col = db.collection(name);
    /* access_keys: only a key someone has actually logged in with
       (boundPhone set) implies a platform — an unbound key has none
       to infer, so leave it null rather than guessing 'goa'. */
    const query = { [field]: { $exists: false }, ...(filter || {}) };
    const missing = await col.countDocuments(query);
    console.log(`[MIGRATE] ${name}: ${missing} doc(s) missing ${field}`);

    if (missing > 0 && APPLY) {
      const res = await col.updateMany(query, { $set: { [field]: 'goa' } });
      console.log(`[MIGRATE] ${name}: backfilled ${res.modifiedCount}`);
    }

    if (!unique) continue;

    /* Drop the old phone-only unique index if present, then ensure the
       new compound one exists. Mongoose's schema.index() call already
       requests the new index at connect time via createIndexes(), so
       this mostly matters for dropping the STALE one that would
       otherwise collide (two accounts, same phone, different platform,
       violating the old single-field unique constraint). */
    const idx = await col.indexes();
    const oldFields = unique.slice(1); // e.g. ['phone'] or ['phone','issue']
    const stale = idx.find(i => {
      const keys = Object.keys(i.key);
      return i.unique && keys.length === oldFields.length && keys.every((k, n) => k === oldFields[n]);
    });
    if (stale) {
      console.log(`[MIGRATE] ${name}: stale unique index found — ${stale.name} (${JSON.stringify(stale.key)})`);
      if (APPLY) {
        await col.dropIndex(stale.name);
        console.log(`[MIGRATE] ${name}: dropped ${stale.name}`);
      }
    } else {
      console.log(`[MIGRATE] ${name}: no stale index to drop`);
    }
  }

  if (!APPLY) {
    console.log('\n[MIGRATE] Dry run only — nothing was written. Re-run with --apply to commit.');
  } else {
    console.log('\n[MIGRATE] Done. New compound indexes will be created automatically the next time the server starts (Mongoose syncs them from the schema).');
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error('[MIGRATE] FAILED:', e.message);
  process.exit(1);
});
