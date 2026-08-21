/* ═══════════════════════════════════════════
   KINGPIN — State Manager (Multi-Account, Multi-Platform)
   Each account = isolated state.
   accounts Map<acctId, Account>, where acctId is "platform:phone".

   The same phone can hold a separate account on each platform, with
   its own balance, tokens and bet history — so phone alone is not a
   unique key. Every registry lookup and every Mongo query is scoped
   by platform. Rows written before platforms existed are treated as
   GOA (see platforms.DEFAULT_PLATFORM and scripts/migrate-platform.js).
   ═══════════════════════════════════════════ */

const KP = require('./config');
const platforms = require('./platforms');
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

/** Composite registry key. Always use this rather than building the
 *  string by hand, so normalisation stays in one place. */
function acctId(platform, phone) {
  return `${platforms.resolve(platform)}:${String(phone || '').trim()}`;
}

class Account {
  constructor(platform, phone) {
    this.platform     = platforms.resolve(platform);
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

    /* Set when the max-level circuit breaker trips (engine.js processResult).
       Stays true across the stop so a DEFAULT_KEY session can see and fire a
       one-shot recovery bet (see the `manualBet` socket handler) instead of
       the account just sitting stopped. Cleared on the next start() (manual
       or normal), on formula/gameMode change, and on a stats reset. */
    this.maxLossActive = false;

    /* One-shot stake override for the manual recovery bet — set by
       manualBet(amount), consumed (and cleared) the moment attemptBet()
       reads getStake() for that single bet, then getStake() falls back
       to the normal ladder again. Lets the admin pick a specific amount
       instead of always retrying at the locked-in max-level stake. */
    this.manualStakeOverride = null;

    /* One-shot DIRECTION override for the manual recovery bet — set by
       manualBet(amount, side). A manual bet is defined by the admin's own
       BIG/SMALL choice, not the auto-formula's prediction; this is what
       makes it actually "manual". Consumed (and cleared) in engineStep()
       the moment the next real prediction is generated — see the
       manualPredOverride handling there for why start()'s own prediction
       call is NOT where this gets applied. */
    this.manualPredOverride = null;

    this.predState = {};
  }

  /* ═══ Getters ═══ */
  /** Registry key / Socket.IO room name for this account. */
  get id()         { return acctId(this.platform, this.phone); }
  /** Mongo scope for every per-account collection. */
  get scope()      { return { platform: this.platform, phone: this.phone }; }
  getPlatformName(){ return platforms.get(this.platform).name; }
  getStake()       { return this.manualStakeOverride != null ? this.manualStakeOverride : (this.levels[this.level - 1] || this.levels[this.levels.length - 1]); }
  getMaxLevel()    { return this.levels.length; }
  getTotalRisk()   { return this.levels.reduce((s, v) => s + v, 0); }
  getFormulaInfo() { return KP.FORMULAS[this.formula] || KP.FORMULAS[KP.DEFAULT_FORMULA]; }
  isRunning()      { return this.engine !== ENGINE.STOPPED; }
  getBets()        { return this.wins + this.losses; }

  /* ═══ Setters ═══ */
  setLevel(l)           { this.level = l; if (l > this.highestLevel) this.highestLevel = l; }
  setFormula(f)         { if (KP.FORMULAS[f]) { this.formula = f; this.maxLossActive = false; } }
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
    this.maxLossActive = false;   // recovery context (old formula/mode) no longer applies
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
      { ...this.scope, issue: entry.issue },
      { ...this.scope, ...entry },
      { upsert: true, new: true }
    ).catch(e => console.error(`[DB] saveBetHistory error: ${e.message}`));
  }

  addPredHistory(entry) {
    if (this.predHistory.length > 0 && this.predHistory[0].forIssue === entry.forIssue) {
      if (entry.result !== undefined) this.predHistory[0].result = entry.result;
      if (entry.correct !== undefined) this.predHistory[0].correct = entry.correct;
      /* Update existing record in DB */
      PredHistory.findOneAndUpdate(
        { ...this.scope, forIssue: entry.forIssue },
        { result: this.predHistory[0].result, correct: this.predHistory[0].correct },
      ).catch(e => console.error(`[DB] updatePredHistory error: ${e.message}`));
      return;
    }
    this.predHistory.unshift(entry);
    if (this.predHistory.length > 100) this.predHistory.pop();
    /* Persist to MongoDB (fire-and-forget) */
    PredHistory.findOneAndUpdate(
      { ...this.scope, forIssue: entry.forIssue },
      { ...this.scope, ...entry },
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
      { ...this.scope, forIssue: String(forIssue) },
      { result, correct },
    ).catch(e => console.error(`[DB] resolvePredHistory error: ${e.message}`));
  }

  resetSession() {
    this.level = 1; this.highestLevel = 1; this.pnl = 0; this.wins = 0; this.losses = 0;
    this.pendingBet = null; this.sessionStart = Date.now();
    this.watchPred = null; this.watchIssue = null; this.virtualWatches = 0;
    this.watchLossCount = 0; this.lastPredIssue = null; this.prediction = null;
    this.maxLossActive = false;   // "Reset" also dismisses the manual-bet recovery panel
    this.manualStakeOverride = null;
    this.manualPredOverride = null;
  }

  /* Reset only engine-internal state — keeps cumulative stats intact.
     preserveLevel: true keeps the current martingale level instead of
     resetting to LV1 — used by the manual-bet recovery flow (engine.js
     manualBet()) so a deliberate one-shot retry actually happens at the
     stake that tripped the circuit breaker, not a fresh LV1 bet. */
  resetEngineState(preserveLevel = false) {
    if (!preserveLevel) this.level = 1;
    this.pendingBet = null; this.sessionStart = Date.now();
    this.watchPred = null; this.watchIssue = null; this.virtualWatches = 0;
    this.watchLossCount = 0; this.lastPredIssue = null; this.prediction = null;
    this.maxLossActive = false;   // any start() (normal or manual-bet-triggered) leaves recovery mode
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
      maxLossActive: this.maxLossActive,
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
      platform: this.platform,
      platformName: this.getPlatformName(),
      id: this.id,
      loggedIn: !!this.lotteryToken,
    };
  }
}

/* ═══ Account Registry — keyed by "platform:phone" ═══ */
const accounts = new Map();

/** Look up by composite id, or by (platform, phone). */
function getAccount(platform, phone) {
  const id = phone === undefined ? platform : acctId(platform, phone);
  return accounts.get(id) || null;
}

async function createAccount(platform, phone) {
  const acct = new Account(platform, phone);
  const id   = acct.id;
  if (accounts.has(id)) return accounts.get(id);
  accounts.set(id, acct);

  /* Load saved config from MongoDB (if any) */
  try {
    await loadConfig(acct);
  } catch (e) {
    console.error(`[STATE] Failed to load config for ${id}: ${e.message}`);
  }

  /* Load bet & pred history from MongoDB */
  try {
    await loadHistory(acct);
  } catch (e) {
    console.error(`[STATE] Failed to load history for ${id}: ${e.message}`);
  }

  console.log(`[STATE] Account created: ${id} (formula=${acct.formula}, levels=${acct.levels.length}LV, watch=${acct.watchEnabled}, bets=${acct.betHistory.length}, preds=${acct.predHistory.length}) (total: ${accounts.size})`);
  return acct;
}

/* ═══ MongoDB History Persistence ═══ */

async function loadHistory(acct) {
  try {
    const [bets, preds] = await Promise.all([
      BetHistory.find(acct.scope).sort({ createdAt: -1 }).limit(200).lean(),
      PredHistory.find(acct.scope).sort({ createdAt: -1 }).limit(100).lean(),
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
    const doc = await UserConfig.findOne(acct.scope).lean();
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

/** Persist config. Accepts a composite id or (platform, phone). */
async function saveConfig(platform, phone) {
  const acct = getAccount(platform, phone);
  if (!acct) return;
  try {
    const update = {
        ...acct.scope,
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
      acct.scope,
      update,
      { upsert: true, new: true }
    );
    console.log(`[DB] Config saved for ${acct.id}`);
  } catch (e) {
    console.error(`[DB] saveConfig error for ${acct.id}: ${e.message}`);
  }
}

/** Remove from the registry. Accepts a composite id or (platform, phone). */
function removeAccount(platform, phone) {
  const id = phone === undefined ? platform : acctId(platform, phone);
  accounts.delete(id);
  console.log(`[STATE] Account removed: ${id} (total: ${accounts.size})`);
}

function listAccounts() {
  return Array.from(accounts.values()).map(a => ({
    id: a.id,
    phone: a.phone,
    platform: a.platform,
    platformName: a.getPlatformName(),
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
  ENGINE, Account, acctId,
  getAccount, createAccount, removeAccount, listAccounts, getAccountCount,
  saveConfig, loadConfig,
};
