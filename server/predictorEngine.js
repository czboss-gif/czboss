/* ═══════════════════════════════════════════════════════════
   PREDICTOR ENGINE — server-side, always-on accuracy tester
   Runs independently of any browser tab (same pattern as monitor.js):
   polls the live draw feed on its own schedule, synced to the 30s
   cycle, and pushes state to connected clients over Socket.IO.
   Closing/backgrounding the browser tab does NOT stop it.

   Tests the exact "Advanced Big/Small Analyzer" logic sourced from a
   v0.app-generated tool — predicting BIG/SMALL from the last 3 digits
   of the UPCOMING period number. Ported verbatim, no logic changes.
   ═══════════════════════════════════════════════════════════ */

const https = require('https');
const path  = require('path');
const fs    = require('fs');

const DRAW_URL   = 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';
const DATA_DIR   = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'predictor_state.json');
const HISTORY_CAP = 500;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ── EXACT PORT of the v0-generated analyzeDigits() ── */
function analyzeDigits(digits) {
  const nums = digits.split('').map(Number);
  const [first, second, third] = nums;

  const sum = first + second + third;
  const product = first * second * third;
  const range = Math.max(...nums) - Math.min(...nums);

  const isAscending = first < second && second < third;
  const isDescending = first > second && second > third;
  const hasRepeats = new Set(nums).size < 3;
  const isEven = nums.filter(n => n % 2 === 0).length;

  let bigScore = 0;
  let factors = [];

  if (sum >= 15) { bigScore += 25; factors.push(`High sum (${sum})`); }
  else if (sum <= 8) { bigScore -= 20; factors.push(`Low sum (${sum})`); }

  if (product >= 50) { bigScore += 20; factors.push(`High product (${product})`); }
  else if (product === 0) { bigScore -= 25; factors.push('Contains zero'); }

  if (isAscending) { bigScore += 15; factors.push('Ascending pattern'); }
  else if (isDescending) { bigScore -= 10; factors.push('Descending pattern'); }

  if (range >= 7) { bigScore += 10; factors.push(`Wide range (${range})`); }
  else if (range <= 2) { bigScore -= 15; factors.push(`Narrow range (${range})`); }

  if (isEven >= 2) { bigScore += 8; factors.push(`${isEven} even numbers`); }
  else { bigScore -= 5; factors.push('Mostly odd numbers'); }

  if (hasRepeats) { bigScore -= 12; factors.push('Has repeating digits'); }

  if (nums.includes(7) || nums.includes(8) || nums.includes(9)) {
    bigScore += 12; factors.push('Contains lucky numbers');
  }

  const randomFactor = (Math.random() - 0.5) * 20;
  const finalScore = bigScore + randomFactor;

  const isBig = finalScore > 0;
  const confidenceLevel = Math.min(95, Math.max(60, Math.abs(finalScore) + 60));

  return {
    result: isBig ? 'BIG' : 'SMALL',
    confidence: Math.round(confidenceLevel),
    factors,
  };
}

function last3(periodStr) { return String(periodStr).slice(-3); }

/* ── Persistent state (survives pm2 restarts) ── */
let state = {
  sessionStart: Date.now(),
  lastIss: null,
  currentPrediction: null,     // { period, digits, pred, conf, factors }
  history: [],                 // {period, digits, actual, pred, conf, result} newest-first
  wins: 0, losses: 0,
  winStreak: 0, lossStreak: 0,
  maxWinStreak: 0, maxLossStreak: 0,
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...state, ...saved };
      console.log(`[predictor] restored state — ${state.wins}W/${state.losses}L, ${state.history.length} rows`);
    }
  } catch (e) { console.warn('[predictor] state load failed:', e.message); }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }
  catch (e) { console.warn('[predictor] state save failed:', e.message); }
}

function fetchHistory() {
  return new Promise((resolve, reject) => {
    const url = `${DRAW_URL}?pageSize=20&t=${Date.now()}`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const list = json?.data?.list || [];
          resolve(list.map(item => ({
            period: String(item.issueNumber),
            number: Number(item.number),
          })));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function makeNextPrediction(nextPeriod) {
  const digits = last3(nextPeriod);
  const a = analyzeDigits(digits);
  state.currentPrediction = { period: nextPeriod, digits, pred: a.result, conf: a.confidence, factors: a.factors };
}

function processResult(item) {
  const actual = item.number >= 5 ? 'BIG' : 'SMALL';
  const period = item.period;
  if (state.currentPrediction && state.currentPrediction.period === period) {
    const won = state.currentPrediction.pred === actual;
    if (won) {
      state.wins++; state.winStreak++; state.lossStreak = 0;
      state.maxWinStreak = Math.max(state.maxWinStreak, state.winStreak);
    } else {
      state.losses++; state.lossStreak++; state.winStreak = 0;
      state.maxLossStreak = Math.max(state.maxLossStreak, state.lossStreak);
    }
    state.history.unshift({
      period, digits: state.currentPrediction.digits, actual,
      pred: state.currentPrediction.pred, conf: state.currentPrediction.conf,
      result: won ? 'WIN' : 'LOSS',
    });
    if (state.history.length > HISTORY_CAP) state.history.pop();
  }
}

let io_ = null;

async function tick() {
  try {
    const history = await fetchHistory();
    if (!history.length) return;
    const newest = history[0].period;
    if (newest === state.lastIss) return; // nothing new

    if (state.lastIss === null) {
      // first ever tick — just establish baseline, predict forward only
      makeNextPrediction((BigInt(newest) + 1n).toString());
    } else {
      const fresh = [];
      for (const item of history) { if (item.period === state.lastIss) break; fresh.push(item); }
      fresh.reverse().forEach(item => {
        processResult(item);
        makeNextPrediction((BigInt(item.period) + 1n).toString());
      });
    }
    state.lastIss = newest;
    saveState();

    if (io_) io_.emit('predictor:update', getSnapshot());
    console.log(`[predictor] tick — period=${newest} W${state.wins}/L${state.losses}`);
  } catch (e) {
    console.warn('[predictor] tick error:', e.message);
  }
}

function getSnapshot() {
  const total = state.wins + state.losses;
  return {
    sessionStart: state.sessionStart,
    currentPrediction: state.currentPrediction,
    history: state.history.slice(0, HISTORY_CAP),
    wins: state.wins, losses: state.losses, total,
    accuracy: total ? +(state.wins / total * 100).toFixed(2) : 0,
    winStreak: state.winStreak, lossStreak: state.lossStreak,
    maxWinStreak: state.maxWinStreak, maxLossStreak: state.maxLossStreak,
  };
}

function resetSession() {
  state = {
    sessionStart: Date.now(), lastIss: state.lastIss, currentPrediction: state.currentPrediction,
    history: [], wins: 0, losses: 0, winStreak: 0, lossStreak: 0, maxWinStreak: 0, maxLossStreak: 0,
  };
  saveState();
  if (io_) io_.emit('predictor:update', getSnapshot());
}

let schedTimer = null;
function schedNext() {
  if (schedTimer) clearTimeout(schedTimer);
  const now = Date.now();
  const wait = (30000 - now % 30000) + 1500; // 1.5s after each 30s boundary
  schedTimer = setTimeout(async () => { await tick(); schedNext(); }, wait);
}

function mount(app, io) {
  io_ = io;
  loadState();

  io.on('connection', socket => {
    socket.emit('predictor:snapshot', getSnapshot());
  });

  app.post('/api/predictor/reset', (req, res) => {
    resetSession();
    res.json({ ok: true });
  });
  app.get('/api/predictor/state', (req, res) => res.json(getSnapshot()));

  // Immediate first tick, then sync to the 30s draw cycle boundary
  setTimeout(() => tick(), 1500);
  schedNext();

  console.log('[predictor] engine started — polling independent of any browser tab');
}

module.exports = { mount, analyzeDigits };
