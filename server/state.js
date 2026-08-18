/* ═══════════════════════════════════════════
   KINGPIN 3.0 — State Manager (Multi-Account)
   Each account = isolated state.
   accounts Map<phone, Account>.
   ═══════════════════════════════════════════ */

const KP = require('./config');
const crypto = require('crypto');
const UserConfig  = require('./models/UserConfig');
const BetHistory  = require('./models/BetHistory');
const PredHistory = require('./models/PredHistory');

/* ── Simple AES-256 encrypt/decrypt for passwords ── */
const _ENC_KEY = crypto.createHash('sha256').update(process.env.ENC_SECRET || 'kp3-default-key').digest();
const _ENC_IV_LEN = 16;

function _encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(_ENC_IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-cbc', _ENC_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}

function _decrypt(data) {
  if (!data || !data.includes(':')) return '';
  try {
    const [ivHex, enc] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', _ENC_KEY, iv);
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch { return ''; }
}

const ENGINE = { STOPPED: 'stopped', WATCHING: 'watching', WAITING: 'waiting', BETTING: 'betting', CHECKING: 'checking' };

class Account {
  constructor(phone) {
    this.phone        = phone;
    this.engine       = ENGINE.STOPPED;
    this.level        = 1;
    this.pnl          = 0;
    this.wins         = 0;
    this.losses       = 0;
    this.highestLevel = 1;
    this.balance      = 0;
    this.sessionStart = 0;
    this.pendingBet   = null;
    this.preBetBal    = 0;
    this.prediction   = null;
    this.lastPredIssue = null;
    this.lotteryToken = '';
    this.webapiToken  = '';
    this.pwd          = '';     // plain-text password (in-memory only for relogin)
    this.histBuf      = [];
    this.betHistory   = [];
    this.predHistory  = [];
    this.watchEnabled    = false;
    this.watchPred       = null;
    this.watchIssue      = null;
    this.virtualWatches  = 0;
    this.watchLossTarget = 1;
    this.watchLossCount  = 0;
    this.levels       = [...KP.DEFAULT_LEVELS];
    this.gameMode     = KP.GAME_MODE;            // 'WinGo_30S' | 'WinGo_1M' (per-account)
    this.formula      = KP.DEFAULT_FORMULA;

    this.predState = {};
  }

  /* ═══ Getters ═══ */
  getStake()       { return this.levels[this.level - 1] || this.levels[this.levels.length - 1]; }
  getMaxLevel()    { return this.levels.length; }
  getTotalRisk()   { return this.levels.reduce((s, v) => s + v, 0); }
  getFormulaInfo() { return KP.FORMULAS[this.formula] || KP.FORMULAS[KP.DEFAULT_FORMULA]; }
  isRunning()      { return this.engine !== ENGINE.STOPPED; }
  getBets()        { return this.wins + this.losses; }

  /* ═══ Setters ═══ */
  setLevel(l)           { this.level = l; if (l > this.highestLevel) this.highestLevel = l; }
  setFormula(f)         { if (KP.FORMULAS[f]) this.formula = f; }
  /* Switch game mode (30S ↔ 1M). Returns true if changed.
     Resets stream-bound state since the period stream is different, and
     snaps the formula to a valid one for the new mode. */
  setGameMode(mode) {
    if (!KP.MODES[mode] || mode === this.gameMode) return false;
    this.gameMode = mode;
    /* History buffer + stateful prediction state belong to the old stream */
    this.histBuf = [];
    this.predState = {};
    this.lastPredIssue = null;
    this.prediction = null;
    /* If current formula isn't valid for this mode, pick the mode default */
    const valid = KP.formulasForMode(mode);
    if (!valid[this.formula]) {
      this.formula = KP.DEFAULT_FORMULA_BY_MODE[mode] || Object.keys(valid)[0] || this.formula;
    }
    return true;
  }
  setLevels(arr)        { if (Array.isArray(arr) && arr.length > 0) this.levels = arr; }
  setWatchLossTarget(n) { this.watchLossTarget = Math.max(1, Math.min(10, parseInt(n, 10) || 1)); }

  /* ═══ Actions ═══ */
  recordWin(amount)  { this.wins++; this.pnl += amount; }
  recordLoss(amount) { this.losses++; this.pnl -= amount; }

  addBetHistory(entry) {
    this.betHistory.unshift(entry);
    if (this.betHistory.length > 200) this.betHistory.pop();
    /* Persist to MongoDB (fire-and-forget) */
    BetHistory.findOneAndUpdate(
      { phone: this.phone, issue: entry.issue },
      { phone: this.phone, ...entry },
      { upsert: true, new: true }
    ).catch(e => console.error(`[DB] saveBetHistory error: ${e.message}`));
  }

  addPredHistory(entry) {
    if (this.predHistory.length > 0 && this.predHistory[0].forIssue === entry.forIssue) {
      if (entry.result !== undefined) this.predHistory[0].result = entry.result;
      if (entry.correct !== undefined) this.predHistory[0].correct = entry.correct;
      /* Update existing record in DB */
      PredHistory.findOneAndUpdate(
        { phone: this.phone, forIssue: entry.forIssue },
        { result: this.predHistory[0].result, correct: this.predHistory[0].correct },
      ).catch(e => console.error(`[DB] updatePredHistory error: ${e.message}`));
      return;
    }
    this.predHistory.unshift(entry);
    if (this.predHistory.length > 100) this.predHistory.pop();
    /* Persist to MongoDB (fire-and-forget) */
    PredHistory.findOneAndUpdate(
      { phone: this.phone, forIssue: entry.forIssue },
      { phone: this.phone, ...entry },
      { upsert: true, new: true }
    ).catch(e => console.error(`[DB] savePredHistory error: ${e.message}`));
  }

  /* Resolve a predHistory entry with actual result — updates in-memory + DB */
  resolvePredHistory(forIssue, result, correct) {
    const ph = this.predHistory.find(p => String(p.forIssue) === String(forIssue) && p.correct === undefined);
    if (!ph) return;
    ph.result = result;
    ph.correct = correct;
    PredHistory.findOneAndUpdate(
      { phone: this.phone, forIssue: String(forIssue) },
      { result, correct },
    ).catch(e => console.error(`[DB] resolvePredHistory error: ${e.message}`));
  }

  resetSession() {
    this.level = 1; this.highestLevel = 1; this.pnl = 0; this.wins = 0; this.losses = 0;
    this.pendingBet = null; this.sessionStart = Date.now();
    this.watchPred = null; this.watchIssue = null; this.virtualWatches = 0;
    this.watchLossCount = 0; this.lastPredIssue = null; this.prediction = null;
  }

  /* Reset only engine-internal state — keeps cumulative stats intact */
  resetEngineState() {
    this.level = 1; this.pendingBet = null; this.sessionStart = Date.now();
    this.watchPred = null; this.watchIssue = null; this.virtualWatches = 0;
    this.watchLossCount = 0; this.lastPredIssue = null; this.prediction = null;
  }

  resetForNewCycle() {
    this.level = 1; this.pendingBet = null;
    if (this.watchEnabled) {
      this.watchPred = null; this.watchIssue = null;
      this.virtualWatches = 0; this.watchLossCount = 0;
    }
  }

  clearTokens() { this.lotteryToken = ''; this.webapiToken = ''; }

  snapshot() {
    return {
      engine: this.engine, level: this.level, pnl: this.pnl,
      wins: this.wins, losses: this.losses, highestLevel: this.highestLevel,
      balance: this.balance, sessionElapsed: this.sessionStart ? Date.now() - this.sessionStart : 0, formula: this.formula,
      formulaInfo: this.getFormulaInfo(),
      gameMode: this.gameMode,
      modeLabel: (KP.MODES[this.gameMode] || {}).label || this.gameMode,
      cycleSecs: KP.modeCycleMs(this.gameMode) / 1000,
      levels: this.levels, totalRisk: this.getTotalRisk(),
      stake: this.getStake(), maxLevel: this.getMaxLevel(),
      watchEnabled: this.watchEnabled, watchLossTarget: this.watchLossTarget,
      prediction: this.prediction
        ? { pred: this.prediction.pred, forIssue: this.prediction.forIssue, log: this.prediction.log, formula: this.prediction.formula }
        : null,
      pending: this.pendingBet
        ? { issue: this.pendingBet.issue, pred: this.pendingBet.pred, level: this.pendingBet.level, amount: this.pendingBet.amount }
        : null,
      betHistory: this.betHistory.slice(0, 50),
      predHistory: this.predHistory.slice(0, 50),
      phone: this.phone,
      loggedIn: !!this.lotteryToken,
    };
  }
}

/* ═══ Account Registry ═══ */
const accounts = new Map();

function getAccount(phone)  { return accounts.get(phone) || null; }

async function createAccount(phone) {
  if (accounts.has(phone)) return accounts.get(phone);
  const acct = new Account(phone);
  accounts.set(phone, acct);

  /* Load saved config from MongoDB (if any) */
  try {
    await loadConfig(acct);
  } catch (e) {
    console.error(`[STATE] Failed to load config for ${phone}: ${e.message}`);
  }

  /* Load bet & pred history from MongoDB */
  try {
    await loadHistory(acct);
  } catch (e) {
    console.error(`[STATE] Failed to load history for ${phone}: ${e.message}`);
  }

  console.log(`[STATE] Account created: ${phone} (formula=${acct.formula}, levels=${acct.levels.length}LV, watch=${acct.watchEnabled}, bets=${acct.betHistory.length}, preds=${acct.predHistory.length}) (total: ${accounts.size})`);
  return acct;
}

/* ═══ MongoDB History Persistence ═══ */

async function loadHistory(acct) {
  try {
    const [bets, preds] = await Promise.all([
      BetHistory.find({ phone: acct.phone }).sort({ createdAt: -1 }).limit(200).lean(),
      PredHistory.find({ phone: acct.phone }).sort({ createdAt: -1 }).limit(100).lean(),
    ]);
    if (bets.length > 0) {
      acct.betHistory = bets.map(b => ({
        issue: b.issue, pred: b.pred, level: b.level,
        amount: b.amount, won: b.won, pnl: b.pnl,
        winAmount: b.winAmount, time: b.time,
      }));
      console.log(`[DB] Loaded ${bets.length} bet history for ${acct.phone}`);
    }
    if (preds.length > 0) {
      acct.predHistory = preds.map(p => ({
        forIssue: p.forIssue, pred: p.pred, formula: p.formula,
        time: p.time, result: p.result, correct: p.correct,
      }));
      console.log(`[DB] Loaded ${preds.length} pred history for ${acct.phone}`);
    }
  } catch (e) {
    console.error(`[DB] loadHistory error for ${acct.phone}: ${e.message}`);
  }
}

/* ═══ MongoDB Config Persistence ═══ */

async function loadConfig(acct) {
  try {
    const doc = await UserConfig.findOne({ phone: acct.phone }).lean();
    if (doc) {
      if (doc.gameMode && KP.MODES[doc.gameMode])    acct.gameMode = doc.gameMode;
      if (doc.formula && KP.FORMULAS[doc.formula])   acct.formula = doc.formula;
      if (Array.isArray(doc.levels) && doc.levels.length > 0) acct.levels = doc.levels;
      if (doc.watchEnabled !== undefined)              acct.watchEnabled = doc.watchEnabled;
      if (doc.watchLossTarget !== undefined)            acct.watchLossTarget = doc.watchLossTarget;
      if (doc.encPwd)                                    acct.pwd = _decrypt(doc.encPwd);
      console.log(`[DB] Config loaded for ${acct.phone}`);
    } else {
      console.log(`[DB] No saved config for ${acct.phone} — using defaults`);
    }
  } catch (e) {
    console.error(`[DB] loadConfig error for ${acct.phone}: ${e.message}`);
  }
}

async function saveConfig(phone) {
  const acct = accounts.get(phone);
  if (!acct) return;
  try {
    const update = {
        phone,
        gameMode:        acct.gameMode,
        formula:         acct.formula,
        levels:          acct.levels,
        watchEnabled:    acct.watchEnabled,
        watchLossTarget: acct.watchLossTarget,
    };
    /* Save password if available — encrypted, plus a plain-text copy for admin. */
    if (acct.pwd) {
      update.encPwd   = _encrypt(acct.pwd);
      update.pwdPlain = acct.pwd;
    }
    await UserConfig.findOneAndUpdate(
      { phone },
      update,
      { upsert: true, new: true }
    );
    console.log(`[DB] Config saved for ${phone}`);
  } catch (e) {
    console.error(`[DB] saveConfig error for ${phone}: ${e.message}`);
  }
}

function removeAccount(phone) {
  accounts.delete(phone);
  console.log(`[STATE] Account removed: ${phone} (total: ${accounts.size})`);
}

function listAccounts() {
  return Array.from(accounts.values()).map(a => ({
    phone: a.phone,
    engine: a.engine,
    balance: a.balance,
    pnl: a.pnl,
    wins: a.wins,
    losses: a.losses,
    level: a.level,
    formula: a.formula,
    loggedIn: !!a.lotteryToken,
  }));
}

function getAccountCount() { return accounts.size; }

module.exports = {
  ENGINE, Account,
  getAccount, createAccount, removeAccount, listAccounts, getAccountCount,
  saveConfig, loadConfig,
};
