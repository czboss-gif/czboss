/* ═══════════════════════════════════════════════════════════
   KINGPIN — Relogin Diagnostic
   ─────────────────────────────────────────────────────────
   Standalone test for proxy.relogin() — the headless captcha+login
   flow used when a session's token expires mid-run (engine.js
   tryRelogin()). Exercises the REAL captcha/login endpoints for a
   given platform, so you can check after a change (like the track
   timing fix) whether it now succeeds, without waiting for a live
   token to actually expire during a run.

   relogin() already logs each step in detail (proxy.js "[RELOGIN:pid]"
   lines) — this script just calls it directly and prints the result.

   Usage:
     node scripts/test-relogin.js <platform> <phone> <password>
     node scripts/test-relogin.js dhan 9152306499 'mypassword'
     node scripts/test-relogin.js goa  9150306499 'mypassword'
   ═══════════════════════════════════════════════════════════ */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const proxy     = require('../server/proxy');
const platforms = require('../server/platforms');

const [, , platformArg, phone, pwd] = process.argv;

if (!phone || !pwd) {
  console.error('Usage: node scripts/test-relogin.js <platform> <phone> <password>');
  console.error(`  platforms available: ${Object.keys(platforms.PLATFORMS).join(', ')}`);
  process.exit(1);
}

const platform = platforms.resolve(platformArg);
if (!platforms.isValid(platformArg)) {
  console.warn(`[TEST] "${platformArg}" is not a known platform id — defaulting to "${platform}". Valid: ${Object.keys(platforms.PLATFORMS).join(', ')}`);
}

(async () => {
  console.log(`[TEST] Running relogin() against platform="${platform}" phone="${phone}"\n`);
  const t0 = Date.now();
  const result = await proxy.relogin(platform, phone, pwd);
  const ms = Date.now() - t0;

  console.log(`\n[TEST] Finished in ${ms}ms`);
  if (result.ok) {
    console.log(`[TEST] ✅ SUCCESS — lotteryToken: ${result.lotteryToken ? 'received' : 'MISSING'}, webapiToken: ${result.webapiToken ? 'received' : 'MISSING'}`);
  } else {
    console.log(`[TEST] ❌ FAILED — ${result.msg}`);
    console.log('[TEST] The step-by-step "[RELOGIN:' + platform + ']" lines above show exactly where it broke.');
  }
  process.exit(result.ok ? 0 : 1);
})().catch(e => {
  console.error('[TEST] Unhandled error:', e.message);
  process.exit(1);
});
