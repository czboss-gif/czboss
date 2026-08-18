/* ═══════════════════════════════════════════
   KINGPIN 3.0 — Configuration
   All constants, defaults, timings in one place.
   ═══════════════════════════════════════════ */

const KP = {
  /* ── Version ── */
  VERSION: '4.0',

  /* ── Game ── */
  GAME_CODE: 'WinGo',
  GAME_MODE: 'WinGo_30S',   // default mode for new accounts
  CYCLE_MS:  30000,         // legacy fallback (30S) — per-mode values live in MODES

  /* ── Game Modes (per-account selectable) ──
     cycleMs = round length; offset = ms into the epoch-aligned cycle when GOA
     publishes the result (measured live, NOT guessed). */
  /* offset = position (ms) within the cycle, in GOA *server* time (periodInfo uses
     proxy.syncedNow(), NOT local time), where the result publishes / the new period opens.
     At that point the engine-period resets (left=full) and the engine bets EARLY on the
     freshly-opened period with ~full-cycle margin.
       30S → 27000: server-time publish ≈ 26.9s into the 30s window. PROVEN — DO NOT CHANGE.
       1M  → 57000: server-time publish ≈ 57.0s into the minute (probe ~1.8s local + ~355s
                    server-clock skew = ~57s server). Same convention as 30S.
     pollTimeout = how long to wait for the REAL draw result before balance-fallback. THIS was the
                   1M bug: 30s is too short for a 1-minute result (publishes ~60s after the bet) →
                   it timed out → balance fallback → recorded FALSE losses even on correct picks →
                   martingale climbed. 1M needs >cycle (75s). 30S keeps 30000 (unchanged).
     safetyMs / safetyRecoveryMs = skip betting when less than this remains before the next
                   publish/rollover (avoids the boundary). 30S unchanged; 1M a touch wider. */
  MODES: {
    WinGo_30S: { label: '30 SEC', cycleMs: 30000, offset: 27000, pollTimeout: 30000, safetyMs: 5000,  safetyRecoveryMs: 2000 },
    WinGo_1M:  { label: '1 MIN',  cycleMs: 60000, offset: 57000, pollTimeout: 75000, safetyMs: 10000, safetyRecoveryMs: 8000 },
  },

  /* ── Default Martingale Levels ── */
  DEFAULT_LEVELS: [2, 4, 10, 23, 49, 102, 212, 436, 898, 1830],

  /* ── Payout ── */
  WIN_MULTIPLIER: 1.96,

  /* ── Timing ── */
  GOA_PERIOD_OFFSET:  27000,   // synced ms into epoch-30s when GOA publishes results (~27.8-28.3s measured)
  SAFETY_MS:          5000,
  SAFETY_MS_RECOVERY: 2000,
  DRAW_POLL_INTERVAL: 2000,
  DRAW_POLL_TIMEOUT:  30000,
  ENGINE_TICK:        500,

  /* ── Human Delay (anti-detection) ── */
  DELAY_WIN:       [1000, 2000],
  DELAY_LOSS_LV1:  [1000, 2500],
  DELAY_LOSS_REC:  [500,  1500],

  /* ── Formulas ── */
  FORMULAS: {
    dna3:         { name: '🧬 DNA 3',         desc: '3-BS triplet + number/color pattern on 160-deep history',      tags: ['DNA', '160-Deep'] },
    oracle:       { name: '🔮 ORACLE',        desc: 'Adaptive 3-Pillar: N-gram Markov + Run-Momentum + Phase-Lock', tags: ['Adaptive', 'Deep', '3-Pillar'] },
    patdb_v4:     { name: '🎯 PAT_DB v4.0',  desc: '7-layer: Pattern DB + Markov3/2/1 + Streak + Gap + Opposite Rule', tags: ['PAT_DB', '7-Layer'] },
    titan_v3:     { name: '⚡ TITAN v3',      desc: 'Inverted PAT_DB (51.8% proven) + Recovery after 3L + Markov tiebreaker', tags: ['TITAN', 'Recovery'] },
    cobra_strike: { name: '🐍 Cobra Strike', desc: 'DJB2 hash of issue+SIG7 seed → deterministic B/S signal, conf 75-98', tags: ['Hash', 'Deterministic'] },
    itachi:       { name: '🔥 Itachi V30',   desc: 'State Machine (BULL/BEAR/CHOPPY/EXHAUSTION/HARMONIC) + 9-len Pattern DB overlay (70/30 blend)', tags: ['State-ML', '9-PatternDB', 'Multivariate'] },
    kubera:       { name: '💰 Kubera v2',    desc: '6-engine priority cascade: NumTrans + StreakBreak + Ride + Freq + MKV + SmallLean', tags: ['Kubera', '6-Engine', 'Validated'] },
    hacksoon:     { name: '🔮 Hacksoon',     desc: 'Hybrid: patternPrediction + advancedLogic merge (5x-break, zigzag, chaos, dragon)', tags: ['Hybrid', 'Pattern', 'Advanced'] },
    kaala:        { name: '🕶️ Kaala',         desc: '18-engine Oracle v5 cascade: Zigzag(61%) → StrkCont(57%) → MKV_BBS(55%) → NumTrans → Ensemble', tags: ['Kaala', '18-Engine', 'Cascade'] },
    n1n2:         { name: '🎲 N1/N2',        desc: 'Adaptive N1(last) / N2(2nd-last) strategy — switch on loss, parity-aware', tags: ['N1N2', 'Adaptive', 'Switch'] },
    zigzag:       { name: '⚡ ZigZag',       desc: 'Pure BIG↔SMALL toggle — seeds opposite of first result, flips every period', tags: ['ZigZag', 'Toggle', 'Stateful'] },
    zn1p:         { name: '🗳️ ZN1P',          desc: '3-formula majority vote: DhinaS1 + Last Result + ZigZag → 2-of-3 wins', tags: ['ZN1P', 'Majority', '3-Formula'] },
    eip:          { name: '🤖 EIP',           desc: '31-node ensemble: 20 hash traders + 10 lookback traders, auto-selects best active node by accuracy', tags: ['EIP', '31-Node', 'Ensemble'] },
    kutty:        { name: '⭐ KUTTY',         desc: 'Bison-source pair pattern + outcome-driven V1/V2/Emergency state machine, auto-switches mode on loss', tags: ['KUTTY', 'Pattern', 'State-Machine'] },
    kingpin3:     { name: '👑 KINGPIN 3.0',  desc: 'Last 2 numbers → 4 modular candidate formulas, majority BIG/SMALL vote (tie→BIG), confidence by agreement', tags: ['KINGPIN', 'Modular', '4-Vote'] },
    engine11:     { name: '🔱 Matrix 11',    desc: '11-formula ensemble majority vote: Mfreq + Pol + EIP + pattern detectors + RAG + N1/N2 — 2 stateful flip engines', tags: ['Matrix11', 'Ensemble', '11-Vote'] },
    aaab_corrector:{ name: '🔁 AAAB Corrector', desc: 'Fixed S-S-S-B sequence on (period % 4) + Auto-Corrector: WAITs when the last up-to-4 rounds show ZERO sequence matches (pattern inverted)', tags: ['AAAB', 'Sequence', 'Auto-Correct'] },
    n1_auto:      { name: '📋 N1 1Auto',      desc: 'Copy-Cat: predict the last settled result. After any loss, skips exactly one round (WAIT), then resumes', tags: ['N1', 'Copy-Cat', 'Skip-on-Loss'] },

    /* ── 1-MINUTE formulas (mode: WinGo_1M) ── */
    kingpin1m:    { name: '👑 KINGPIN 1M',   desc: 'WinGo 1-Minute engine: Streak Follower (last 3 same → continue) → else Majority Reversal (bet opposite of last-5 majority). Warms up after 5 rounds.', tags: ['KINGPIN', '1-MIN', 'Streak+Majority'], mode: 'WinGo_1M' },
  },
  DEFAULT_FORMULA: 'oracle',

  /* ── UI ── */
  LOG_MAX: 6,
  HISTORY_PAGE_SIZE: 10,
  TOAST_DURATION: 3000,
};

/* ── Mode tagging ──
   Every existing formula is a 30S engine. Stamp any untagged formula as 30S.
   1-minute formulas (added later) must carry mode:'WinGo_1M'. */
for (const _k of Object.keys(KP.FORMULAS)) {
  if (!KP.FORMULAS[_k].mode) KP.FORMULAS[_k].mode = 'WinGo_30S';
}

/* Default formula per mode (1M filled in when its formulas are added) */
KP.DEFAULT_FORMULA_BY_MODE = {
  WinGo_30S: 'oracle',
  WinGo_1M:  'kingpin1m',
};

/* Return only the formulas valid for a given game mode */
KP.formulasForMode = function (mode) {
  const out = {};
  for (const k of Object.keys(KP.FORMULAS)) {
    if ((KP.FORMULAS[k].mode || 'WinGo_30S') === mode) out[k] = KP.FORMULAS[k];
  }
  return out;
};

/* Mode helpers */
KP.modeCycleMs = function (mode) { return (KP.MODES[mode] || KP.MODES[KP.GAME_MODE]).cycleMs; };
KP.modeOffset  = function (mode) { return (KP.MODES[mode] || KP.MODES[KP.GAME_MODE]).offset; };
KP.modePollTimeout = function (mode) {
  return (KP.MODES[mode] || KP.MODES[KP.GAME_MODE]).pollTimeout || KP.DRAW_POLL_TIMEOUT;
};
KP.modeSafetyMs = function (mode, recovery) {
  const m = KP.MODES[mode] || KP.MODES[KP.GAME_MODE];
  if (recovery) return (m.safetyRecoveryMs != null) ? m.safetyRecoveryMs : KP.SAFETY_MS_RECOVERY;
  return (m.safetyMs != null) ? m.safetyMs : KP.SAFETY_MS;
};

module.exports = KP;
