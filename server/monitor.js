/* ═══════════════════════════════════════════════════════════
   EIP MONITOR ENGINE  —  Regular (djb2) + Pro (lookback)
   Serves /monitor-regular and /monitor-pro  via Socket.IO
   CSV auto-save + all-time JSON stats
   ═══════════════════════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data', 'logs');
const ALLTIME_FILE = path.join(DATA_DIR, 'eip_alltime.json');
const DRAW_URL = 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';

// ── Trader definitions ──────────────────────────────────────────
const REGULAR = [
  {idx:0,  emoji:'🐯', name:'Tiger Pro'},
  {idx:1,  emoji:'🐉', name:'Dragon King'},
  {idx:2,  emoji:'🔥', name:'Phoenix VIP'},
  {idx:3,  emoji:'🦅', name:'Eagle Eye'},
  {idx:4,  emoji:'🦁', name:'Lion Heart'},
  {idx:5,  emoji:'⚡', name:'Thunder Bolt'},
  {idx:6,  emoji:'👤', name:'Shadow X'},
  {idx:7,  emoji:'🐍', name:'Cobra Strike'},
  {idx:8,  emoji:'🐺', name:'Wolf Pack'},
  {idx:9,  emoji:'💥', name:'Blaze Pro'},
  {idx:10, emoji:'🐍', name:'Viper Gold'},
  {idx:11, emoji:'🚀', name:'Rocket Star'},
  {idx:12, emoji:'🌪️', name:'Storm Chaser'},
  {idx:13, emoji:'🥷', name:'Ninja Master'},
  {idx:14, emoji:'🦅', name:'Falcon Rush'},
  {idx:15, emoji:'🐆', name:'Panther VIP'},
  {idx:16, emoji:'👻', name:'Ghost Rider'},
  {idx:17, emoji:'🦈', name:'Shark Tank'},
  {idx:18, emoji:'💫', name:'Bullet Pro'},
  {idx:19, emoji:'🐴', name:'Dark Horse'},
];

const PRO = [
  {idx:0, emoji:'⚛️',  name:'Quantum X'},
  {idx:1, emoji:'🏔️', name:'Apex Titan'},
  {idx:2, emoji:'🌟',  name:'Nova Prime'},
  {idx:3, emoji:'🦅',  name:'Stealth Hawk'},
  {idx:4, emoji:'💎',  name:'Omega Force'},
  {idx:5, emoji:'🔱',  name:'Zenith Pro'},
  {idx:6, emoji:'🐺',  name:'Crypto Wolf'},
  {idx:7, emoji:'🔥',  name:'Rapid Fire'},
  {idx:8, emoji:'⚙️',  name:'Iron Pulse'},
  {idx:9, emoji:'🗡️',  name:'Shadow Blade'},
];

// ── Algorithms ──────────────────────────────────────────────────
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h, 33) ^ str.charCodeAt(i);
    h = h | 0; // keep int32
  }
  return Math.abs(h);
}

function regularPred(issue, idx) {
  const key = `${issue}-SIG${idx}-FIXED`;
  const hash = djb2(key);
  return { pred: hash % 10 >= 5 ? 'BIG' : 'SMALL', confidence: 75 + (hash % 24) };
}

function nd(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

function proPred(history, idx) {
  const lb = idx + 1;
  if (history.length < lb) return null;
  const src = history[lb - 1];
  const n = Number(src.number);
  return { pred: nd(n), number: n, confidence: 80 + n % 15 };
}

// ── Session state factory ────────────────────────────────────────
function makeSession(trader) {
  return {
    trader,
    wins: 0, losses: 0,
    streak: 0,          // + = win streak, - = loss streak
    maxWinStreak: 0,
    maxLossStreak: 0,
    martingaleLevel: 0, // 0=1x 1=2x 2=4x …
    maxMartingaleLevel: 0,
    simulatedBalance: 1000, // virtual units
    netUnits: 0,        // net profit in units
    startTime: Date.now(),
    lastResult: null,   // 'WIN' | 'LOSS'
    recentResults: [],  // last 20 [{period, pred, actual, result, number}]
  };
}

// ── All-time stats ───────────────────────────────────────────────
let alltimeStats = {};
function loadAlltime() {
  try {
    if (fs.existsSync(ALLTIME_FILE))
      alltimeStats = JSON.parse(fs.readFileSync(ALLTIME_FILE, 'utf8'));
  } catch {}
}
function saveAlltime() {
  try { fs.writeFileSync(ALLTIME_FILE, JSON.stringify(alltimeStats, null, 2)); } catch {}
}
function updateAlltime(formula, trader, result, session) {
  const key = `${formula}:${trader.idx}`;
  if (!alltimeStats[key]) alltimeStats[key] = {
    formula, idx: trader.idx, name: trader.name, emoji: trader.emoji,
    totalWins: 0, totalLosses: 0, bestWinStreak: 0, bestLossStreak: 0,
    bestAcc: 0, sessions: 0,
  };
  const s = alltimeStats[key];
  if (result === 'WIN') s.totalWins++; else s.totalLosses++;
  const total = s.totalWins + s.totalLosses;
  const acc = total > 0 ? Math.round(s.totalWins / total * 100) : 0;
  if (acc > s.bestAcc) s.bestAcc = acc;
  if (session) {
    if (session.maxWinStreak > s.bestWinStreak) s.bestWinStreak = session.maxWinStreak;
    if (session.maxLossStreak > s.bestLossStreak) s.bestLossStreak = session.maxLossStreak;
  }
}

// ── Session maps ─────────────────────────────────────────────────
const regularSessions = new Map(); // idx -> session
const proSessions     = new Map();

REGULAR.forEach(t => regularSessions.set(t.idx, makeSession(t)));
PRO.forEach(t => proSessions.set(t.idx, makeSession(t)));

// ── CSV helpers ──────────────────────────────────────────────────
const CSV_HEADER = 'timestamp,period,formula,trader_idx,trader_name,prediction,actual_number,actual_size,result,confidence,session_wins,session_losses,session_acc,streak,martingale_level,net_units\n';

function csvPath(formula) {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(DATA_DIR, `eip_${formula}_${d}.csv`);
}
function ensureCsv(formula) {
  const p = csvPath(formula);
  if (!fs.existsSync(p)) fs.writeFileSync(p, CSV_HEADER);
  return p;
}
function appendCsv(formula, row) {
  try {
    const p = ensureCsv(formula);
    const line = [
      row.timestamp, row.period, row.formula, row.traderIdx, `"${row.traderName}"`,
      row.prediction, row.actualNumber, row.actualSize, row.result, row.confidence,
      row.sessionWins, row.sessionLosses, row.sessionAcc, row.streak,
      row.martingaleLevel, row.netUnits,
    ].join(',') + '\n';
    fs.appendFileSync(p, line);
  } catch {}
}

// ── Process one draw ─────────────────────────────────────────────
function processResult(session, pred, actualSize, actualNumber, period, formula) {
  const result = pred.pred === actualSize ? 'WIN' : 'LOSS';
  const bet = Math.pow(2, session.martingaleLevel); // units bet this round

  // Update stats
  if (result === 'WIN') {
    session.wins++;
    session.netUnits += bet;
    session.streak = session.streak >= 0 ? session.streak + 1 : 1;
    if (session.streak > session.maxWinStreak) session.maxWinStreak = session.streak;
    session.martingaleLevel = 0;
  } else {
    session.losses++;
    session.netUnits -= bet;
    session.streak = session.streak <= 0 ? session.streak - 1 : -1;
    if (Math.abs(session.streak) > session.maxLossStreak) session.maxLossStreak = Math.abs(session.streak);
    session.martingaleLevel = Math.min(session.martingaleLevel + 1, 8); // cap at 256x
    if (session.martingaleLevel > session.maxMartingaleLevel) session.maxMartingaleLevel = session.martingaleLevel;
  }
  session.lastResult = result;
  const row = { period, pred: pred.pred, actual: actualSize, actualNumber, result, confidence: pred.confidence };
  session.recentResults.unshift(row);
  if (session.recentResults.length > 50) session.recentResults.pop();

  const total = session.wins + session.losses;
  const acc = total > 0 ? Math.round(session.wins / total * 100) : 0;

  // CSV
  appendCsv(formula, {
    timestamp: new Date().toISOString(),
    period, formula,
    traderIdx: session.trader.idx,
    traderName: session.trader.name,
    prediction: pred.pred,
    actualNumber,
    actualSize,
    result,
    confidence: pred.confidence,
    sessionWins: session.wins,
    sessionLosses: session.losses,
    sessionAcc: acc,
    streak: session.streak,
    martingaleLevel: session.martingaleLevel,
    netUnits: session.netUnits.toFixed(2),
  });

  updateAlltime(formula, session.trader, result, session);
}

// ── Serialize session for socket ─────────────────────────────────
function serializeSession(s) {
  const total = s.wins + s.losses;
  const acc = total > 0 ? Math.round(s.wins / total * 100) : 0;
  const sessionMs = Date.now() - s.startTime;
  const hh = Math.floor(sessionMs / 3600000).toString().padStart(2, '0');
  const mm = Math.floor((sessionMs % 3600000) / 60000).toString().padStart(2, '0');
  const ss = Math.floor((sessionMs % 60000) / 1000).toString().padStart(2, '0');
  return {
    idx: s.trader.idx,
    emoji: s.trader.emoji,
    name: s.trader.name,
    wins: s.wins, losses: s.losses, total, acc,
    streak: s.streak,
    maxWinStreak: s.maxWinStreak,
    maxLossStreak: s.maxLossStreak,
    martingaleLevel: s.martingaleLevel,
    maxMartingaleLevel: s.maxMartingaleLevel,
    nextBet: Math.pow(2, s.martingaleLevel),
    netUnits: Number(s.netUnits.toFixed(2)),
    lastResult: s.lastResult,
    sessionTime: `${hh}:${mm}:${ss}`,
    recentResults: s.recentResults.slice(0, 20),
  };
}

// ── Fetch history ────────────────────────────────────────────────
let lastProcessedPeriod = null;

function fetchHistory() {
  return new Promise((resolve, reject) => {
    const req = https.get(DRAW_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const raw = Array.isArray(json) ? json : json?.data?.list || json?.data || [];
          const history = raw.map(item => ({
            period: String(item.issueNumber || item.period || '0'),
            number: Number(item.number ?? item.winNumber ?? 0),
          }));
          resolve(history);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Core tick ────────────────────────────────────────────────────
let io_ = null;

async function tick() {
  try {
    const history = await fetchHistory();
    if (!history.length) return;
    const latest = history[0];
    if (latest.period === lastProcessedPeriod) return; // no new draw
    const newPeriod = latest.period;
    const newNumber = latest.number;
    const newSize   = nd(newNumber);
    // The draw we're evaluating: history[0] is the just-settled period.
    // Predictions were made for this period in the *previous* tick.
    // We retroactively evaluate last period's prediction vs actual.

    // For REGULAR: prediction for period P was made using the issue number P itself
    // (djb2 on the issue string). So we can evaluate it now.
    REGULAR.forEach(t => {
      const session = regularSessions.get(t.idx);
      const pred = regularPred(newPeriod, t.idx);
      processResult(session, pred, newSize, newNumber, newPeriod, 'regular');
    });

    // For PRO: prediction for period P was history[idx].number from the previous fetch.
    // Now that history[0] = P, we evaluate: proPred used history[idx] from last tick.
    // But we just fetched new history — we can still evaluate using the formula:
    // the prediction for history[0] (the just-settled) was nd(history[lb].number)
    // i.e. using current history[lb] (which hasn't changed yet for settled periods).
    // Actually the simplest: re-run proPred on current history to evaluate the SETTLED draw.
    // history[0] = just settled (period newPeriod), we can evaluate that the prediction was
    // nd(history[lb-1].number) where lb = idx+1, history[lb-1] = history[idx]
    // This is what we predicted before this draw settled. That is history[1+idx] since
    // history is ordered newest-first: history[0]=new, history[1]=prev, ...
    // So the source is history[idx+1] (since after new draw, old lb-1 slot shifted by 1)
    // BUT: we need the value BEFORE the new draw was appended. history[1] is what was
    // history[0] last tick. So source = history[idx + 1].
    PRO.forEach(t => {
      const lb = t.idx + 1;
      if (history.length <= lb) return; // not enough history
      const src = history[lb]; // this was history[lb-1] before the new draw came in
      const n = Number(src.number);
      const pred = { pred: nd(n), number: n, confidence: 80 + n % 15 };
      const session = proSessions.get(t.idx);
      processResult(session, pred, newSize, newNumber, newPeriod, 'pro');
    });

    lastProcessedPeriod = newPeriod;
    saveAlltime();

    // Emit to connected clients
    if (io_) {
      const regularPayload = {
        period: newPeriod,
        number: newNumber,
        size: newSize,
        sessions: REGULAR.map(t => serializeSession(regularSessions.get(t.idx))),
        alltimeBest: getAlltimeBest('regular'),
        nextPredictions: REGULAR.map(t => {
          // For regular, we can predict the NEXT period (period+1)
          const nextPeriod = (BigInt(newPeriod) + 1n).toString();
          const pred = regularPred(nextPeriod, t.idx);
          return { idx: t.idx, ...pred };
        }),
      };
      const proPayload = {
        period: newPeriod,
        number: newNumber,
        size: newSize,
        sessions: PRO.map(t => serializeSession(proSessions.get(t.idx))),
        alltimeBest: getAlltimeBest('pro'),
        nextPredictions: PRO.map(t => {
          // For pro, next pred = nd(history[idx].number)
          const lb = t.idx + 1;
          if (history.length < lb) return { idx: t.idx, pred: '?', confidence: 0 };
          const src = history[lb - 1]; // history[idx] (0-based lb-1)
          const n = Number(src.number);
          return { idx: t.idx, pred: nd(n), number: n, confidence: 80 + n % 15 };
        }),
      };
      io_.to('monitor-regular').emit('monitor:update', regularPayload);
      io_.to('monitor-pro').emit('monitor:update', proPayload);
    }
    console.log(`[monitor] draw settled: period=${newPeriod} number=${newNumber} (${newSize})`);
  } catch (e) {
    console.warn('[monitor] tick error:', e.message);
  }
}

// ── All-time best helper ─────────────────────────────────────────
function getAlltimeBest(formula) {
  const entries = Object.values(alltimeStats).filter(s => s.formula === formula);
  if (!entries.length) return null;
  entries.sort((a, b) => b.bestAcc - a.bestAcc || b.totalWins - a.totalWins);
  return entries.slice(0, 3).map(e => ({
    emoji: e.emoji, name: e.name, bestAcc: e.bestAcc,
    totalWins: e.totalWins, totalLosses: e.totalLosses,
  }));
}

// ── Current state snapshot (for new connections) ─────────────────
function getSnapshot(formula) {
  const sessions = formula === 'regular' ? REGULAR : PRO;
  const map      = formula === 'regular' ? regularSessions : proSessions;
  return {
    period: lastProcessedPeriod || '—',
    sessions: sessions.map(t => serializeSession(map.get(t.idx))),
    alltimeBest: getAlltimeBest(formula),
    nextPredictions: [],
  };
}

// ── CSV list endpoint helper ─────────────────────────────────────
function listCsvFiles() {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('eip_') && f.endsWith('.csv'))
      .map(f => ({ name: f, formula: f.includes('_pro_') ? 'pro' : 'regular', path: `/api/monitor/csv/${f}` }));
  } catch { return []; }
}

// ── Running state ───────────────────────────────────────────────
let running = true;
let schedTimer = null;

// ── Mount ────────────────────────────────────────────────────────
function mount(app, io) {
  io_ = io;
  loadAlltime();

  // Socket.IO rooms
  io.on('connection', socket => {
    socket.on('monitor:join', ({ formula }) => {
      if (formula !== 'regular' && formula !== 'pro') return;
      socket.join(`monitor-${formula}`);
      socket.emit('monitor:snapshot', getSnapshot(formula));
      socket.emit('monitor:status', { running });
    });
    socket.on('monitor:leave', ({ formula }) => {
      socket.leave(`monitor-${formula}`);
    });
  });

  // CSV download
  app.get('/api/monitor/csv/:filename', (req, res) => {
    const name = path.basename(req.params.filename);
    const fpath = path.join(DATA_DIR, name);
    if (!name.startsWith('eip_') || !fs.existsSync(fpath)) return res.status(404).send('Not found');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', 'text/csv');
    res.sendFile(fpath);
  });

  // CSV list
  app.get('/api/monitor/csvlist', (req, res) => res.json(listCsvFiles()));

  // All-time stats
  app.get('/api/monitor/alltime', (req, res) => res.json(alltimeStats));

  // Reset session (only session, not alltime)
  app.post('/api/monitor/reset/:formula', (req, res) => {
    const formula = req.params.formula;
    if (formula === 'regular') REGULAR.forEach(t => regularSessions.set(t.idx, makeSession(t)));
    else if (formula === 'pro') PRO.forEach(t => proSessions.set(t.idx, makeSession(t)));
    else return res.json({ ok: false, msg: 'unknown formula' });
    res.json({ ok: true });
  });

  app.post('/api/monitor/reset-hard', (req, res) => {
    // Reset all sessions in memory
    REGULAR.forEach(t => regularSessions.set(t.idx, makeSession(t)));
    PRO.forEach(t => proSessions.set(t.idx, makeSession(t)));
    // Delete all eip_*.csv files in DATA_DIR
    let deleted = [];
    try {
      fs.readdirSync(DATA_DIR).forEach(f => {
        if (f.startsWith('eip_') && f.endsWith('.csv')) {
          fs.unlinkSync(path.join(DATA_DIR, f));
          deleted.push(f);
        }
      });
    } catch(e) { console.error('[monitor] csv delete error', e.message); }
    // Reset alltime JSON
    alltimeStats = {};
    try { fs.writeFileSync(ALLTIME_FILE, '{}'); } catch {}
    // Broadcast fresh snapshot to all rooms
    io_.to('monitor-regular').emit('monitor:snapshot', getSnapshot('regular'));
    io_.to('monitor-pro').emit('monitor:snapshot', getSnapshot('pro'));
    console.log(`[monitor] hard reset — deleted: ${deleted.join(', ') || 'none'}`);
    res.json({ ok: true, deleted });
  });

  // Stop / Start engine
  app.post('/api/monitor/stop', (req, res) => {
    if (!running) return res.json({ ok: true, running: false });
    running = false;
    if (schedTimer) { clearTimeout(schedTimer); schedTimer = null; }
    io_.emit('monitor:status', { running: false });
    console.log('[monitor] engine STOPPED by user');
    res.json({ ok: true, running: false });
  });

  app.post('/api/monitor/start', (req, res) => {
    if (running) return res.json({ ok: true, running: true });
    running = true;
    io_.emit('monitor:status', { running: true });
    console.log('[monitor] engine STARTED by user');
    schedNext();
    tick();
    res.json({ ok: true, running: true });
  });

  app.get('/api/monitor/status', (req, res) => res.json({ running }));

  // Serve monitor pages
  app.get('/monitor-regular', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'monitor-regular.html')));
  app.get('/monitor-pro', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'monitor-pro.html')));

  // Start the polling loop — sync to game cycle
  function schedNext() {
    if (schedTimer) clearTimeout(schedTimer);
    const now = Date.now();
    const wait = (30000 - now % 30000) + 2000; // 2s after each 30s boundary
    schedTimer = setTimeout(async () => {
      if (!running) return;
      await tick();
      schedNext();
    }, wait);
  }
  // Immediate first tick
  setTimeout(() => { if (running) tick(); }, 1500);
  schedNext();

  console.log('[monitor] EIP monitor engine started (regular + pro)');
}

module.exports = { mount };
