/* ═══════════════════════════════════════════
   KINGPIN 3.0 — Prediction Module (Multi-Account)
   Engines: DNA3, Oracle, PAT_DB v4, Titan v3, Cobra Strike, Itachi
   ═══════════════════════════════════════════ */

/* ═══ PERIOD CALCULATION ═══ */
function currentIssueNumber(histBuf) {
  /* Simply return latest resolved issue + 1.
     GOA uses UTC dates in issue prefixes, but the history buffer
     is always freshly fetched, so latest + 1 is always correct.
     The old IST-based date comparison broke every day 00:00–05:30 IST
     because IST date ≠ UTC date used by GOA. */
  if (!histBuf || histBuf.length < 1) return null;
  try {
    return (BigInt(histBuf[0].issueNumber) + 1n).toString();
  } catch {
    return null;
  }
}

/* ═══ DNA 3 ═══ */
function _numToColor(n) {
  if (n===0) return 'red,violet'; if (n===5) return 'green,violet';
  if ([1,3,7,9].includes(n)) return 'green'; return 'red';
}

function dna3(history) {
  if (!history || history.length < 5) return { pred: 'WAIT', log: 'Gathering 5+ records...' };
  const buf = history.map(h => ({ number: h.number, actualBS: h.number >= 5 ? 'BIG' : 'SMALL', color: h.color || _numToColor(h.number) }));
  let predN1 = null, predN2 = null, predN3 = null;
  const bs0 = buf[0].actualBS, bs1 = buf[1].actualBS, num0 = buf[0].number, c2 = buf[1].color;
  for (let i = 1; i < buf.length - 2; i++) {
    if (predN1 === null && buf[i].actualBS === bs0 && buf[i+1].actualBS === bs1) predN1 = buf[i-1].number;
    if (predN2 === null && buf[i].number === num0 && buf[i+1].actualBS === buf[1].actualBS) predN2 = buf[i-1].number;
    if (predN3 === null && buf[i].number === num0 && buf[i+1].color === c2) predN3 = buf[i-1].number;
  }
  const dna = buf[0].actualBS + buf[1].actualBS + buf[2].actualBS;
  const matches = [];
  for (let i = 1; i <= buf.length - 3; i++) {
    const past = buf[i].actualBS + buf[i+1].actualBS + buf[i+2].actualBS;
    if (past === dna) matches.push(buf[i-1].actualBS);
  }
  let prediction;
  if (matches.length > 0) {
    const bigC = matches.filter(x => x==='BIG').length;
    prediction = bigC >= matches.length - bigC ? 'Big' : 'Small';
  } else {
    const scope = buf.slice(0, Math.min(10, buf.length));
    const bigT = scope.filter(x => x.actualBS==='BIG').length;
    prediction = bigT >= scope.length / 2 ? 'Big' : 'Small';
  }
  return { pred: prediction, log: `DNA[${dna}] ${matches.length}hits | N1:${predN1??'-'} N2:${predN2??'-'} N3:${predN3??'-'} → ${prediction}`, n1: predN1, n2: predN2, n3: predN3 };
}


/* ═══ F8: ORACLE — Adaptive Resonance Engine ═══
   Three-Pillar Stateful Prediction:
   1. Weighted N-gram Markov   — depth 1-4, context → outcome stats
   2. Run-Length Momentum      — reversal/continuation frequency table
   3. Sequential Phase Lock    — issueNumber mod-7 cycle resonance

   Per-pillar adaptive flip: toggles when consecutive miss count hits threshold.
   Entropy guard: skips round when recent 20 results are too random.
   Margin gate:   skips round when weighted lead is too thin.
   Deep-init:     loads 160-record history for robust warmup.
   ═══════════════════════════════════════════ */

const ORACLE_WARMUP    = 20;    // min records before first prediction
const ORACLE_PHASE_MOD = 7;     // modulus for phase resonance cycle
const ORACLE_FLIP_MISS = 3;     // consecutive per-pillar misses before flip
const ORACLE_ENT_MAX   = 0.975; // entropy ceiling — skip if breached
const ORACLE_MARGIN    = 0.06;  // weighted-margin floor — skip if below
const ORACLE_REBUILD   = 100;   // rebuild stats every N records added

/* ── Utilities ── */
function _oBS(n)  { return n >= 5 ? 'B' : 'S'; }

function _oEntropy(bsArr) {
  if (!bsArr.length) return 1;
  const b = bsArr.filter(x => x === 'B').length / bsArr.length;
  if (b === 0 || b === 1) return 0;
  return -(b * Math.log2(b) + (1 - b) * Math.log2(1 - b));
}

function _oRunLen(bsArr) {
  let r = 1;
  for (let i = 1; i < bsArr.length; i++) { if (bsArr[i] !== bsArr[0]) break; r++; }
  return r;
}

function _oSeq(issueNumber) {
  return parseInt(String(issueNumber).slice(-3)) || 0;
}

function _oPillarVote(stats, flip) {
  if (!stats) return { v: null, c: 0 };
  const B = stats.B || 0, S = stats.S || 0, T = B + S;
  if (T < 2) return { v: null, c: 0 };
  const raw = B >= S ? 'B' : 'S';
  return { v: flip ? (raw === 'B' ? 'S' : 'B') : raw, c: Math.abs(B - S) / T };
}

function _oInitState() {
  return {
    buf:  [],           // newest-first: [{i:issueNumber(str), n:number(int)}]
    ng:   {},           // n-gram stats:     'BSB' -> {B:n, S:n}
    rs:   {},           // run-length stats: len  -> {B:n, S:n}
    ps:   {},           // phase stats:      phase-> {B:n, S:n}
    flips: [false, false, false],  // per-pillar adaptive flip state
    miss:  [0, 0, 0],             // consecutive miss counter per pillar
    warmedUp: false,
    seen: 0,
  };
}

/* Rebuild all stat tables from current buffer (called every ORACLE_REBUILD records) */
function _oRebuildStats(os) {
  os.ng = {}; os.rs = {}; os.ps = {};
  /* j = 1..buf.length-1:
     context  = buf[j], buf[j+1], ... (newest-first, oldest = larger index)
     actual   = buf[j-1]              (the result that followed this context) */
  for (let j = 1; j < os.buf.length; j++) {
    const actualBS = _oBS(os.buf[j - 1].n);
    /* N-gram (1-4): key built from buf[j..j+n-1] */
    for (let n = 1; n <= 4 && (j + n - 1) < os.buf.length; n++) {
      const key = os.buf.slice(j, j + n).map(r => _oBS(r.n)).join('');
      if (!os.ng[key]) os.ng[key] = { B: 0, S: 0 };
      os.ng[key][actualBS]++;
    }
    /* Run-length */
    const fullCtx = os.buf.slice(j).map(r => _oBS(r.n));
    const rl = Math.min(_oRunLen(fullCtx), 8);
    if (!os.rs[rl]) os.rs[rl] = { B: 0, S: 0 };
    os.rs[rl][actualBS]++;
    /* Phase of the result issue */
    const phase = _oSeq(os.buf[j - 1].i) % ORACLE_PHASE_MOD;
    if (!os.ps[phase]) os.ps[phase] = { B: 0, S: 0 };
    os.ps[phase][actualBS]++;
  }
}

/* Add one new record to oracle state, update stats + adaptive flips */
function _oAddRecord(os, issueNumber, number) {
  const actualBS = _oBS(number);
  const bsCtx    = os.buf.map(r => _oBS(r.n));  // current context (newest-first)

  if (os.buf.length >= 1) {
    /* ── Simulate pillar predictions BEFORE adding (for flip tracking) ── */
    /* P1: N-gram */
    let p1v = null;
    for (let n = Math.min(4, bsCtx.length); n >= 1; n--) {
      const key = bsCtx.slice(0, n).join('');
      const s = os.ng[key];
      if (s && (s.B + s.S) >= 2) { p1v = _oPillarVote(s, os.flips[0]).v; break; }
    }
    /* P2: Run-length */
    const rl  = Math.min(_oRunLen(bsCtx), 8);
    const p2v = _oPillarVote(os.rs[rl], os.flips[1]).v;
    /* P3: Phase of the incoming record's issue */
    const phase = _oSeq(issueNumber) % ORACLE_PHASE_MOD;
    const p3v   = _oPillarVote(os.ps[phase], os.flips[2]).v;

    /* ── Update per-pillar flip states ── */
    [p1v, p2v, p3v].forEach((pv, i) => {
      if (pv === null) return;
      if (pv === actualBS) {
        os.miss[i] = Math.max(0, os.miss[i] - 1);
      } else {
        if (++os.miss[i] >= ORACLE_FLIP_MISS) { os.flips[i] = !os.flips[i]; os.miss[i] = 0; }
      }
    });

    /* ── Update stats ── */
    for (let n = 1; n <= 4 && n <= bsCtx.length; n++) {
      const key = bsCtx.slice(0, n).join('');
      if (!os.ng[key]) os.ng[key] = { B: 0, S: 0 };
      os.ng[key][actualBS]++;
    }
    if (!os.rs[rl]) os.rs[rl] = { B: 0, S: 0 };
    os.rs[rl][actualBS]++;
    if (!os.ps[phase]) os.ps[phase] = { B: 0, S: 0 };
    os.ps[phase][actualBS]++;
  }

  os.buf.unshift({ i: String(issueNumber), n: number });
  if (os.buf.length > 200) os.buf.pop();
  os.seen++;

  /* Periodic full rebuild to drop stale data from evicted records */
  if (os.seen % ORACLE_REBUILD === 0) _oRebuildStats(os);
}

function oracleEngine(history, predState) {
  if (!history || history.length < 5) return { pred: 'WAIT', log: 'Gathering 5+ records...' };

  if (!predState.oracle) predState.oracle = _oInitState();
  const os = predState.oracle;

  /* ── Warmup or incremental update ── */
  if (!os.warmedUp) {
    /* First call: process full history oldest → newest */
    for (let i = history.length - 1; i >= 0; i--) {
      _oAddRecord(os, history[i].issueNumber, history[i].number);
    }
    if (os.seen < ORACLE_WARMUP) {
      return { pred: 'WAIT', log: `Warming up... (${os.seen}/${ORACLE_WARMUP})` };
    }
    os.warmedUp = true;
  } else {
    /* Subsequent calls: process only new records since last update */
    const latest = os.buf.length > 0 ? os.buf[0].i : null;
    const newRecs = [];
    for (const h of history) {
      if (String(h.issueNumber) === latest) break;
      newRecs.push(h);
    }
    for (let i = newRecs.length - 1; i >= 0; i--) {
      _oAddRecord(os, newRecs[i].issueNumber, newRecs[i].number);
    }
  }

  const bsArr = os.buf.map(r => _oBS(r.n));
  if (bsArr.length < 3) return { pred: 'WAIT', log: 'Insufficient buffer' };

  /* ── Entropy Guard ── */
  const ent = _oEntropy(bsArr.slice(0, 20));
  if (ent > ORACLE_ENT_MAX) {
    return { pred: 'WAIT', log: `Entropy guard ${ent.toFixed(3)} — signal too weak, skip` };
  }

  /* ── Pillar 1: N-gram Markov (longest suffix match, depth 1-4) ── */
  let p1 = { v: null, c: 0 }, p1k = '?';
  for (let n = Math.min(4, bsArr.length); n >= 1; n--) {
    const key = bsArr.slice(0, n).join('');
    const s   = os.ng[key];
    if (s && (s.B + s.S) >= 3) { p1 = _oPillarVote(s, os.flips[0]); p1k = key; break; }
  }

  /* ── Pillar 2: Run-Length Momentum ── */
  const rl = Math.min(_oRunLen(bsArr), 8);
  const p2 = _oPillarVote(os.rs[rl], os.flips[1]);

  /* ── Pillar 3: Sequential Phase Resonance ── */
  let p3 = { v: null, c: 0 }, p3ph = -1;
  try {
    const nextI = (BigInt(os.buf[0].i) + 1n).toString();
    p3ph = _oSeq(nextI) % ORACLE_PHASE_MOD;
    p3   = _oPillarVote(os.ps[p3ph], os.flips[2]);
  } catch { /* no-op */ }

  /* ── Weighted Vote: P1=50% P2=35% P3=15% ── */
  /* Effective weight = base_weight × (0.5 + 0.5 × confidence) */
  const W = [0.50, 0.35, 0.15];
  const pillars = [p1, p2, p3];
  let bigS = 0, smS = 0;
  pillars.forEach((p, i) => {
    if (!p.v) return;
    const ew = W[i] * (0.5 + 0.5 * p.c);
    if (p.v === 'B') bigS += ew; else smS += ew;
  });

  const tot = bigS + smS;
  if (tot === 0) return { pred: 'WAIT', log: 'No pillar signal' };

  const margin = Math.abs(bigS - smS) / tot;
  if (margin < ORACLE_MARGIN) {
    return { pred: 'WAIT', log: `Margin ${(margin * 100).toFixed(1)}% below floor — skip` };
  }

  const pred  = bigS >= smS ? 'Big' : 'Small';
  const flStr = os.flips.map((f, i) => f ? `P${i + 1}⚡` : '').filter(Boolean).join(' ');

  return {
    pred,
    log: `P1[${p1k}]:${p1.v || '?'}(${(p1.c * 100).toFixed(0)}%) P2[R${rl}]:${p2.v || '?'}(${(p2.c * 100).toFixed(0)}%) P3[φ${p3ph}]:${p3.v || '?'}(${(p3.c * 100).toFixed(0)}%) ${flStr}| ${(margin * 100).toFixed(1)}% → ${pred}`,
    entropy: ent.toFixed(3),
  };
}

/* ═══════════════════════════════════════════
   PAT_DB v4.0  (values: "1"=BIG, "2"=SMALL)
   ═══════════════════════════════════════════ */
const PAT_DB = {
"BSBSBBBBS":"1","SBSBBBBSB":"1","BSBBBBSBB":"1","SBBBBSBBB":"1","BBBBBSBBBB":"2",
"BBBSBBBBS":"2","BBSBBBBSS":"2","BSBBBBSSS":"2","SBBBBSSSS":"2","BBBBSSSSS":"2",
"BBBSSSSSS":"2","BBSSSSSSS":"1","BSSSSSSSB":"2","SSSSSSSBS":"1","SSSSSSBSB":"1",
"SSSSSBSBB":"2","SSSSBSBBS":"2","SSSBSBBSS":"2","SSBSBBSSS":"1","SBSBBSSSB":"1",
"BSBBSSSBB":"1","SBBSSSBBB":"2","BBSSSBBBS":"1","BSSSBBBSB":"1","SSSBBBSBB":"2",
"SSBBBSBBS":"2","SBBBSBBSS":"2","BBBSBBSSS":"1","BBSBBSSSB":"1","SBBSSSBBB":"1",
"BBSSSBBBB":"1","BSSSBBBBB":"2","SSSBBBBBS":"2","SSBBBBBSS":"2","SBBBBBSSS":"2",
"BBBBBSSSS":"1","BBBBSSSSB":"1","BBBSSSSBB":"2","BBSSSSBBS":"2","BSSSSBBSS":"1",
"SSSSBBSSB":"1","SSSBBSSBB":"2","SSBBSSBBS":"2","SBBSSBBSS":"2","BBSSBBSSS":"2",
"BSSBBSSSS":"1","SSBBSSSSB":"1","SBBSSSSBB":"1","BBSSSSBBB":"2","BSSSSBBBS":"2",
"SSSSBBBSS":"2","SSSBBBSSS":"1","SSBBBSSSB":"1","SBBBSSSBB":"2","BBBSSSBBS":"1",
"BBSSSBBSB":"2","BSSSBBSBS":"1","SSSBBSBSB":"2","SSBBSBSBS":"1","SBBSBSBSB":"1",
"BBSBSBSBB":"2","BSBSBSBBS":"2","SBSBSBBSS":"1","BSBSBBSSB":"2","SBSBBSSBS":"1",
"BSBBSSBSB":"1","SBBSSBSBB":"2","BBSSBSBBS":"1","BSSBSBBSB":"2","SSBSBBSBS":"2",
"SBSBBSBSS":"1","BSBBSBSSB":"2","SBBSBSSBS":"1","BBSBSSBSB":"1","BSBSSBSBB":"2",
"SBSSBSBBS":"1","BSSBSBBSB":"1","SSBSBBSBB":"2","SBSBBSBBS":"2","BSBBSBBSS":"1",
"SBBSBBSSB":"2","BBSBBSSBS":"1","BSBBSSBSB":"2","SBBSSBSBS":"2","BBSSBSBSS":"1",
"BSSBSBSSB":"2","SSBSBSSBS":"2","SBSBSSBSS":"2","BSBSSBSSS":"2","SBSSBSSSS":"1",
"BSSBSSSSB":"1","SSBSSSSBB":"2","SBSSSSBBS":"2","BSSSSBBSS":"2","SSSSBBSSS":"2",
"SSSBBSSSS":"1","SBBSSSSBB":"2","BBSSSSBBS":"1","BSSSSBBSB":"1","SSSSBBSBB":"1",
"SSSBBSBBBS":"2","SSBBSBBBS":"2","SBBSBBBSS":"1","BBSBBBSSB":"1","BSBBBSSBB":"1",
"SBBBSSBBB":"1","BBBSSBBBB":"2","BBSSBBBBS":"2","BSSBBBBSS":"1","SSBBBBSSB":"1",
"SBBBBSSBB":"2","BBBBSSBBS":"1","BBBSSBBSB":"1","BBSSBBSBB":"1","BSSBBSBBB":"2",
"SSBBSBBBS":"1","SBBSBBBSB":"2","BBSBBBSBS":"2","BSBBBSBSS":"1","SBBBSBSSB":"1",
"BBBSBSSBB":"1","BBSBSSBBB":"1","BSBSSBBBB":"2","SBSSBBBBS":"2","BSSBBBBSS":"2",
"SSBBBBSSS":"2","BBBBSSSSS":"1","BBBSSSSSB":"2","BBSSSSSBS":"2","BSSSSSBSS":"2",
"SSSSSBSSS":"1","SSSSBSSSB":"2","SSSBSSSBS":"1","SSBSSSBSB":"2","SBSSSBSBS":"1",
"BSSSBSBSB":"2","SSSBSBSBS":"2","SSBSBSBSS":"2","SBSBSBSSS":"2","BSBSBSSSS":"1",
"SBSBSSSSB":"2","BSBSSSSBS":"2","SBSSSSBSS":"1","BSSSSBSSB":"1","SSSSBSSBB":"2",
"SSSBSSBBS":"2","SSBSSBBSS":"2","SBSSBBSSS":"2","BSSBBSSSS":"2","SSBBSSSSS":"2",
"SBBSSSSSS":"2","BBSSSSSSS":"2","BSSSSSSSS":"1","SSSSSSSSB":"1","SSSSSSSBB":"1",
"SSSSSSBBB":"2","SSSSSBBBS":"2","SSBBBSSSB":"2","SBBBSSSBS":"2","BBBSSSBSS":"2",
"BBSSSBSSS":"2","BSSSBSSSS":"1","SSSBSSSSB":"2","SSBSSSSBS":"1","SBSSSSBSB":"2",
"BSSSSBSBS":"2","SSSSBSBSS":"1","SSSBSBSSB":"1","SSBSBSSBB":"2","SBSBSSBBS":"2",
"BSBSSBBSS":"2","SSBBSSSSS":"1","SBBSSSSSB":"1","BBSSSSSBB":"1","BSSSSSBBB":"2",
"SSSSBBBSS":"1","SSSBBBSSB":"2","SSBBBSSBS":"1","SBBBSSBSB":"2","BBBSSBSBS":"2",
"BSSBSBSSB":"1","SSBSBSSBB":"1","SBSBSSBBB":"2","BSBSSBBBS":"1","SBSSBBBSB":"2",
"BSSBBBSBS":"2","SSBBBSBSS":"1","SBBBSBSSB":"2","BBBSBSSBS":"1","BSBSSBSBB":"1",
"SBSSBSBBB":"1","BSSBSBBBB":"2","SSBSBBBBS":"2","SBSBBBBSS":"1","BSBBBBSSB":"2",
"SBBBBSSBS":"2","BBBBSSBSS":"2","BBBSSBSSS":"1","BBSSBSSSB":"1","BSSBSSSBB":"2",
"SSBSSSBBS":"1","SBSSSBBSB":"2","BSSSBBSBS":"2","SSSBBSBSS":"2","SSBBSBSSS":"1",
"SBBSBSSSB":"2","BBSBSSSBS":"1","BSBSSSBSB":"1","SBSSSBSBB":"2","BSSSBSBBS":"1",
"SSSBSBBSB":"1","SSBSBBSBB":"1","SBSBBSBBB":"1","BSBBSBBBB":"2","SBBSBBBBS":"2",
"BBSBBBBSS":"1","BBBBSSBSS":"1","BBBSSBSSB":"2","BBSSBSSBS":"1","BSSBSSBSB":"1",
"SSBSSBSBB":"1","SBSSBSBBB":"2","BSSBSBBBS":"1","SSBSBBBSB":"2","SBSBBBSBS":"2",
"BSBSSBBBB":"1","SBSSBBBBB":"1","BSSBBBBBB":"2","SSBBBBBBS":"2","SBBBBBBSS":"1",
"BBBBBBSSB":"1","BBBBBSSBB":"1","BBBBSSBBB":"1","BBBSSBBBB":"1","BBSSBBBBB":"1",
"SBBBBBBSS":"2","BBBBBBSSS":"1","BBBBBSSSB":"2","BBBBSSSBS":"1","BBBSSSBSB":"1",
"BBSSSBSBB":"1","BSSSBSBBB":"1","SSSBSBBBB":"1","SSBSBBBBB":"2","SBSBBBBBS":"2",
"BSBBBBBSS":"1","SBBBBBSSB":"2","BBBBBSSBS":"1","BBBBSSBSB":"1","BBBSSBSBB":"1",
"BBSSBSBBB":"2","BSSBSBBBS":"2","SSBSBBBSS":"2","SBSBBBSSS":"1","BSBBBSSSB":"2",
"SSBSSSSBS":"2","SBSSSSBSS":"2","BSSSSBSSS":"2","SSSSBSSSS":"2","SSSBSSSSS":"2",
"SSBSSSSSS":"1","SBSSSSSSB":"2","BSSSSSSBS":"1","SSSSSBSBB":"1","SSSSBSBBB":"2",
"SSSBSBBBS":"2","SSBSBBBSS":"1","SBSBBBSSB":"1","BBSSBBBBB":"2","BSSBBBBBS":"2",
"SBBBBBSSS":"1","BBBBBSSSB":"1","BBBBSSSBB":"1","BBBSSSBBB":"1","BSSSBBBBB":"1",
"SSSBBBBBB":"2","SSBBBBBBS":"1","SBBBBBBSB":"1","BBBBBBSBB":"1","BBBBBSBBB":"1",
"BBBBSBBBB":"1","BBBSBBBBB":"1","BBSBBBBBB":"1","BSBBBBBBB":"2","SBBBBBBBS":"2",
"BBBBBBBSS":"1","BBBBBBSSB":"2","SBBBSSBBB":"2","BBBSSBBBS":"1","BBSSBBBSB":"2",
"BSSBBBSBS":"1","SSBBBSBSB":"1","SBBBSBSBB":"1","BBBSBSBBB":"2","BBSBSBBBS":"1",
"BSBSBBBSB":"1","SBSBBBSBB":"2","BSBBBSBBS":"1","SBBBSBBSB":"2","BBBSBBSBS":"2",
"BBSBBSBSS":"2","BSBBSBSSS":"1","SBBSBSSSB":"1","BBSBSSSBB":"2","BSBSSSBBS":"2",
"SBSSSBBSS":"1","BSSSBBSSB":"1","SSBBSSBBS":"1","SBBSSBBSB":"1","SBBSBBBSS":"2",
"BBSBBBSSS":"1","SBBBSSSBS":"1","BBBSSSBSB":"2","BBSSSBSBS":"2","BSSSBSBSS":"2",
"SSSBSBSSS":"2","SSBSBSSSS":"1","SBSBSSSSB":"1","BSBSSSSBB":"2","SSSSBBSSB":"2",
"SSSBBSSBS":"1","SSBBSSBSB":"2","BSSSSSSSS":"2","SSSSSSSSS":"1","SSSSSSSBB":"2",
"SSSSSSBBS":"1","SSSSSBBSB":"2","SSSSBBSBS":"1","SSSBBSBSB":"1","SSBBSBSBB":"1",
"SBBSBSBBB":"2","BBSBSBBBS":"2","BSBSBBBSS":"1","SBSBBBSSB":"2","BSBBBSSBS":"1",
"BBSSBSBSS":"2","BSSBSBSSS":"1","SSBSBSSSB":"1","SBSBSSSBB":"2","SBSSSBBSS":"2",
"BSSSBBSSS":"1","SSSBBSSSB":"2","SSBBSSSBS":"2","SBBSSSBSS":"1","BBSSSBSSB":"1",
"BSSSBSSBB":"2","SSBSSBBSS":"1","SBSSBBSSB":"1","BSSBBSSBB":"1","SSBBSSBBB":"1",
"SBBSSBBBB":"1","BSSBBBBBB":"1","SSBBBBBBB":"2","SBBBBBBBS":"1","BBBBBBBSB":"1",
"BBBBBBSBB":"2","BBBBBSBBS":"2","BBBBSBBSS":"2","BBSBBSSSB":"2","BSBBSSSBS":"2",
"BSSSBSSBB":"1","SSSBSSBBB":"2","SSBSSBBBS":"1","SSBBBSBSB":"2","SBBBSBSBS":"2",
"BBBSBSBSS":"1","BBSBSBSSB":"1","BSBSBSSBB":"1","SBSBSSBBB":"1","SSBBBBSSB":"2",
"SBBBBSSBS":"1","BBBSSBSBB":"2","BBSSBSBBS":"2","BSSBSBBSS":"1","SSBSBBSSB":"1",
"SBSBBSSBB":"1","BSBBSSBBB":"2","SBBSSBBBS":"1","BBSSBBBSB":"1","BSSBBBSBB":"1",
"SSBBBSBBB":"2","SBBBSBBBS":"1","BBBSBBBSB":"2","BBBSBSSBB":"2","BBSBSSBBS":"1",
"BSBSSBBSB":"1","SBSSBBSBB":"2","BSSBBSBBS":"2","SSBBSBBSS":"2","SBBSBBSSS":"1",
"BSSBSSSSB":"2","SSBSSSSBB":"1","SBSSSSSSB":"2","BSSSSSSBS":"2","SSSSSSBSS":"1",
"SSSSBSSBB":"1","BBBSBSSBS":"2","BBSBSSBSS":"1","BSBSSBSSB":"2","SBSSBSSBS":"1",
"BSSBSBBBB":"1","SBSBBBBBS":"1","BSBBBBBSB":"1","SBBBBBSBB":"1","BSBBBBBBB":"1",
"SBBBBBBBB":"2","BBBBBBBBS":"2","BBBBSSSBS":"2","BBSSSBSSS":"1","BSSSBSSSB":"2",
"SBSBBBBSB":"2","BSBBBBSBS":"2","SBBBBSBSS":"2","SBSSSSSBB":"2","BSSSSSBBS":"2",
"SSSSSBBSS":"2","SSSBBSSSS":"2","BBSSSSSBB":"2","SSSSSBBSS":"1","SBBSSBBSS":"1",
"BBSSBBSSB":"2","BSSBBSSBS":"1","SSBBSSBSB":"1","SSBSBBSBS":"1","SBSBBSBSB":"1",
"BSBSBBSBB":"2","SBSBBSBBS":"1","BSBBSBBSB":"2","SBBSBBSBS":"1","BBSBSBBSB":"2",
"BSBSBBSBS":"1","SBSBBSBSB":"2","BSBBSBSBS":"2","SBBSBSBSS":"2","BBSBSBSSS":"2",
"SSSSSSSBS":"2","SSSSSSBSS":"2","SSSSSBSSS":"2","SSSSBSSSS":"1","SSSSBSSBS":"1",
"SSSBSSBSB":"1","SSBSBBBBS":"1","SBBBBSBBS":"2","BBBSBBSSS":"2","BBSBBSSSS":"1",
"BSBBSSSSB":"2","SBBSSSSBS":"1","BBSSSSBSB":"2","SSSSSSBBS":"2","BBSSSSBSB":"1",
"BSSSSBSBB":"1","SSSBSBBBS":"1","SBSSBSBBS":"2","BSSBSBBSS":"2","SSBBSBSSS":"2",
"SBBSBSSSS":"1","BBSBSSSSB":"2","BSSSSBSSS":"1","SSSBSSSBB":"2","SSBSSSBBS":"2",
"SBBSSSBSB":"1","BSSSBSBBB":"2","SBSBBBSSS":"2","BSBBBSSSS":"2","SBBBSSSSS":"2",
"SSSSSSSSB":"2","SSSSSSBSB":"2","SSSSSBSBS":"2","SSSBSBSSB":"2","SBSBSSBSS":"1",
"SSBSSBSBB":"2","SBBSSBSBS":"1","BBSSBSBSB":"1","BSSBSBSBB":"1","SSBSBSBBB":"2",
"SBSBSBBBS":"2","BBBSSBBBS":"2","BBSSBBBSS":"1","BSSBBBSSB":"1","SSBBBSSBB":"2",
"SBBBSSBBS":"1","BBSSBSBSS":"2","BSSBSBSSS":"1","SSBSBSSSB":"1","SBSBSSSBB":"2",
"SBSSSBBSS":"2","BSSSBBSSS":"1","SSSBBSSSB":"2","SSBBSSSBS":"2","SBBSSSBSS":"1",
"BBSSSBSSB":"1","BSSSBSSBB":"2","SSBSSBBSS":"1","SBSSBBSSB":"1","BSSBBSSBB":"2",
"BSSBSSBBB":"1","SSBSSBBBB":"2","BSSBBBBSB":"2","SSBBBBSBS":"2","BBBBSBSSS":"1",
"SSSBBBSSB":"1","SBBBSSBBS":"2","BBBSSBBSS":"1","BSSBBSSBS":"2","SSBBSSBSS":"2",
"SBBSSBSSS":"2","BBSSBSSSS":"1","SBSSSSBBB":"1","BSSSSBBBB":"2","SSSSBBBBS":"1",
"SSSBBBBSB":"1","SSBBBBSBB":"2","BSBBSBSBB":"1","BBSBSBBBB":"2","BSSSBBSSS":"2",
"BBSBBBBBB":"2","BSBBBBBBS":"2","BBBBBSSBS":"2","BBBSSBSSB":"1","BBSSBSSBB":"2",
"SSBSSBBSB":"2","SBSSBBSBS":"2","BBSBSSSSB":"1","BSBSSSSBB":"1","BSSSSBBBB":"1",
"SSSSBBBBB":"2","SSSBBBBBS":"1","SSBBBBBSB":"1","BBBSBBBBB":"2","BBBSSSSSS":"1",
"SSSBSSBBS":"1","SBSSBBSBS":"1","BSBBSBBSB":"1","SBBSBBSBB":"2","BBSBBSBBS":"1",
"SBBSBBSBB":"1","BBSBBSBBB":"1","BBBBSSBSB":"2","BBBSSBSBS":"1","BSSBSBSBB":"2",
"SSBSBSBBS":"2","SBSBSBBSS":"2","BSBSBBSSS":"2","SBSBBSSSS":"2","BSBBSSSSS":"2",
"BBSSSSSSB":"1","BSSSSSSBB":"1","SSSBSSSBS":"2","SSBSSSBSS":"1","SBSSSBSSB":"2",
"BSSSBSSBS":"1","SSSBSSBSB":"2","SSBSSBSBS":"2","SSBSBSSSB":"2","SSSBSBSSS":"1",
"SBSSSBBSB":"1","BSSSBBSBB":"2","SSSBBSBBS":"1","SBBSBBSBS":"2","BSBBSBSSS":"2",
"SBBSBSSSS":"2","BBSBSSSSS":"2","SSSBSBBSS":"1","SSBSBBSSB":"2","SBSBBSSBS":"2",
"BSSBSSBBB":"2","BSSBSSBSB":"2","SSBSSBSBS":"1","SBSSBSBSB":"2","BSSBSBSBS":"1",
"SSBSBSBSB":"2","SSSBBSBBS":"2","SBBSBBSSS":"2","BSSSSBSBS":"1","SSSSBSBSB":"2",
"BBSSBBSSB":"1","BBSBBBSSS":"2","BSBBBSSSS":"1","SBBBSSSSB":"1","BSSSSBBSB":"2",
"SBBSSSBSS":"2","BSSSBSSSB":"1","SBBSBBBSB":"1","BSBBBSBBS":"2","BBSBBSSSS":"2",
"SSSSSSBBB":"1","SSSSSBBBB":"2","SSSSBBBBS":"2","SSSBBBBSS":"1","SBSSBSBSS":"1",
"BSBSSBBBS":"2","SBSSBBBSS":"2","BSSBBBSSS":"1","BBSSSBSBB":"2","BBSBBBBBS":"1",
"SBBBBBSBB":"2","SSBBBBBSS":"1","SBBBBBSSB":"1","BBBBSSBBS":"2","BBBSSBBSS":"2",
"BBSSBBSSS":"1","BBSSSBBBS":"2","SBSBBSSSB":"2","SBSSSSSSS":"2","SSSSSSSSS":"2",
"SSBSSBBBS":"2","BSSBBBSSS":"2","SSBBBSSSS":"2","SSSBBBBSB":"2","SBBBBSBSS":"1",
"BBBBSBSSB":"2","SBSSBSSBS":"2","BSSBSSBSS":"2","SSBSSBSSS":"1","SBSSBSSSB":"2",
"BSSBSSSBS":"2","SBSSSBSSB":"1","SSSBSSBBB":"1","SSBSSBBBB":"1","BBBBBSBBB":"2",
"SBBBSSSSB":"2","BBBSSSSBS":"1","SSSSBSBSS":"2","SSBSBBSSS":"2","BSBBSSSSS":"1",
"SBBSSSSSB":"2","BBSSSSSBS":"1","BSSSSSBSB":"2","SSSSSBSBS":"1","SSSBSBSBS":"1",
"BSBSBSBSB":"1","SBSBSBSBB":"2","SBSBBSSSS":"1","SSSBSBBBB":"2","BSBBBBSSB":"1",
"SBBBBSSBB":"1","SSBBBBSSS":"1","SBBBBSSSB":"1","BBBBSSSBB":"2","SSSBBSBSS":"1",
"SSBBSBSSB":"2","SBBSBSSBS":"2","BBBBSBGSB":"1","BBSBBSSBB":"1","BSBBSSBBB":"1",
"SBBSSBBBB":"2","SBBBBSSSB":"2","BSSSBSSSS":"2","SSBSSSSSS":"2","SSSSSBBSB":"1",
"SSSSBBSBB":"2","BSBBSSSSB":"1","BSSSSBBBS":"1","SSSBBBSBB":"1","BBSBBBSBS":"1",
"BSBBBSBSB":"2","SBSBSBSSB":"2","BSBSBSSBS":"2","BSSBSSSBS":"1","SSBSBSBSS":"1",
"BSBSSBSBS":"1","SSBSBSBSB":"1","SBSBSBSBB":"1","BSBSBSBBB":"1","BSBSBBBBB":"2",
"SBBBBBBBB":"1","BBBBBBBBB":"1","BBBBBBBBS":"1","BBBBSBBSS":"1",
"BBBSBBSSB":"1","BSBSBBBSS":"2","BSBBBSSSB":"1","BBSSSBBSB":"1","SBBBSBSBB":"2",
"BBBSBSBBS":"2","SBSBSSBBS":"1","SBSSBBSBB":"1","BSBSSSSSS":"1","SBBSBSSBB":"1",
"BSBSSSSSB":"2","SBSSSSSBS":"1","BSSSSSBSB":"1","SSSBSBSBB":"2","BBSBBBSSB":"2",
"SSBSBSBBS":"1","SBSBSBBSB":"1","BBBBBBSBS":"1","BBBBSBSBS":"1","BBBSBSBSB":"1",
"BBSBSBSBB":"1","BSBSBSBBB":"2","SBSBSBBBS":"1","BBSSSSBBB":"1",
};

/* ─── PAT_DB v4.0 Engine ─── */
function patdbV4(histBuf) {
  if (!histBuf || histBuf.length < 5) return { pred: 'WAIT', log: 'Not enough data' };
  // histBuf is newest-first; convert to oldest-first B/S array
  const h = histBuf.slice().reverse().map(x => x.number >= 5 ? 'B' : 'S');

  let bigScore = 0, smlScore = 0;

  // Layer 1: PAT_DB tail match
  const lens = [9, 8, 7, 6, 5], wts = [100, 70, 45, 25, 12];
  for (let i = 0; i < lens.length; i++) {
    if (h.length < lens[i]) continue;
    const key = h.slice(h.length - lens[i]).join('');
    const hit = PAT_DB[key];
    if (hit === '1') bigScore += wts[i];
    else if (hit === '2') smlScore += wts[i];
  }

  // Layer 2: 3rd-order Markov
  const t3 = {};
  for (let i = 0; i < h.length - 3; i++) {
    const k = h[i] + h[i+1] + h[i+2], nxt = h[i+3];
    if (!t3[k]) t3[k] = {B:0,S:0};
    t3[k][nxt]++;
  }
  const k3 = h.slice(-3).join('');
  if (t3[k3] && (t3[k3].B + t3[k3].S) >= 4) {
    const tot = t3[k3].B + t3[k3].S;
    bigScore += (t3[k3].B / tot) * 40; smlScore += (t3[k3].S / tot) * 40;
  }

  // Layer 3: 2nd-order Markov
  const t2 = {};
  for (let i = 0; i < h.length - 2; i++) {
    const k = h[i] + h[i+1], nxt = h[i+2];
    if (!t2[k]) t2[k] = {B:0,S:0};
    t2[k][nxt]++;
  }
  const k2 = h.slice(-2).join('');
  if (t2[k2] && (t2[k2].B + t2[k2].S) >= 5) {
    const tot = t2[k2].B + t2[k2].S;
    bigScore += (t2[k2].B / tot) * 25; smlScore += (t2[k2].S / tot) * 25;
  }

  // Layer 4: 1st-order Markov
  const t1 = {};
  for (let i = 0; i < h.length - 1; i++) {
    const k = h[i], nxt = h[i+1];
    if (!t1[k]) t1[k] = {B:0,S:0};
    t1[k][nxt]++;
  }
  const k1 = h[h.length - 1];
  if (t1[k1] && (t1[k1].B + t1[k1].S) >= 6) {
    const tot = t1[k1].B + t1[k1].S;
    bigScore += (t1[k1].B / tot) * 15; smlScore += (t1[k1].S / tot) * 15;
  }

  // Layer 5: Streak
  let streak = 1, sv = h[h.length - 1];
  for (let i = h.length - 2; i >= 0; i--) { if (h[i] === sv) streak++; else break; }
  if (streak >= 5) {
    const rev = Math.min(streak * 12, 70);
    if (sv === 'B') smlScore += rev; else bigScore += rev;
  } else if (streak >= 3) {
    const rev = streak * 8;
    if (sv === 'B') smlScore += rev; else bigScore += rev;
  } else if (streak === 2) {
    if (sv === 'B') bigScore += 6; else smlScore += 6;
  }

  // Layer 6: Gap / overdue
  let lastB = -1, lastS = -1;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] === 'B' && lastB < 0) lastB = h.length - 1 - i;
    if (h[i] === 'S' && lastS < 0) lastS = h.length - 1 - i;
    if (lastB >= 0 && lastS >= 0) break;
  }
  const gapsB = [], gapsS = []; let pB = -1, pS = -1;
  for (let i = 0; i < h.length; i++) {
    if (h[i] === 'B') { if (pB >= 0) gapsB.push(i - pB); pB = i; }
    else              { if (pS >= 0) gapsS.push(i - pS); pS = i; }
  }
  const avgB = gapsB.length ? gapsB.reduce((a,b) => a+b,0)/gapsB.length : 2;
  const avgS = gapsS.length ? gapsS.reduce((a,b) => a+b,0)/gapsS.length : 2;
  if (lastB > avgB * 2) bigScore += Math.min((lastB - avgB) * 6, 30);
  if (lastS > avgS * 2) smlScore += Math.min((lastS - avgS) * 6, 30);

  // Layer 7: Recent bias
  const recent = h.slice(-10);
  const rb = recent.filter(x => x === 'B').length, rs = recent.length - rb;
  if (rb >= 7) bigScore += (rb - 5) * 4;
  if (rs >= 7) smlScore += (rs - 5) * 4;

  // Opposite Rule: any number appears exactly 3x in last 10 → flip
  const recent10 = histBuf.slice(0, 10);
  const numCount = {};
  recent10.forEach(x => { const n = x.number; numCount[n] = (numCount[n] || 0) + 1; });
  const oppFlip = Object.values(numCount).some(v => v === 3);

  const total = bigScore + smlScore;
  if (total === 0) return { pred: 'WAIT', log: 'No signal' };

  let pred = bigScore >= smlScore ? 'Big' : 'Small';
  let label = 'PAT_DB';
  if (oppFlip) { pred = pred === 'Big' ? 'Small' : 'Big'; label = 'PAT_DB+FLIP'; }

  const conf = ((Math.max(bigScore, smlScore) / total) * 100).toFixed(1);
  return { pred, log: `${label} B${bigScore.toFixed(0)} S${smlScore.toFixed(0)} conf${conf}% → ${pred}` };
}

/* ─── TITAN v3 Engine (inverted PAT_DB + recovery) ─── */
function titanV3(histBuf, predState) {
  if (!histBuf || histBuf.length < 5) return { pred: 'WAIT', log: 'Not enough data' };
  if (!predState) predState = {};
  if (predState.titanLossStreak === undefined) predState.titanLossStreak = 0;

  const base = patdbV4(histBuf);
  if (base.pred === 'WAIT') return base;

  // Recovery mode: after 3+ consecutive losses, agree with PAT_DB for 1 bet
  const inRecovery = predState.titanLossStreak >= 3;
  const pred = inRecovery ? base.pred : (base.pred === 'Big' ? 'Small' : 'Big');
  const mode = inRecovery ? '🔄REC' : '⚡INV';

  return {
    pred,
    log: `TITAN ${mode} (${predState.titanLossStreak}L) base=${base.pred} → ${pred}`,
  };
}

/* ═══ COBRA STRIKE — DJB2 Hash per period (Regular monitor idx 7) ═══
   Deterministic prediction from issue number + SIG index.
   No history needed — purely derived from the period number.
   Formula key: "cobra_strike"
   ═══════════════════════════════════════════ */
function cobraStrike(histBuf) {
  const issue = currentIssueNumber(histBuf);
  if (!issue) return { pred: 'WAIT', log: 'No issue number available' };
  const idx = 7; // Cobra Strike slot (trader idx 7 in eip_live.html)
  const key = `${issue}-SIG${idx}-FIXED`;
  /* xE() — exact port of the EIP bundle hash used in eip_live.html
     t = (t << 5) - t + charCode  →  t = 31*t + charCode  (NOT djb2) */
  let t = 0;
  for (let i = 0; i < key.length; i++) {
    t = (t << 5) - t + key.charCodeAt(i);
    t = t | 0; // ToInt32
  }
  const h = Math.abs(t);
  const pred = h % 10 >= 5 ? 'Big' : 'Small';
  const conf = 75 + (h % 24);
  return { pred, log: `COBRA[SIG${idx}] issue=${String(issue).slice(-6)} hash=${h} → ${pred} (${conf}%)` };
}


/* ═══ ITACHI V30 — State Machine + 9-len Pattern Overlay (port from itachi_monitor.py) ═══
   Ported from wingo-server/backend/data/itachi_monitor.py
   Stateless: recomputes state + probability from histBuf every call.
   Formula key: "itachi"
   ═══════════════════════════════════════════ */
const ITACHI_PATTERN_9 = {
  "BSBSBBBBS":"BIG","SBSBBBBSB":"SMALL","BSBBBBSBB":"SMALL","SBBBBSBBB":"SMALL","BBBBBSBBBB":"BIG",
  "BBBSBBBBS":"BIG","BBSBBBBSS":"BIG","BSBBBBSSS":"BIG","SBBBBSSSS":"BIG","BBBBSSSSS":"BIG",
  "BBBSSSSSS":"BIG","BBSSSSSSS":"SMALL","BSSSSSSSB":"BIG","SSSSSSSBS":"SMALL","SSSSSSBSB":"SMALL",
  "SSSSSBSBB":"BIG","SSSSBSBBS":"BIG","SSSBSBBSS":"BIG","SSBSBBSSS":"SMALL","SBSBBSSSB":"SMALL",
  "BSBBSSSBB":"SMALL","SBBSSSBBB":"BIG","BBSSSBBBS":"SMALL","BSSSBBBSB":"SMALL","SSSBBBSBB":"BIG",
  "SSBBBSBBS":"BIG","SBBBSBBSS":"BIG","BBBSBBSSS":"SMALL","BBSBBSSSB":"SMALL","SBBSSSBBB":"SMALL",
  "BBSSSBBBB":"SMALL","BSSSBBBBB":"BIG","SSSBBBBBS":"BIG","SSBBBBBSS":"BIG","SBBBBBSSS":"BIG",
  "BBBBBSSSS":"SMALL","BBBBSSSSB":"SMALL","BBBSSSSBB":"BIG","BBSSSSBBS":"BIG","BSSSSBBSS":"SMALL",
  "SSSSBBSSB":"SMALL","SSSBBSSBB":"BIG","SSBBSSBBS":"BIG","SBBSSBBSS":"BIG","BBSSBBSSS":"BIG",
  "BSSBBSSSS":"SMALL","SSBBSSSSB":"SMALL","SBBSSSSBB":"SMALL","BBSSSSBBB":"BIG","BSSSSBBBS":"BIG",
  "SSSSBBBSS":"BIG","SSSBBBSSS":"SMALL","SSBBBSSSB":"SMALL","SBBBSSSBB":"BIG","BBBSSSBBS":"SMALL",
  "BBSSSBBSB":"BIG","BSSSBBSBS":"SMALL","SSSBBSBSB":"BIG","SSBBSBSBS":"SMALL","SBBSBSBSB":"SMALL",
  "BBSBSBSBB":"BIG","BSBSBSBBS":"BIG","SBSBSBBSS":"SMALL","BSBSBBSSB":"BIG","SBSBBSSBS":"SMALL",
  "BSBBSSBSB":"SMALL","SBBSSBSBB":"BIG","BBSSBSBBS":"SMALL","BSSBSBBSB":"BIG","SSBSBBSBS":"BIG",
  "SBSBBSBSS":"SMALL","BSBBSBSSB":"BIG","SBBSBSSBS":"SMALL","BBSBSSBSB":"SMALL","BSBSSBSBB":"BIG",
  "SBSSBSBBS":"SMALL","BSSBSBBSB":"SMALL","SSBSBBSBB":"BIG","SBSBBSBBS":"BIG","BSBBSBBSS":"SMALL",
  "SBBSBBSSB":"BIG","BBSBBSSBS":"SMALL","BSBBSSBSB":"BIG","SBBSSBSBS":"BIG","BBSSBSBSS":"SMALL",
  "BSSBSBSSB":"BIG","SSBSBSSBS":"BIG","SBSBSSBSS":"BIG","BSBSSBSSS":"BIG","SBSSBSSSS":"SMALL",
  "BSSBSSSSB":"SMALL","SSBSSSSBB":"BIG","SBSSSSBBS":"BIG","BSSSSBBSB":"SMALL","SSSSBBSBB":"SMALL",
  "SSSBBSBBBS":"BIG","SSBBSBBBS":"BIG","SBBSBBBSS":"SMALL","BBSBBBSSB":"SMALL","BSBBBSSBB":"SMALL",
  "SBBBSSBBB":"SMALL","BBBSSBBBB":"BIG","BBSSBBBBS":"BIG","BSSBBBBSS":"SMALL","SSBBBBSSB":"SMALL",
  "SBBBBSSBB":"BIG","BBBBSSBBS":"SMALL","BBBSSBBSB":"SMALL","BBSSBBSBB":"SMALL","BSSBBSBBB":"BIG",
  "SSBBSBBBS":"SMALL","SBBSBBBSB":"BIG","BBSBBBSBS":"BIG","BSBBBSBSS":"SMALL","SBBBSBSSB":"SMALL",
  "BBBSBSSBB":"SMALL","BBSBSSBBB":"SMALL","BSBSSBBBB":"BIG","SBSSBBBBS":"BIG","BSSBBBBSS":"BIG",
  "SSBBBBSSS":"BIG","BBBBSSSSS":"SMALL","BBBSSSSSB":"BIG","BBSSSSSBS":"BIG","BSSSSSBSS":"BIG",
  "BSSSBSSBB":"SMALL","SSBSSBBSS":"SMALL","SBSSBBSSB":"SMALL","BSSBBSSBB":"SMALL","SSBBSSBBB":"SMALL",
  "SBBSSBBBB":"BIG","BSSBBBBBB":"SMALL","SSBBBBBBB":"BIG","SBBBBBBBS":"SMALL","BBBBBBBSB":"SMALL",
  "BBBBBBSBB":"BIG","BBBBBSBBS":"BIG","BBBBSBBSS":"BIG","BBSBBSSSB":"BIG","BSBBSSSBS":"BIG",
  "SSSBSSBBB":"BIG","SSBSSBBBS":"SMALL","SSBBBSBSB":"BIG","SBBBSBSBS":"BIG",
  "BBBSBSBSS":"SMALL","BBSBSBSSB":"SMALL","BSBSBSSBB":"SMALL","SBSBSSBBB":"SMALL","SSBBBBSSB":"BIG",
  "SBBBBSSBS":"SMALL","BBBSSBSBB":"BIG","BBSSBSBBS":"BIG","BSSBSBBSS":"SMALL","SSBSBBSSB":"SMALL",
  "SBSBBSSBB":"SMALL","BSBBSSBBB":"BIG","SBBSSBBBS":"SMALL","BBSSBBBSB":"SMALL","BSSBBBSBB":"SMALL",
  "SSBBBSBBB":"BIG","SBBBSBBBS":"SMALL","BBBSBBBSB":"BIG","BBBSBSSBB":"BIG","BBSBSSBBS":"SMALL",
  "BSBSSBBSB":"SMALL","SBSSBBSBB":"BIG","BSSBBSBBS":"BIG","SSBBSBBSS":"BIG","SBBSBBSSS":"SMALL",
  "BSBBSSSBB":"BIG","SBBSSSBBS":"SMALL","SBBSBSBSB":"BIG","BBSBSBSBS":"BIG","BSBSBSBSS":"BIG",
  "BSBSBSSSS":"BIG","SBSBSSSSS":"BIG","BSBSSSSSS":"BIG","SBSSSSSSS":"SMALL","SSSSSBBBS":"SMALL",
  "SSSSBBBSB":"BIG","SSSBBBSBS":"BIG","BBSBSSBBB":"BIG","SBSSBBBSB":"SMALL",
  "BBBSBBBSB":"SMALL","BBSBBBSBB":"SMALL","BSBBBSBBB":"SMALL","SBBBSBBBB":"SMALL","BBBBBBBSS":"BIG",
  "BBSSSBSBS":"SMALL","BSSSBSBSB":"SMALL","SSSBSBSBB":"SMALL","SSBSBSBBB":"SMALL","SBSBSBBBB":"SMALL",
};

function _itachiMultivariate(h /* newest-first 1=BIG/0=SMALL */) {
  const decay = 0.995;
  const n = Math.min(50, h.length);
  if (n < 5) return { trendM: 0.5, volatility: 0, harmonicStrength: 0 };
  let ws = 0, tw = 0;
  for (let i = 0; i < n; i++) { const w = Math.pow(decay, i); ws += h[i] * w; tw += w; }
  const trendM = ws / tw;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += h[i];
  mean /= n;
  let varc = 0;
  for (let i = 0; i < n; i++) { const d = h[i] - mean; varc += d * d; }
  varc /= n;
  const vol = Math.sqrt(varc);
  let ac = 0;
  for (const lag of [2, 3, 4, 5]) {
    if (n <= lag) continue;
    let c = 0;
    for (let i = 0; i < n - lag; i++) c += (h[i] - mean) * (h[i + lag] - mean);
    c /= (n - lag);
    ac += Math.abs(c);
  }
  const harm = varc > 0 ? Math.min(1, ac / (4 * varc)) : 0;
  return { trendM, volatility: vol, harmonicStrength: harm };
}

function _itachiAltScore(h) {
  const n = Math.min(20, h.length);
  if (n < 3) return 0;
  let t = 0;
  for (let i = 1; i < n; i++) if (h[i] !== h[i - 1]) t++;
  return t / (n - 1);
}

function _itachiDetectBreak(h) {
  const n = Math.min(15, h.length);
  if (n < 8) return false;
  let maxR = 1, cur = 1;
  for (let i = 1; i < n; i++) {
    if (h[i] === h[i - 1]) cur++;
    else { if (cur > maxR) maxR = cur; cur = 1; }
  }
  if (cur > maxR) maxR = cur;
  let chops = 0;
  for (let i = 1; i < n; i++) if (h[i] !== h[i - 1]) chops++;
  const chopRate = chops / (n - 1);
  return chopRate > 0.82 && maxR <= 2 && h.length > 8;
}

function _itachiRunLen(h) {
  if (!h.length) return 0;
  let r = 1;
  const m = Math.min(10, h.length);
  for (let i = 1; i < m; i++) {
    if (h[i] === h[i - 1]) r++;
    else break;
  }
  return r;
}

function itachiPredict(histBuf) {
  if (!histBuf || histBuf.length < 5) {
    return { pred: 'WAIT', log: 'ITACHI gathering 5+ records…' };
  }

  /* histBuf is newest-first with .number (0..9). Convert to 1=BIG, 0=SMALL newest-first. */
  const h = histBuf.map(x => x.number >= 5 ? 1 : 0);

  const mv  = _itachiMultivariate(h);
  const brk = _itachiDetectBreak(h);
  const alt = _itachiAltScore(h);
  const run = _itachiRunLen(h);
  const exhaustion = run >= 6;

  const tm = mv.trendM, vol = mv.volatility;
  let state, regime;
  if (tm > 0.65) {
    state = vol > 0.7 ? 'VOLATILE_BULL' : 'BULL';
    regime = vol > 0.7 ? 'HIGH_ENERGY' : 'TRENDING';
  } else if (tm < 0.35) {
    state = vol > 0.7 ? 'VOLATILE_BEAR' : 'BEAR';
    regime = vol > 0.7 ? 'HIGH_ENERGY' : 'TRENDING';
  } else {
    state = vol > 0.7 ? 'CHOPPY' : 'NEUTRAL';
    regime = vol > 0.7 ? 'RANGING' : 'NORMAL';
  }
  if (alt > 0.7 && vol > 0.6) { state = 'ALTERNATING'; regime = 'CHOPPY'; }
  else if (exhaustion)        { state = 'EXHAUSTION';  regime = 'TRANSITION'; }
  else if (brk)               { state = 'BREAKING';    regime = 'TRANSITION'; }
  else if (h.length >= 4 && h[0] === h[1] && h[1] === h[2] && h[2] === h[3]) {
    state = 'EXTREME_RUN'; regime = 'OVER_EXTENDED';
  } else if (mv.harmonicStrength > 0.7) {
    state = 'HARMONIC'; regime = 'CYCLICAL';
  }

  const mapping = {
    BULL: 0.65, BEAR: 0.35,
    VOLATILE_BULL: 0.70, VOLATILE_BEAR: 0.30,
  };
  let prob = 0.5;
  if (mapping[state] !== undefined) {
    prob = mapping[state];
  } else if (state === 'EXTREME_RUN') {
    prob = h[0] === 1 ? 0.85 : 0.15;
  } else if (state === 'EXHAUSTION') {
    prob = h[0] === 1 ? 0.30 : 0.70;
  }

  /* Run length penalty — push opposite of current streak side */
  if (run >= 4) prob += h[0] === 1 ? -0.12 : 0.12;

  /* 9-length pattern overlay (70/30 blend) */
  let patHit = null;
  if (histBuf.length >= 9) {
    let key = '';
    for (let i = 0; i < 9; i++) key += histBuf[i].number >= 5 ? 'B' : 'S';
    patHit = ITACHI_PATTERN_9[key] || null;
    if (patHit) {
      const patProb = patHit === 'BIG' ? 1.0 : 0.0;
      prob = prob * 0.7 + patProb * 0.3;
    }
  }

  prob = Math.min(0.94, Math.max(0.06, prob));
  const conf = Math.min(96, Math.max(50, Math.round(60 + Math.abs(prob - 0.5) * 70)));
  const predBS = prob >= 0.5 ? 'BIG' : 'SMALL';
  const pred = predBS === 'BIG' ? 'Big' : 'Small';

  const patTag = patHit ? ` PAT9:${patHit.charAt(0)}` : '';
  return {
    pred,
    log: `ITACHI ${state}/${regime} tm:${tm.toFixed(2)} vol:${vol.toFixed(2)} run:${run}${patTag} → ${predBS} (${conf}%)`,
  };
}

/* ═══ KUBERA v2 — 6-engine priority cascade (3059-round validated) ═══ */
const KUBERA_NUM_TRANS = { 0: ['SMALL',52], 1: ['BIG',52], 3: ['SMALL',54], 4: ['BIG',53], 5: ['SMALL',52], 9: ['BIG',53] };

function kuberaPredict(histBuf) {
  if (!histBuf || histBuf.length < 6) return { pred: 'WAIT', log: 'Gathering 6+ records...' };
  const nums = histBuf.map(h => h.number);
  const sizes = nums.map(n => n >= 5 ? 'BIG' : 'SMALL');

  function streak() {
    let len = 1;
    for (let i = 1; i < sizes.length; i++) { if (sizes[i] === sizes[0]) len++; else break; }
    return { dir: sizes[0], len };
  }

  const nt = KUBERA_NUM_TRANS[nums[0]];
  if (nt && nt[1] >= 53) {
    const pred = nt[0] === 'BIG' ? 'Big' : 'Small';
    return { pred, log: `KUBERA NUM_TRANS_K[${nums[0]}] conf=${nt[1]}% → ${pred}` };
  }

  const st = streak();
  if (st.len >= 6) {
    const pred = st.dir === 'BIG' ? 'Small' : 'Big';
    return { pred, log: `KUBERA STREAK_BREAK ${st.len}x${st.dir} → ${pred}` };
  }

  if (nt) {
    const pred = nt[0] === 'BIG' ? 'Big' : 'Small';
    return { pred, log: `KUBERA NUM_TRANS_K[${nums[0]}] conf=${nt[1]}% → ${pred}` };
  }

  if (st.len === 4 || st.len === 5) {
    const pred = st.dir === 'BIG' ? 'Big' : 'Small';
    return { pred, log: `KUBERA STREAK_RIDE ${st.len}x${st.dir} → ${pred}` };
  }

  if (nums.length >= 10) {
    const bigRate = sizes.slice(0, 10).filter(s => s === 'BIG').length / 10;
    if (bigRate >= 0.70) return { pred: 'Small', log: `KUBERA FREQ_OSC BIG=${(bigRate*100).toFixed(0)}% → Small` };
    if (bigRate <= 0.30) return { pred: 'Big', log: `KUBERA FREQ_OSC BIG=${(bigRate*100).toFixed(0)}% → Big` };
  }

  if (sizes[0] === 'BIG' && sizes[1] === 'BIG') {
    return { pred: 'Small', log: 'KUBERA MKV_BB_S BIG→BIG→Small' };
  }

  return { pred: 'Small', log: 'KUBERA SMALL_LEAN fallback (50.7%)' };
}

/* ═══ HACKSOON HYBRID — patternPrediction + advancedLogic + hybrid merge ═══ */
function hacksoonPredict(histBuf) {
  if (!histBuf || histBuf.length < 8) return { pred: 'WAIT', log: 'Gathering 8+ records...' };
  const nums = [...histBuf].reverse().map(h => h.number);
  const bsArr = nums.map(n => n >= 5 ? 'B' : 'S');
  const bsSeq = bsArr.slice(-22);
  const numsForAi = nums.slice(-18);
  const seq = bsSeq.join('');

  function patternPrediction() {
    if (seq.endsWith('BBBBB'))  return { pred: 'SMALL', conf: 95, mode: '5X BIG BREAK' };
    if (seq.endsWith('SSSSS'))  return { pred: 'BIG',   conf: 95, mode: '5X SMALL BREAK' };
    if (seq.endsWith('BBSS'))   return { pred: 'BIG',   conf: 92, mode: 'DOUBLE REVERSAL' };
    if (seq.endsWith('BSBS'))   return { pred: 'BIG',   conf: 90, mode: 'ZIGZAG ATTACK' };
    if (seq.endsWith('BSBBSB')) return { pred: 'SMALL', conf: 93, mode: 'MIRROR MODE' };
    if (seq.endsWith('BSBSSBS'))return { pred: 'BIG',   conf: 94, mode: 'TRAP MODE' };
    const bCount = seq.split('B').length - 1;
    const sCount = seq.split('S').length - 1;
    return bCount > sCount
      ? { pred: 'BIG', conf: 85, mode: 'TREND BIG' }
      : { pred: 'SMALL', conf: 85, mode: 'TREND SMALL' };
  }

  function advancedLogic() {
    const recent = numsForAi.slice(-12);
    const bs = recent.map(n => n >= 5 ? 'B' : 'S');
    const s = bs.join('');
    if (s.endsWith('BSBSBS'))   return { raw: 'B', conf: 98, mode: 'SINGLE B-S CHAOS' };
    if (s.endsWith('BBSS'))     return { raw: 'B', conf: 97, mode: 'DOUBLE BB-SS' };
    if (s.endsWith('BBBSSS'))   return { raw: 'B', conf: 99, mode: 'TRIPLE BBB-SSS' };
    if (s.endsWith('BBBBSSSS')) return { raw: 'B', conf: 99, mode: 'QUADRA 4-4' };
    if (s.endsWith('BBBS'))     return { raw: 'B', conf: 96, mode: '3 IN 1 DOMINANCE' };
    const last6 = bs.slice(-6);
    if (new Set(last6).size === 1) {
      return last6[0] === 'B'
        ? { raw: 'S', conf: 95, mode: 'LONG DRAGON → SMALL' }
        : { raw: 'B', conf: 95, mode: 'LONG DRAGON → BIG' };
    }
    const last3 = bs.slice(-3);
    const predB = last3.filter(x => x === 'B').length >= 2 ? 'B' : 'S';
    return { raw: predB, conf: 90, mode: 'TREND MODE' };
  }

  const pattern = patternPrediction();
  const adv = advancedLogic();
  const advFull = adv.raw === 'B' ? 'BIG' : 'SMALL';

  let finalPred, finalConf, modeDesc;
  if (pattern.pred === advFull) {
    finalConf = Math.min(99, Math.floor((pattern.conf + adv.conf) / 2) + 5);
    finalPred = pattern.pred;
    modeDesc = `HYBRID MATCH · ${pattern.mode} + ${adv.mode}`;
  } else if (pattern.conf >= adv.conf) {
    finalPred = pattern.pred;
    finalConf = pattern.conf;
    modeDesc = `PRIMARY · ${pattern.mode}`;
  } else {
    finalPred = advFull === 'BIG' ? 'BIG' : 'SMALL';
    finalConf = adv.conf;
    modeDesc = `ADVANCED · ${adv.mode}`;
  }

  const pred = finalPred === 'BIG' ? 'Big' : 'Small';
  return { pred, log: `HACKSOON ${modeDesc} (${finalConf}%)` };
}

/* ═══ KAALA — Oracle v5 18-engine priority cascade ═══ */
const KAALA_NUM_TRANS = { 0:['SMALL',55], 2:['SMALL',55], 4:['BIG',55], 5:['SMALL',54], 7:['SMALL',54], 8:['SMALL',54] };
const KAALA_DISABLED = new Set(['CROWD_MODEL','GFAL_GRD','STRK_XPLOIT','STRK_KILL']);

function kaalaPredict(histBuf, predState) {
  if (!histBuf || histBuf.length < 10) return { pred: 'WAIT', log: 'Gathering 10+ records...' };
  const nums = histBuf.map(h => h.number);
  const sizes = nums.map(n => n >= 5 ? 'BIG' : 'SMALL');

  function streak() {
    let len = 1;
    for (let i = 1; i < sizes.length; i++) { if (sizes[i] === sizes[0]) len++; else break; }
    return { dir: sizes[0], len };
  }
  function altCount() {
    let c = 0;
    for (let i = 1; i < Math.min(7, sizes.length); i++) { if (sizes[i] !== sizes[i-1]) c++; else break; }
    return c;
  }

  const st = streak();
  const alt = altCount();

  if (alt >= 5) {
    const pred = sizes[0] === 'BIG' ? 'Big' : 'Small';
    return { pred, log: `KAALA ZIGZAG_BR alt=${alt} → ${pred} (61%)` };
  }

  if (st.len === 4) {
    const pred = st.dir === 'BIG' ? 'Big' : 'Small';
    return { pred, log: `KAALA STRK_CONT streak=4 → ${pred} (57%)` };
  }

  if (sizes[0] === 'BIG' && sizes[1] === 'BIG') {
    return { pred: 'Small', log: 'KAALA MKV_BB_S BIG→BIG→Small (55%)' };
  }

  const nt = KAALA_NUM_TRANS[nums[0]];
  if (nt) {
    const pred = nt[0] === 'BIG' ? 'Big' : 'Small';
    return { pred, log: `KAALA NUM_TRANS[${nums[0]}]→${nt[0]} (${nt[1]}%)` };
  }

  let bigW = 0, smlW = 0, topEng = 'ENSEMBLE';
  const N = Math.min(50, nums.length);
  const shortBig = sizes.slice(0, 20).filter(s => s === 'BIG').length / Math.min(20, sizes.length);
  const longBig = sizes.slice(0, N).filter(s => s === 'BIG').length / N;
  const freqDiff = shortBig - longBig;
  if (Math.abs(freqDiff) >= 0.10) {
    if (freqDiff > 0) smlW += 0.15; else bigW += 0.15;
    topEng = 'FREQ_OSC';
  }

  if (nums[0] <= 1) { smlW += 0.10; if (topEng === 'ENSEMBLE') topEng = 'EDGE_ORC'; }
  if (nums[0] >= 8) { bigW += 0.10; if (topEng === 'ENSEMBLE') topEng = 'EDGE_ORC'; }

  if (sizes.length >= 20) {
    const last = sizes[0];
    let ba = 0, sa = 0;
    for (let i = 1; i < sizes.length; i++) {
      if (sizes[i] === last) { if (sizes[i-1] === 'BIG') ba++; else sa++; }
    }
    if (ba + sa >= 8 && Math.abs(ba - sa) / (ba + sa) >= 0.15) {
      if (ba > sa) bigW += 0.12; else smlW += 0.12;
      if (topEng === 'ENSEMBLE') topEng = 'MARKOV_1';
    }
  }

  const sumDir = sizes.slice(0, 3).filter(s => s === sizes[0]).length;
  if (sumDir >= 2) {
    if (sizes[0] === 'BIG') bigW += 0.08; else smlW += 0.08;
  }

  if (bigW + smlW > 0.01) {
    const pred = bigW > smlW ? 'Big' : 'Small';
    const conf = Math.min(96, Math.round((Math.max(bigW, smlW) / (bigW + smlW)) * 100));
    return { pred, log: `KAALA ${topEng} B:${bigW.toFixed(2)} S:${smlW.toFixed(2)} → ${pred} (${conf}%)` };
  }

  return { pred: 'Small', log: 'KAALA FALLBACK → Small (platform leans SMALL)' };
}

/* ═══ ZIGZAG — Pure stateful alternating toggle ═══
   Seeds on first call with opposite of last result,
   then flips BIG↔SMALL every period regardless of outcome.
   ═══════════════════════════════════════════ */
function zigzagPredict(histBuf, predState) {
  if (!histBuf || histBuf.length < 1) return { pred: 'WAIT', log: 'Gathering records...' };
  if (!predState.zigzag) predState.zigzag = { lastPred: null };
  const zz = predState.zigzag;
  const lastResult = histBuf[0].number >= 5 ? 'BIG' : 'SMALL';
  if (!zz.lastPred) {
    zz.lastPred = lastResult === 'BIG' ? 'SMALL' : 'BIG';
  } else {
    zz.lastPred = zz.lastPred === 'BIG' ? 'SMALL' : 'BIG';
  }
  const pred = zz.lastPred === 'BIG' ? 'Big' : 'Small';
  return { pred, log: `ZIGZAG toggle → ${zz.lastPred}` };
}

/* ═══ ZN1P — 3-Formula Majority Vote ═══
   F1: DhinaS1 (3:3 / Dragon / Opposite)
   F2: Last drawn result (same side)
   F3: ZigZag toggle
   Final = whichever side gets 2+ votes.
   ═══════════════════════════════════════════ */
function _zn1pDhinaS1(histBuf) {
  if (histBuf.length < 6) {
    const last = histBuf[0].number >= 5 ? 'BIG' : 'SMALL';
    return last === 'BIG' ? 'SMALL' : 'BIG';
  }
  const bs6 = histBuf.slice(0, 6).map(h => h.number >= 5 ? 'BIG' : 'SMALL');
  const is33 = (bs6[0]===bs6[1] && bs6[1]===bs6[2]) &&
               (bs6[3]===bs6[4] && bs6[4]===bs6[5]) &&
               (bs6[0] !== bs6[3]);
  const isDragon = bs6[0]===bs6[1] && bs6[1]===bs6[2];
  if (is33) {
    const cnt = bs6.filter(b => b === bs6[0]).length;
    return cnt < 3 ? bs6[0] : (bs6[0]==='BIG' ? 'SMALL' : 'BIG');
  }
  if (isDragon) return bs6[0];
  return histBuf[0].number <= 4 ? 'BIG' : 'SMALL';
}

function zn1pPredict(histBuf, predState) {
  if (!histBuf || histBuf.length < 1) return { pred: 'WAIT', log: 'Gathering records...' };
  if (!predState.zn1p) predState.zn1p = { zigzagPred: null };
  const zz = predState.zn1p;
  const lastResult = histBuf[0].number >= 5 ? 'BIG' : 'SMALL';

  const f1 = _zn1pDhinaS1(histBuf);
  const f2 = lastResult;
  if (!zz.zigzagPred) zz.zigzagPred = lastResult === 'BIG' ? 'SMALL' : 'BIG';
  else zz.zigzagPred = zz.zigzagPred === 'BIG' ? 'SMALL' : 'BIG';
  const f3 = zz.zigzagPred;

  const bCount = (f1==='BIG'?1:0) + (f2==='BIG'?1:0) + (f3==='BIG'?1:0);
  const finalBS = bCount >= 2 ? 'BIG' : 'SMALL';
  const pred = finalBS === 'BIG' ? 'Big' : 'Small';
  return { pred, log: `ZN1P MAJORITY [F1:${f1[0]} F2:${f2[0]} F3:${f3[0]}] → ${finalBS}` };
}

/* ═══ EIP — 31-Node Ensemble (20 hash + 10 lookback traders) ═══
   Hash traders:     DJB2(period+"-SIG{idx}-FIXED") % 10 → BIG/SMALL
   Lookback traders: history[lb-1].number → BIG/SMALL
   Selection:        score last 10, pick best with liveStreak < 2,
                     sorted by accuracy desc then liveStreak asc.
   ═══════════════════════════════════════════ */
const _EIP_NAMES = ['Tiger Pro','Dragon King','Phoenix VIP','Eagle Eye','Lion Heart',
                    'Thunder Bolt','Shadow X','Cobra Strike','Wolf Pack','Blaze Pro',
                    'Viper Gold','Rocket Star','Storm Chaser','Ninja Master','Falcon Rush',
                    'Panther VIP','Ghost Rider','Shark Tank','Bullet Pro','Dark Horse'];
const _PRO_NAMES = ['Quantum X','Apex Titan','Nova Prime','Stealth Hawk','Omega Force',
                    'Zenith Pro','Crypto Wolf','Rapid Fire','Iron Pulse','Shadow Blade'];
const _EIP_TRADERS = [];
for (let _i = 0; _i < 20; _i++) _EIP_TRADERS.push({ type: 'hash', idx: _i });
for (let _i = 0; _i < 10; _i++) _EIP_TRADERS.push({ type: 'lookback', idx: _i });

function _eipHash(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) { t = (t << 5) - t + s.charCodeAt(i); t = t & t; }
  return Math.abs(t);
}

function _eipGetPred(trader, period, histBuf) {
  if (trader.type === 'hash') {
    const num = _eipHash(`${period}-SIG${trader.idx}-FIXED`) % 10;
    return num >= 5 ? 'BIG' : 'SMALL';
  }
  const lb = trader.idx + 1;
  const targetIdx = histBuf.findIndex(h => h.issueNumber === period);
  const sourceIdx = targetIdx === -1 ? lb - 1 : targetIdx + lb;
  if (sourceIdx < histBuf.length && histBuf[sourceIdx]) {
    return histBuf[sourceIdx].number >= 5 ? 'BIG' : 'SMALL';
  }
  return null;
}

function eipPredict(histBuf) {
  if (!histBuf || histBuf.length < 10) return { pred: 'WAIT', log: 'Gathering 10+ records...' };
  const nextPeriod = (BigInt(histBuf[0].issueNumber) + 1n).toString();

  const stats = _EIP_TRADERS.map((trader) => {
    let wins = 0, liveStreak = 0;
    const results = [];
    for (let j = 0; j < 10; j++) {
      if (!histBuf[j]) break;
      const actual = histBuf[j].number >= 5 ? 'BIG' : 'SMALL';
      const p = _eipGetPred(trader, histBuf[j].issueNumber, histBuf);
      const isWin = p ? (p === actual) : false;
      results.push(isWin);
      if (isWin) wins++;
    }
    for (const r of results) { if (!r) liveStreak++; else break; }
    const name = trader.type === 'hash' ? _EIP_NAMES[trader.idx] : _PRO_NAMES[trader.idx];
    return { trader, name, wins, acc: wins / 10 * 100, liveStreak,
             nextPred: _eipGetPred(trader, nextPeriod, histBuf) };
  });

  let valid = stats.filter(s => s.liveStreak < 2);
  if (valid.length === 0) valid = stats;
  valid.sort((a, b) => b.acc !== a.acc ? b.acc - a.acc : a.liveStreak - b.liveStreak);

  const best = valid[0];
  if (!best || !best.nextPred) return { pred: 'WAIT', log: 'EIP syncing...' };
  const pred = best.nextPred === 'BIG' ? 'Big' : 'Small';
  return { pred, log: `EIP [${best.name}] acc=${best.acc.toFixed(0)}% ls=${best.liveStreak} → ${best.nextPred}` };
}

/* ═══ KUTTY — Bison-Source pattern + 3-mode state machine ═══
   Layer 1 (Bison Source): scan history for exact-number pair [nums[0],nums[1]];
     look at what follows each occurrence. Majority → sourcePred.
     Unanimous (3+) occurrences → OPPOSITE of that majority (counter signal).
     No match → same as last result.
   Layer 2 (Premium): V1 = opposite of sourcePred. V2/Emergency = sourcePred.
   Layer 3 (State machine, outcome-driven):
     WIN         → reset to V1, clear emergency
     LOSS from V1 → switch to V2
     LOSS from V2 → back to V1 + emergencyFlipActive
     LOSS from Emergency → back to V1, clear emergency
   Stateful: predState.kutty tracks engine mode and last prediction.
   ═══════════════════════════════════════════ */
function _kuttyBisonSource(histBuf) {
  const nums = histBuf.map(h => h.number);
  if (nums.length < 3) return nums[0] >= 5 ? 'BIG' : 'SMALL';
  const p0 = nums[0], p1 = nums[1];
  const matches = [];
  for (let i = 1; i < nums.length - 2; i++) {
    if (nums[i] === p0 && nums[i + 1] === p1) {
      const above = nums[i - 1];
      if (above !== undefined) matches.push(above >= 5 ? 'BIG' : 'SMALL');
    }
  }
  if (matches.length > 0) {
    const bigs = matches.filter(m => m === 'BIG').length;
    const smalls = matches.length - bigs;
    if (matches.length >= 3 && (bigs === matches.length || smalls === matches.length)) {
      return bigs > smalls ? 'SMALL' : 'BIG'; // unanimous → OPPOSITE (counter signal)
    }
    return bigs >= smalls ? 'BIG' : 'SMALL';
  }
  return nums[0] >= 5 ? 'BIG' : 'SMALL';
}

function kuttyPredict(histBuf, predState) {
  if (!histBuf || histBuf.length < 3) return { pred: 'WAIT', log: 'Gathering 3+ records...' };
  if (!predState.kutty) {
    predState.kutty = { activeEngine: 'V1', emergencyFlipActive: false, lastPredForIssue: null, lastPred: null };
  }
  const ks = predState.kutty;

  // Resolve outcome of previous prediction (if it has now settled in histBuf)
  if (ks.lastPredForIssue && ks.lastPred) {
    const settled = histBuf.find(h => String(h.issueNumber) === String(ks.lastPredForIssue));
    if (settled) {
      const actualBS = settled.number >= 5 ? 'BIG' : 'SMALL';
      const won = ks.lastPred === actualBS;
      if (won) {
        ks.activeEngine = 'V1';
        ks.emergencyFlipActive = false;
      } else if (ks.emergencyFlipActive) {
        ks.activeEngine = 'V1';
        ks.emergencyFlipActive = false;
      } else if (ks.activeEngine === 'V1') {
        ks.activeEngine = 'V2';
      } else {
        ks.activeEngine = 'V1';
        ks.emergencyFlipActive = true;
      }
    }
  }

  const base = _kuttyBisonSource(histBuf);
  const v1Normal = base === 'BIG' ? 'SMALL' : 'BIG';

  let finalBS, topStr;
  if (ks.emergencyFlipActive) {
    finalBS = v1Normal === 'BIG' ? 'SMALL' : 'BIG'; // same as base
    topStr = '🔥 EMERGENCY';
  } else if (ks.activeEngine === 'V2') {
    finalBS = v1Normal === 'BIG' ? 'SMALL' : 'BIG'; // same as base
    topStr = 'V2 ⚡';
  } else {
    finalBS = v1Normal; // opposite of base
    topStr = 'V1 ✓';
  }

  try {
    ks.lastPredForIssue = (BigInt(histBuf[0].issueNumber) + 1n).toString();
  } catch { ks.lastPredForIssue = null; }
  ks.lastPred = finalBS;

  return {
    pred: finalBS === 'BIG' ? 'Big' : 'Small',
    log: `KUTTY [${topStr}] base=${base[0]} → ${finalBS}`,
  };
}

/* ═══ N1N2 — Adaptive N1/N2 Cascade with parity ═══ */
function n1n2Predict(histBuf, predState) {
  if (!histBuf || histBuf.length < 2) return { pred: 'WAIT', log: 'Gathering 2+ records...' };

  if (!predState.n1n2) predState.n1n2 = { strategy: 'N1' };
  const state = predState.n1n2;
  const level = predState.level || 0;

  const n1 = histBuf[0].number;
  const n2 = histBuf[1].number;
  const n1Size = n1 >= 5 ? 'BIG' : 'SMALL';
  const n2Size = n2 >= 5 ? 'BIG' : 'SMALL';

  if (level > 0) {
    state.strategy = state.strategy === 'N1' ? 'N2' : 'N1';
  }

  const basePred = state.strategy === 'N1' ? n1Size : n2Size;
  const pred = basePred === 'BIG' ? 'Big' : 'Small';
  return { pred, log: `N1N2 strategy=${state.strategy} n1=${n1}(${n1Size}) n2=${n2}(${n2Size}) → ${pred}` };
}

/* ═══ KINGPIN 3.0 — Dual-number modular candidate vote ═══
   Ported from the source Telegram bot (compute_best_num).
   Stateless: uses only the last two drawn NUMBERS (n1=latest, n2=2nd-latest).
   Builds 4 candidate numbers via modular formulas, maps each to BIG/SMALL,
   majority vote decides the side (tie → BIG). Confidence = vote agreement.
   bestNum = base formula's number if it matches the voted side,
             else the first candidate matching the side.
   Note: autobet bets SIZE only, so `pred` drives the bet; #bestNum is informational.
   ═══════════════════════════════════════════ */
function kingpin3Predict(histBuf) {
  if (!histBuf || histBuf.length < 2) return { pred: 'WAIT', log: 'Gathering 2+ records...' };
  const n1 = histBuf[0].number;
  const n2 = histBuf[1].number;
  const bs = n => n >= 5 ? 'BIG' : 'SMALL';

  const core = (n1 + n2 + 3) % 10;
  const candidates = [
    (n1 + n2 + 3) % 10,       // base
    (n1 * 2 + n2 + 3) % 10,   // weight latest more
    (n1 + n2 * 2 + 3) % 10,   // weight previous more
    (n1 + n2 + 5) % 10,       // shifted
  ];

  const bigVotes = candidates.filter(c => bs(c) === 'BIG').length;
  const smallVotes = candidates.length - bigVotes;
  const side = bigVotes >= smallVotes ? 'BIG' : 'SMALL';        // tie → BIG
  const agree = Math.max(bigVotes, smallVotes);
  const confidence = Math.round((agree / candidates.length) * 100);

  let bestNum;
  if (bs(core) === side) bestNum = core;
  else bestNum = candidates.find(c => bs(c) === side);
  if (bestNum === undefined) bestNum = core;

  const pred = side === 'BIG' ? 'Big' : 'Small';
  return {
    pred,
    log: `KINGPIN3 n1=${n1} n2=${n2} cand=[${candidates.join(',')}] ${bigVotes}B/${smallVotes}S → ${side} #${bestNum} (${confidence}%)`,
  };
}

/* ═══ ENGINE 11 — "KINGPIN QUANTUM" 11-Formula Ensemble ═══
   Ported from Engine-11-Ensemble.html. Eleven sub-formulas each vote
   BIG/SMALL; majority wins (tie → SMALL, matching `bigs > smalls`).
   Stateful: F1 (Mfreq ACTUAL/FLIP state) and F2 (Pol loss-streak flip)
   carry per-formula win/loss state, resolved once per settled period.
   F3 = EIP 30-trader engine. F2 uses Math.random() → non-deterministic
   by design (faithful to source). State stored in predState.engine11.
   ═══════════════════════════════════════════ */
function _e11Hash(e) { let t = 0; for (let r = 0; r < e.length; r++) { t = (t << 5) - t + e.charCodeAt(r); t = t & t; } return Math.abs(t); }

/* F1: Modified Mfreq — number→side map, flips when in FLIP state */
function _e11_f1(hist, st) {
  if (!hist.length) { st.lastPred = 'BIG'; return 'BIG'; }
  const map = { 0:'SMALL',1:'BIG',2:'SMALL',3:'BIG',4:'SMALL',5:'BIG',6:'SMALL',7:'SMALL',8:'SMALL',9:'BIG' };
  const base = map[hist[0].number % 10] || 'BIG';
  const pred = st.state === 'FLIP' ? (base === 'BIG' ? 'SMALL' : 'BIG') : base;
  st.lastPred = pred;
  return pred;
}
function _e11_f1_update(st, actual) {
  if (!st.lastPred) return;
  const won = st.lastPred === actual;
  if (st.state === 'ACTUAL' && !won) st.state = 'FLIP';
  else if (st.state === 'FLIP' && won) st.state = 'FLIP';
  else if (st.state === 'FLIP' && !won) st.state = 'ACTUAL';
}

/* F2: Pol.py — period-hash + repeat + freq-AI weighted vote, loss-streak flip */
function _e11_f2(period, hist, st) {
  const p = BigInt(period);
  const calcVal = ((p * 97n) + (p % 99n)) % 90n;
  const calc = calcVal > 4n ? 'BIG' : 'SMALL';
  let rep = hist.length ? (Math.random() < 0.9 ? hist[0].size : (hist[0].size === 'BIG' ? 'SMALL' : 'BIG')) : 'BIG';
  let ai = 'BIG';
  if (hist.length) {
    const bigCount = hist.filter(h => h.size === 'BIG').length;
    const smallCount = hist.length - bigCount;
    ai = (bigCount > smallCount) ? (Math.random() < 0.6 ? 'SMALL' : 'BIG') : (Math.random() < 0.6 ? 'BIG' : 'SMALL');
  }
  let vB = 0, vS = 0;
  if (calc === 'BIG') vB += 1.2; else vS += 1.2;
  if (rep === 'BIG') vB += 1.0; else vS += 1.0;
  if (ai === 'BIG') vB += 1.1; else vS += 1.1;
  let res = vB >= vS ? 'BIG' : 'SMALL';
  if (st.flip_next) { res = (res === 'BIG' ? 'SMALL' : 'BIG'); st.flip_next = false; }
  st.lastPred = res;
  return res;
}
function _e11_f2_update(st, actual) {
  if (!st.lastPred) return;
  if (st.lastPred === actual) { st.loss_streak = 0; }
  else { st.loss_streak++; if (st.loss_streak >= 2) { st.flip_next = true; st.loss_streak = 0; } }
}

/* F3: EIP AutoRun — 20 hash + 10 lookback traders, best by accuracy */
function _e11_f3(nextPeriod, hist) {
  if (!hist.length) return 'BIG';
  const TRADERS = [];
  for (let i = 0; i < 20; i++) TRADERS.push({ type: 'hash', idx: i });
  for (let i = 0; i < 10; i++) TRADERS.push({ type: 'lookback', idx: i });
  const getPred = (t, period, targetIdx = -1) => {
    if (t.type === 'hash') return _e11Hash(`${period}-SIG${t.idx}-FIXED`) % 10 >= 5 ? 'BIG' : 'SMALL';
    const sourceIdx = targetIdx === -1 ? t.idx : targetIdx + t.idx + 1;
    if (sourceIdx < hist.length && hist[sourceIdx]) return hist[sourceIdx].size;
    return 'BIG';
  };
  const stats = TRADERS.map(t => {
    let wins = 0, liveStreak = 0; const res = [];
    for (let i = 0; i < 10; i++) {
      if (!hist[i]) break;
      const pr = getPred(t, hist[i].period, i);
      const win = pr === hist[i].size;
      res.push(win); if (win) wins++;
    }
    for (const r of res) { if (!r) liveStreak++; else break; }
    return { acc: wins / 10, liveStreak, nextP: getPred(t, nextPeriod) };
  });
  let valid = stats.filter(s => s.liveStreak < 2);
  if (!valid.length) valid = stats;
  valid.sort((a, b) => b.acc !== a.acc ? b.acc - a.acc : a.liveStreak - b.liveStreak);
  return valid[0].nextP;
}

/* F4: Pattern (3:3 / dragon / opposite) */
function _e11_f4(hist) {
  if (hist.length < 6) return hist.length ? (hist[0].size === 'BIG' ? 'SMALL' : 'BIG') : 'BIG';
  const r = hist.slice(0, 6).map(h => h.size);
  const is33 = (r[0]===r[1]&&r[1]===r[2]) && (r[3]===r[4]&&r[4]===r[5]) && r[0]!==r[3];
  if (is33) {
    let cur = 0;
    for (let i = 0; i < r.length; i++) { if (r[i] === r[0]) cur++; else break; }
    return cur < 3 ? r[0] : (r[0] === 'BIG' ? 'SMALL' : 'BIG');
  } else if (r[0]===r[1]&&r[1]===r[2]) { return r[0]; }
  return hist[0].size === 'BIG' ? 'SMALL' : 'BIG';
}

/* F5: Advanced pattern detector (oldest→newest sequence, 20 rules) */
function _e11_f5(hist) {
  if (!hist.length) return 'BIG';
  const seq = hist.slice(0, 40).map(h => h.size).reverse();
  if (seq.length < 5) return seq[seq.length-1] === 'BIG' ? 'SMALL' : 'BIG';
  const len = seq.length, last = seq[len-1], last3 = seq.slice(-3), last4 = seq.slice(-4), last5 = seq.slice(-5), last6 = seq.slice(-6);
  if (len >= 6) { const b1 = seq.slice(-6,-3), b2 = seq.slice(-3); if (b1.every(v=>v===b1[0]) && b2.every(v=>v===b2[0]) && b1[0]!==b2[0]) return b2[0]; }
  if (last3.every(v=>v===last)) return last;
  if (len >= 6 && last5.every((v,i)=>v===(i%2===0?last5[0]:last5[1]))) return last === 'BIG' ? 'SMALL' : 'BIG';
  if (len >= 6 && last6[0]===last6[1] && last6[2]===last6[3] && last6[4]===last6[5] && last6[0]!==last6[2] && last6[2]!==last6[4]) return last6[4] === 'BIG' ? 'SMALL' : 'BIG';
  if (len >= 3 && last3[0]===last3[1] && last3[1]!==last3[2]) return last3[2];
  if (len >= 6 && JSON.stringify(seq.slice(-6,-3)) === JSON.stringify(seq.slice(-3))) return seq[len-1];
  if (len >= 5 && last4.every(v=>v===last4[0]) && last4[0]!==last) return last4[0];
  if (len >= 5 && last5[0]==='BIG' && last5[1]==='SMALL' && last5[2]==='BIG' && last5[3]==='SMALL' && last5[4]==='BIG') return 'SMALL';
  if (len >= 5 && last5[0]==='SMALL' && last5[1]==='BIG' && last5[2]==='SMALL' && last5[3]==='BIG' && last5[4]==='SMALL') return 'BIG';
  if (len >= 4 && last4[0]===last4[1] && last4[2]===last4[3] && last4[0]!==last4[2]) return last4[3];
  if (len >= 3 && last3[0]==='BIG' && last3[1]==='SMALL' && last3[2]==='BIG') return 'BIG';
  if (len >= 3 && last3[0]==='SMALL' && last3[1]==='BIG' && last3[2]==='SMALL') return 'SMALL';
  if (len >= 3 && last3[0]===last3[2] && last3[0]!==last3[1]) return last3[1];
  if (len >= 5 && last5.every(v=>v==='BIG')) return 'SMALL';
  if (len >= 5 && last5.every(v=>v==='SMALL')) return 'BIG';
  if (len >= 5 && last5[0]!==last5[1] && last5[1]!==last5[2] && last5[2]!==last5[3] && last5[3]!==last5[4]) return last5[4]==='BIG'?'SMALL':'BIG';
  if (len >= 4 && last4[0]===last4[2] && last4[1]===last4[3]) return last4[3];
  const bc = last4.filter(v=>v==='BIG').length;
  if (bc >= 3) return 'BIG'; if (bc <= 1) return 'SMALL';
  return last === 'BIG' ? 'SMALL' : 'BIG';
}

/* F6: RAG V7 — last-5 number majority, contrarian */
function _e11_f6(hist) {
  if (!hist || hist.length === 0) return 'BIG';
  const recentNums = hist.slice(0, 5).map(h => h.number).filter(n => n !== undefined && n !== null && !isNaN(n) && n >= 0);
  if (!recentNums.length) return 'BIG';
  const bigCount = recentNums.filter(n => n >= 5).length;
  const smallCount = recentNums.length - bigCount;
  return bigCount > smallCount ? 'SMALL' : 'BIG';
}

/* F7 / F10 / F11: N2 (2nd-last result) */
function _e11_n2(hist) {
  if (hist && hist.length > 1) return hist[1].size;
  return hist.length ? hist[0].size : 'BIG';
}

/* F8: RAG Hybrid simulator + auto-correct */
function _e11_f8(hist) {
  if (!hist || hist.length === 0) return 'BIG';
  const types = hist.map(x => x.size.toLowerCase());
  const recent = types.slice(0, 20);
  let streakLen = 1; const streakType = types[0];
  for (let i = 1; i < Math.min(types.length, 15); i++) { if (types[i] === streakType) streakLen++; else break; }
  const w10 = types.slice(0, 10);
  const bigPct10 = +(w10.filter(x => x === 'big').length / Math.max(1, w10.length) * 100).toFixed(1);
  const transitions = { big: { big: 0, small: 0 }, small: { big: 0, small: 0 } };
  for (let i = 0; i < types.length - 1; i++) {
    if (transitions[types[i]] && transitions[types[i]][types[i+1]] !== undefined) transitions[types[i]][types[i+1]]++;
  }
  const currentStreak = { type: streakType || 'big', length: streakLen };
  const last10 = { bigPct: bigPct10 };
  /* runStatisticalSimulation */
  let type = currentStreak.type || 'big';
  if (currentStreak.length >= 4) type = (currentStreak.type === 'big' ? 'small' : 'big');
  else if (last10.bigPct > 70) type = 'small';
  else if (last10.bigPct < 30) type = 'big';
  else { const t = transitions[currentStreak.type] || { big: 0, small: 0 }; type = t.big >= t.small ? 'big' : 'small'; }
  /* autoCorrectPrediction */
  let corrected = type, applied = false;
  if (currentStreak.length >= 4 && type === currentStreak.type) { corrected = currentStreak.type === 'big' ? 'small' : 'big'; applied = true; }
  if (!applied) {
    if (last10.bigPct >= 70 && type === 'big') corrected = 'small';
    else if (last10.bigPct <= 30 && type === 'small') corrected = 'big';
  }
  return corrected.toUpperCase();
}

/* F9: N1 (last result) */
function _e11_f9(hist) { return hist.length > 0 ? hist[0].size : 'BIG'; }

function engine11Predict(histBuf, predState) {
  if (!histBuf || histBuf.length < 1) return { pred: 'WAIT', log: 'Gathering records...' };
  if (!predState.engine11) {
    predState.engine11 = {
      f1: { state: 'ACTUAL', lastPred: null },
      f2: { loss_streak: 0, flip_next: false, lastPred: null },
      lastPredForIssue: null,
    };
  }
  const es = predState.engine11;
  const hist = histBuf.map(h => ({ period: String(h.issueNumber), number: h.number, size: h.number >= 5 ? 'BIG' : 'SMALL' }));

  /* Resolve previous prediction → drive F1/F2 state machines (once, when settled) */
  if (es.lastPredForIssue) {
    const settled = hist.find(h => h.period === String(es.lastPredForIssue));
    if (settled) {
      _e11_f1_update(es.f1, settled.size);
      _e11_f2_update(es.f2, settled.size);
      es.lastPredForIssue = null;
    }
  }

  const nextPeriod = (BigInt(histBuf[0].issueNumber) + 1n).toString();
  const votes = [
    _e11_f1(hist, es.f1),
    _e11_f2(nextPeriod, hist, es.f2),
    _e11_f3(nextPeriod, hist),
    _e11_f4(hist),
    _e11_f5(hist),
    _e11_f6(hist),
    _e11_n2(hist),   // F7
    _e11_f8(hist),
    _e11_f9(hist),
    _e11_n2(hist),   // F10
    _e11_n2(hist),   // F11
  ];
  let bigs = 0, smalls = 0;
  votes.forEach(p => p === 'BIG' ? bigs++ : smalls++);
  const finalBS = bigs > smalls ? 'BIG' : 'SMALL';

  es.lastPredForIssue = nextPeriod;
  const str = votes.map(p => p[0]).join('');
  return {
    pred: finalBS === 'BIG' ? 'Big' : 'Small',
    log: `ENGINE11 [${str}] ${bigs}B/${smalls}S → ${finalBS}`,
  };
}

/* ═══ KINGPIN 1M — WinGo 1-Minute engine (mode: WinGo_1M ONLY) ═══
   Exact port of kingpin_1m_monitor.py predict():
     Rule A: Warmup   — <5 history → WAIT (no bet)
     Rule B: Streak   — last 3 same BS → follow the streak
     Rule C: Majority — else bet OPPOSITE of the majority in last 5
   Stateless. Used only when an account is in WinGo_1M mode.
   ═══════════════════════════════════════════ */
function kingpin1m(histBuf) {
  if (!histBuf || histBuf.length < 5) return { pred: 'WAIT', log: 'KINGPIN1M warmup — need 5 rounds' };
  const bsAt = i => histBuf[i].number >= 5 ? 'BIG' : 'SMALL';
  const r0 = bsAt(0), r1 = bsAt(1), r2 = bsAt(2);

  /* Rule B: Streak Follower — last 3 identical → continue */
  if (r0 === r1 && r1 === r2) {
    return { pred: r0 === 'BIG' ? 'Big' : 'Small', log: `KINGPIN1M STREAK FOLLOWER → ${r0}` };
  }

  /* Rule C: Majority Reversal — count last 5, bet opposite of the majority */
  let big = 0;
  for (let i = 0; i < 5; i++) if (bsAt(i) === 'BIG') big++;
  const sml = 5 - big;
  const finalBS = big > sml ? 'SMALL' : 'BIG';
  return { pred: finalBS === 'BIG' ? 'Big' : 'Small', log: `KINGPIN1M MAJORITY REVERSAL [${big}B/${sml}S] → ${finalBS}` };
}

/* ═══ DISPATCHER ═══ */
/* ═══ AAAB + AUTO-CORRECTOR — ported verbatim from "AAAB + Auto-corrector.html" ═══
   Fixed continuous sequence S-S-S-B mapped onto (period % 4): idx 0,1,2 → SMALL,
   idx 3 → BIG. Auto-corrector (always ON, matching the source default `checked`)
   forces WAIT when the last up-to-4 SETTLED rounds show ZERO matches to the
   sequence (pattern fully inverted). The source labels BIG as 'BIGG' and uses it
   for BOTH the prediction and actualBS, so the match test is internally consistent
   — kept exactly as-is; only the final output is mapped to the engine's Big/Small.
   Stateless. ══════════════════════════════════════════════════════════════════ */
const _AAAB_SEQ = ['SMALL', 'SMALL', 'SMALL', 'BIGG'];
function _aaabSeqPred(periodStr) { return _AAAB_SEQ[Number(BigInt(periodStr) % 4n)]; }
function aaabCorrectorPredict(histBuf) {
  const nextPeriod = currentIssueNumber(histBuf);
  if (!nextPeriod || !histBuf.length) return { pred: 'WAIT', log: 'AAAB: gathering data' };

  const history = histBuf.map(h => ({ period: String(h.issueNumber), actualBS: h.number >= 5 ? 'BIGG' : 'SMALL' }));

  let misaligned = false;
  if (history.length >= 3) {
    const checkLen = Math.min(4, history.length);
    let matches = 0;
    for (let i = 0; i < checkLen; i++) if (history[i].actualBS === _aaabSeqPred(history[i].period)) matches++;
    misaligned = (matches === 0);
  }
  if (misaligned) return { pred: 'WAIT', log: 'AUTO-CORRECT (SKIPPING INVERSION)' };

  const base = _aaabSeqPred(nextPeriod);
  const pred = base === 'BIGG' ? 'Big' : 'Small';
  return { pred, log: `S-S-S-B ALIGNED idx=${Number(BigInt(nextPeriod) % 4n)} → ${pred}` };
}

/* ═══ N1 1AUTO — ported verbatim from "N1 1auto.html" ═══
   Copy-Cat engine: predict the LAST settled result. After ANY loss, SKIP exactly
   one round (→ WAIT), then resume. Stateful: self-resolves its previous prediction
   against now-settled history to drive the skip flag — exactly like the source's
   `liveSkipNext` (loss → skip next; the skip round itself → resume; win → resume).
   ═══════════════════════════════════════════════════════════════════════════════ */
function n1AutoPredict(histBuf, predState) {
  /* noRecovery: true → the source has NO recovery fallback; its skip must be a
     REAL skip. The engine's recovery-on-WAIT override honours this flag and
     leaves N1's WAIT alone (every other formula's recovery is unaffected). */
  if (!histBuf || histBuf.length < 1) return { pred: 'WAIT', log: 'N1: Insufficient Data', noRecovery: true };
  if (!predState.n1auto) predState.n1auto = { skipNext: false, lastPredForIssue: null, lastPred: null };
  const st = predState.n1auto;

  if (st.lastPredForIssue && st.lastPred) {
    const settled = histBuf.find(h => String(h.issueNumber) === String(st.lastPredForIssue));
    if (settled && settled.number != null) {
      const actualBS = settled.number >= 5 ? 'BIGG' : 'SMALL';
      if (st.lastPred === 'SKIP') st.skipNext = false;
      else if (st.lastPred !== 'WAIT') st.skipNext = (st.lastPred !== actualBS);
      st.lastPredForIssue = null; st.lastPred = null;
    }
  }

  const nextPeriod = currentIssueNumber(histBuf);
  let predSize, top;
  if (st.skipNext) { predSize = 'SKIP'; top = 'Skipping After Loss'; }
  else { predSize = histBuf[0].number >= 5 ? 'BIGG' : 'SMALL'; top = 'Last Result Copy'; }

  st.lastPredForIssue = nextPeriod;
  st.lastPred = predSize;

  if (predSize === 'SKIP') return { pred: 'WAIT', log: top, noRecovery: true };
  const pred = predSize === 'BIGG' ? 'Big' : 'Small';
  return { pred, log: `${top} → ${pred}`, noRecovery: true };
}

const MAP = { dna3, oracle: oracleEngine, patdb_v4: patdbV4, titan_v3: titanV3, cobra_strike: cobraStrike, itachi: itachiPredict, kubera: kuberaPredict, hacksoon: hacksoonPredict, kaala: kaalaPredict, n1n2: n1n2Predict, zigzag: zigzagPredict, zn1p: zn1pPredict, eip: eipPredict, kutty: kuttyPredict, kingpin3: kingpin3Predict, engine11: engine11Predict, kingpin1m, aaab_corrector: aaabCorrectorPredict, n1_auto: n1AutoPredict };

const _STATEFUL = new Set(['oracle', 'titan_v3', 'kaala', 'n1n2', 'zigzag', 'zn1p', 'kutty', 'engine11', 'n1_auto']);

function run(histBuf, formulaKey, predState) {
  if (!histBuf || histBuf.length < 1) return { pred: 'WAIT', log: 'No data', forIssue: null, formula: formulaKey };
  const fn = MAP[formulaKey] || oracleEngine;
  const result = _STATEFUL.has(formulaKey) ? fn(histBuf, predState) : fn(histBuf);
  result.forIssue = currentIssueNumber(histBuf);
  result.formula = formulaKey;
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════
   SHARED PREDICTION COORDINATOR  (per gameMode + formula)
   ───────────────────────────────────────────────────────────────────────
   BUG FIX (same-formula accounts getting DIFFERENT predictions):
   Previously every account ran the formula against its OWN predState and its
   OWN martingale level, so for the same period two accounts could disagree:
     • stateful formulas (oracle / n1n2 / titan / engine11 / kutty …) each
       accumulated per-account internal state that drifted apart over time;
     • engine11 uses Math.random() — non-deterministic on every single call;
     • predState.level flipped n1n2 / titan_v3 DIRECTION per account's ladder.

   Fix: evaluate the formula ONCE per period using ONE shared predState, cache
   the result by issue, and hand the SAME object to every account on that
   (gameMode, formula). Direction is shared; staking (martingale level → stake)
   stays per-account. A shared loss-streak (the formula's OWN prediction track
   record) drives recovery logic identically for all accounts.
   ═══════════════════════════════════════════════════════════════════════ */
const _shared = {};   // key `${gameMode}::${formula}` -> { predState, issue, result, streak }
function _skey(gameMode, formula) { return `${gameMode || 'WinGo_30S'}::${formula}`; }

function runShared(histBuf, formulaKey, gameMode) {
  const issue = currentIssueNumber(histBuf);
  const key = _skey(gameMode, formulaKey);
  let slot = _shared[key];
  if (!slot) slot = _shared[key] = { predState: {}, issue: null, result: null, streak: 0 };

  /* Cache hit — this period was already computed: every account gets the SAME object. */
  if (issue && slot.issue === issue && slot.result) return slot.result;

  /* Stale caller — its buffer is BEHIND the shared state (hasn't fetched the latest
     draw yet). Don't recompute with old data (would corrupt shared state); make it
     wait one tick until it catches up. No money risk — it simply doesn't bet yet. */
  if (issue && slot.issue) {
    try { if (BigInt(issue) < BigInt(slot.issue)) return { pred: 'WAIT', log: 'sync — buffer behind', forIssue: issue, formula: formulaKey }; }
    catch { /* non-numeric issue — fall through */ }
  }

  /* New period: resolve the PREVIOUS shared prediction against now-known history to
     advance the formula's own consecutive-loss streak (drives recovery consistently). */
  if (slot.issue && slot.issue !== issue && slot.result &&
      slot.result.pred && slot.result.pred !== 'WAIT' && Array.isArray(histBuf)) {
    const prev = histBuf.find(r => String(r.issueNumber) === String(slot.issue));
    if (prev && prev.number != null) {
      const actualBS = parseInt(prev.number) >= 5 ? 'Big' : 'Small';
      slot.streak = (slot.result.pred === actualBS) ? 0 : (slot.streak + 1);
    }
  }

  /* Feed the SHARED streak to the formulas that branch on it — replaces the old
     per-account predState.level / titanLossStreak injection so DIRECTION never
     depends on any single account's martingale ladder. */
  slot.predState.level = slot.streak;
  slot.predState.titanLossStreak = slot.streak;

  const result = run(histBuf, formulaKey, slot.predState);
  slot.issue  = issue;
  slot.result = result;
  return result;
}

/* The formula's own consecutive-loss streak (shared). The engine uses this to decide
   recovery-on-WAIT identically for every account, instead of per-account level. */
function sharedStreak(gameMode, formulaKey) {
  const slot = _shared[_skey(gameMode, formulaKey)];
  return slot ? slot.streak : 0;
}

function recoveryFallback(histBuf) {
  if (!histBuf || histBuf.length < 1) return null;
  const lastNum = histBuf[0].number;
  const pred = lastNum >= 5 ? 'Small' : 'Big';
  return { pred, forIssue: currentIssueNumber(histBuf), formula: 'recovery-fallback', log: `Opposite of last(${lastNum})` };
}

function reset(predState) {
  if (predState) {
    predState.oracle = null;
    predState.titanLossStreak = 0;
    predState.n1n2 = null;
    predState.zigzag = null;
    predState.zn1p = null;
    predState.kutty = null;
    predState.engine11 = null;
    predState.n1auto = null;
  }
}

module.exports = { run, runShared, sharedStreak, recoveryFallback, reset, currentIssueNumber };
