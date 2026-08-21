/* ═══════════════════════════════════════════
   KINGPIN 3.0 — Betting Engine (Multi-Account)
   AccountEngine class — one instance per account.
   Each instance has its own timers, state, logs.
   Broadcasts via Socket.IO rooms (phone-scoped).
   ═══════════════════════════════════════════ */

const KP      = require('./config');
const state   = require('./state');
const predict = require('./prediction');
const api     = require('./api');
const proxy   = require('./proxy');

const E = state.ENGINE;

/* ── Constants ── */
const STUCK_TIMEOUT    = 90000;
const FETCH_COOLDOWN   = 2000;
const PASSIVE_TICK_MS  = 1000;
const PASSIVE_FETCH_CD = 5000;

/* ── Shared draw history — one buffer PER GAME MODE (30S and 1M differ) ── */
const _sharedByMode = {};   // gameMode -> { buf:[], fetchTime:0, lastIssue:null }
function _modeSlot(mode) {
  if (!_sharedByMode[mode]) _sharedByMode[mode] = { buf: [], fetchTime: 0, lastIssue: null };
  return _sharedByMode[mode];
}
// io instance is set by setIO() called from index.js
let _globalIO = null;
function setIO(ioInstance) { _globalIO = ioInstance; }

async function fetchSharedDrawHistory(force, gameMode = KP.GAME_MODE) {
  const slot = _modeSlot(gameMode);
  const now = Date.now();
  if (!force && now - slot.fetchTime < FETCH_COOLDOWN && slot.buf.length > 0) {
    return slot.buf;
  }
  slot.fetchTime = now;
  try {
    const d = await api.getDrawHistory(20, gameMode);
    const list = d?.data?.list;
    if (Array.isArray(list) && list.length > 0) {
      slot.buf = list.map(r => ({
        issueNumber: String(r.issueNumber),
        number: parseInt(r.number),
        color: r.color || '',
      }));
      // Emit newDraw event (tagged with gameMode so clients filter by their mode)
      const latest = slot.buf[0];
      if (latest && latest.issueNumber !== slot.lastIssue) {
        slot.lastIssue = latest.issueNumber;
        const bs = latest.number >= 5 ? 'B' : 'S';
        if (_globalIO) {
          _globalIO.emit('newDraw', { issue: latest.issueNumber, number: latest.number, bs, gameMode });
        }
      }
    }
  } catch (e) { /* silent */ }
  return slot.buf;
}

/* ── Helpers (stateless) ── */
function randomDelay(range) {
  return range[0] + Math.floor(Math.random() * (range[1] - range[0]));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function periodInfo(gameMode = KP.GAME_MODE) {
  const now = proxy.syncedNow();
  const cycle  = KP.modeCycleMs(gameMode);
  const offset = KP.modeOffset(gameMode);
  const adjusted = (now - offset) % cycle;
  const pos = adjusted < 0 ? adjusted + cycle : adjusted;
  const left = cycle - pos;
  const secs = Math.ceil(left / 1000);
  return { pos, left, secs };
}

/* ═══════════════════════════════════════════
   AccountEngine class
   ═══════════════════════════════════════════ */
class AccountEngine {
  constructor(acct, io) {
    this.acct = acct;    // Account instance from state.js
    this.io   = io;      // Socket.IO server instance

    this._tick            = null;
    this._balInterval     = null;
    this._passiveTick     = null;
    this._stuckSince      = 0;
    this._betPlacedAt     = 0;
    this._showResultUntil = 0;
    this._lastResolvedIssue  = null;
    this._safetySkippedIssue = null;
    this._deepHistoryLoaded  = false;
    this._lastFetchTime   = 0;
    this._passiveFetchTime = 0;
    this._busy    = false;
    this._polling = false;
    this._tickCount = 0;
    this._logs = [];
    this._consecutiveFailures = 0;
    this._failedIssues = new Set();
    this._manualBetTrace = false;   // verbose [TRACE] logging window — see manualBet()/_trace()

    console.log(`[ENGINE] Created for account: ${acct.id}`);
  }

  /* ═══ Broadcast (room-scoped) ═══ */
  broadcast(event, data) {
    if (!this.io) return;
    /* Room name is the composite "platform:phone" id (see state.js
       Account#id) — matches what index.js joins sockets to, so the
       same phone on two platforms never leaks into each other's room. */
    const room = this.acct.id;
    if (event) {
      this.io.to(room).emit(event, data);
    } else {
      const snap = this.acct.snapshot();
      /* Diagnostic: whenever a state broadcast goes out while
         maxLossActive is set, log whether anyone is actually in the
         room to receive it. If sockets_in_room is 0, the account's
         flag is fine but nothing's listening — a room/view mismatch,
         not a maxLossActive bug. Remove once the manual-bet visibility
         issue is confirmed fixed. */
      if (snap.maxLossActive) {
        const roomSet = this.io.sockets.adapter.rooms.get(room);
        console.log(`[MAXLOSS-DEBUG] broadcasting state for room="${room}" engine=${snap.engine} maxLossActive=${snap.maxLossActive} level=${snap.level} stake=${snap.stake} sockets_in_room=${roomSet ? roomSet.size : 0}`);
      }
      this.io.to(room).emit('state', snap);
    }
  }

  log(msg, cls) {
    const entry = { msg, cls, t: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) };
    this._logs.unshift(entry);
    if (this._logs.length > 100) this._logs.pop();
    console.log(`[ENGINE:${this.acct.phone}] ${msg}`);
    this.broadcast('log', entry);
  }

  toast(title, msg, type) {
    this.broadcast('toast', { title, msg, type });
  }

  getLogs() { return this._logs.slice(0, 50); }

  /* ═══ Auto Re-Login ═══ */
  async tryRelogin() {
    const phone = this.acct.phone;
    const pwd   = this.acct.pwd;
    if (!pwd) {
      this.log('🔐 No saved password — cannot auto-relogin', 'l-err');
      return false;
    }
    this.log('🔐 Attempting auto re-login...', 'l-info');
    this.toast('Re-Login', 'Token expired — reconnecting...', 'info');
    try {
      const res = await proxy.relogin(this.acct.platform, phone, pwd);
      if (res.ok) {
        this.acct.lotteryToken = res.lotteryToken || '';
        this.acct.webapiToken  = res.webapiToken  || '';
        this.log('🔐 ✅ Auto re-login SUCCESS — tokens refreshed', 'l-info');
        this.toast('Re-Login OK', 'Session restored!', 'info');
        /* Notify connected clients to update their stored tokens */
        this.broadcast('reauth', { phone, platform: this.acct.platform, lotteryToken: res.lotteryToken, webapiToken: res.webapiToken });
        this.broadcast();
        return true;
      } else {
        this.log(`🔐 ❌ Auto re-login FAILED: ${res.msg}`, 'l-err');
        this.toast('Re-Login Failed', res.msg || 'Please login manually', 'error');
        return false;
      }
    } catch (e) {
      this.log(`🔐 ❌ Re-login error: ${e.message}`, 'l-err');
      return false;
    }
  }
  /* ═══ Data Fetch ═══ */
  async fetchDrawHistory(force = false) {
    const now = Date.now();
    if (!force && now - this._lastFetchTime < FETCH_COOLDOWN) return this.acct.histBuf?.length > 0;
    this._lastFetchTime = now;

    try {
      /* DNA formula: deep history on first load */
      if ((this.acct.formula === 'dna3' || this.acct.formula === 'oracle') && !this._deepHistoryLoaded) {
        const icon = this.acct.formula === 'oracle' ? '🔮' : '🧬';
        this.log(`${icon} Loading 160-record deep history...`, 'l-info');
        const deep = await api.getDeepHistory(this.acct, 160);
        const deepList = deep?.data?.list;
        if (Array.isArray(deepList) && deepList.length > 20) {
          const hist = deepList.map(r => ({
            issueNumber: String(r.issueNumber),
            number: parseInt(r.number),
            color: r.color || '',
          }));
          this.acct.histBuf = hist;
          this._deepHistoryLoaded = true;
          this.log(`${icon} Deep history loaded: ${hist.length} records`, 'l-info');
          return true;
        }
        this.log(`${icon} Deep history failed — falling back to public API`, 'l-warn');
      }

      /* Standard: shared public draw API (one call per mode, shared across same-mode accounts) */
      const sharedHist = await fetchSharedDrawHistory(force, this.acct.gameMode);

      if (sharedHist.length > 0) {
        /* For DNA: merge into existing deep buffer */
        if (this._deepHistoryLoaded && this.acct.histBuf.length > 20) {
          const existingBuf = this.acct.histBuf;
          const latestExisting = existingBuf[0]?.issueNumber;
          const newRecords = [];
          for (const r of sharedHist) {
            if (String(r.issueNumber) === latestExisting) break;
            newRecords.push({ issueNumber: String(r.issueNumber), number: parseInt(r.number), color: r.color || '' });
          }
          if (newRecords.length > 0) {
            this.acct.histBuf = [...newRecords, ...existingBuf].slice(0, 200);
          }
          return true;
        }

        /* Standard: copy shared history */
        this.acct.histBuf = sharedHist.slice();
        return true;
      }
    } catch (e) { /* silent */ }
    return false;
  }

  async fetchBalance() {
    try {
      const d = await api.getBalance(this.acct);
      if (d && d.code === 0 && d.data != null) {
        const bal = parseFloat(d.data.totalMoney || d.data.balance || d.data);
        if (!isNaN(bal)) {
          this.acct.balance = bal;
          this.broadcast();
          return bal;
        }
      }
      /* Token expired → try auto re-login */
      if (d && (d.code === 4 || d.code === 401 || d.code === 403)) {
        const relogged = await this.tryRelogin();
        if (relogged) {
          /* Retry balance fetch with new tokens */
          try {
            const d2 = await api.getBalance(this.acct);
            if (d2 && d2.code === 0 && d2.data != null) {
              const bal2 = parseFloat(d2.data.totalMoney || d2.data.balance || d2.data);
              if (!isNaN(bal2)) { this.acct.balance = bal2; this.broadcast(); return bal2; }
            }
          } catch (_) { /* fall through */ }
        }
        this.log('🔐 Session expired — stopping engine', 'l-err');
        this.toast('Session Expired', 'Please log in again', 'error');
        this.stop();
        return 0;
      }
    } catch (e) { /* silent */ }
    return this.acct.balance;
  }

  /* ═══ Refresh GOA Bet Record ═══ */
  async refreshBetRecord() {
    try {
      const result = await api.getBetRecord(this.acct, 1, 10);
      this.broadcast('betRecord', { page: 1, result });
    } catch (e) { /* silent */ }
  }

  /* ═══ ENGINE START ═══
     preserveLevel: keep the current martingale level instead of resetting
     to LV1 — used internally by manualBet() to retry at the stake that
     tripped the circuit breaker. Normal starts (button click, reconnect)
     always reset to LV1 as before.
     forceReal: skip Watch Mode even if acct.watchEnabled is on — used by
     manualBet() so a recovery click always places an actual bet. Without
     this, an account with Watch Mode on would resume into WATCHING and
     sit there tracking virtual results, never placing the real bet the
     admin just asked for — confirmed bug, this is the fix. */
  async start(preserveLevel = false, forceReal = false) {
    if (this.acct.isRunning()) return;

    this.acct.resetEngineState(preserveLevel);
    predict.reset(this.acct.predState);
    this._stuckSince = 0;
    this._lastResolvedIssue = null;
    this._deepHistoryLoaded = false;
    this._busy = false;
    this._tickCount = 0;
    this._consecutiveFailures = 0;
    this._failedIssues = new Set();

    const watchOn = forceReal ? false : this.acct.watchEnabled;
    this.acct.engine = watchOn ? E.WATCHING : E.WAITING;

    const info = this.acct.getFormulaInfo();
    const lvls = this.acct.levels;
    const curLv = this.acct.level;
    const curStake = this.acct.getStake();

    this.log(`▶ Engine STARTED | ${info.name} | LV${curLv} (₹${curStake}) | Max LV${lvls.length}${watchOn ? ' | 👁️ Watch' : ''}`, 'l-info');
    this.toast('Engine Started', watchOn ? 'Watch mode — observing...' : `LV${curLv} · ₹${curStake}`, 'info');
    this._trace(`start() preserveLevel=${preserveLevel} forceReal=${forceReal} watchEnabled=${this.acct.watchEnabled} → engine=${this.acct.engine} level=${curLv} stake=${curStake} manualStakeOverride=${this.acct.manualStakeOverride}`);

    /* Fetch initial data + balance */
    await this.fetchDrawHistory(true);
    await this.fetchBalance();

    /* Generate first prediction (SHARED — identical for every account on this
       gameMode+formula; staking stays per-account). */
    const pred = predict.runShared(this.acct.histBuf, this.acct.formula, this.acct.gameMode);
    this.acct.prediction = pred;
    /* Set lastPredIssue here so engineStep() doesn't re-run predict for the same period */
    if (pred.forIssue) this.acct.lastPredIssue = pred.forIssue;
    if (pred.pred !== 'WAIT') {
      this.log(`🔮 ${info.name}: ${pred.pred} for ...${pred.forIssue.slice(-5)} — ${pred.log}`, 'l-info');
      this.acct.addPredHistory({
        forIssue: pred.forIssue,
        pred: pred.pred.toUpperCase(),
        formula: pred.formula || this.acct.formula,
        time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      });
    }

    this.broadcast();

    /* Main tick loop */
    if (this._tick) clearInterval(this._tick);
    this._tick = setInterval(() => this.engineStep(), KP.ENGINE_TICK);

    /* Balance refresh every 30s */
    if (this._balInterval) clearInterval(this._balInterval);
    this._balInterval = setInterval(() => this.fetchBalance(), 30000);

    /* Stop passive when engine running */
    this.stopPassive();
  }

  /* ═══ ENGINE STOP ═══ */
  stop() {
    if (!this.acct.isRunning()) return;
    this.acct.engine = E.STOPPED;

    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._balInterval) { clearInterval(this._balInterval); this._balInterval = null; }

    this.acct.pendingBet = null;
    this._stuckSince = 0;
    this._busy = false;
    this._polling = false;

    this.log(`■ Engine STOPPED | Bets:${this.acct.getBets()} W:${this.acct.wins} L:${this.acct.losses} P&L:${this.acct.pnl >= 0 ? '+' : ''}₹${this.acct.pnl.toFixed(2)}`, 'l-info');
    this.toast('Engine Stopped', `${this.acct.getBets()} bets · ${this.acct.pnl >= 0 ? '+' : ''}₹${this.acct.pnl.toFixed(2)}`, 'info');

    this.broadcast();

    /* Restart passive loop */
    this.startPassive();
  }

  /* ═══ MANUAL RECOVERY BET ═══
     One-shot resume after the max-level circuit breaker, fired by a
     DEFAULT_KEY session from the dashboard (see the `manualBet` socket
     handler in index.js, which is the actual authorization gate — this
     method only checks the account is actually in that state).

     customAmount (optional): a preferred stake for THIS one bet, in
     place of the ladder's max-level amount. It does NOT touch the level
     index — level stays wherever it was, so if this bet loses, the
     circuit breaker re-trips exactly as it would have at the normal
     stake, and the next manual click can pick a different amount again.
     Consumed by attemptBet() the moment it reads getStake() for this
     bet; a win resets to LV1 and normal ladder staking resumes.

     A win resets to LV1 and the engine keeps running (normal autobet
     continues); a loss re-trips the breaker immediately (nextLv >
     maxLevel again) and re-stops with maxLossActive set, so another
     manual click is needed — it never silently keeps firing on its own. */
  async manualBet(customAmount) {
    this._manualBetTrace = true;   // verbose tracing until this bet resolves — see _trace()
    this._trace(`manualBet(${customAmount}) called — maxLossActive=${this.acct.maxLossActive} isRunning=${this.acct.isRunning()} watchEnabled=${this.acct.watchEnabled}`);
    if (!this.acct.maxLossActive || this.acct.isRunning()) {
      this._trace(`manualBet() REJECTED — nothing to recover from (maxLossActive=${this.acct.maxLossActive}) or already running (isRunning=${this.acct.isRunning()})`);
      this._manualBetTrace = false;
      return false;
    }

    const amt = Number(customAmount);
    if (Number.isFinite(amt) && amt > 0) {
      this.acct.manualStakeOverride = Math.floor(amt);
    }
    const stakeForLog = this.acct.manualStakeOverride ?? this.acct.getStake();

    this.log(`🎯 Manual recovery bet — resuming at LV${this.acct.level} (₹${stakeForLog})`, 'l-info');
    this.toast('Manual Bet', `Retrying at LV${this.acct.level} · ₹${stakeForLog}`, 'info');
    await this.start(true, true);   // preserveLevel + forceReal — same level, never Watch Mode
    return true;
  }

  /* Verbose tracing, gated to only the window around a manual recovery
     bet (armed in manualBet(), disarmed once processResult() finishes
     resolving it) — deliberately not always-on so normal autobet ticks
     every 500ms don't get buried in log noise. */
  _trace(msg) {
    if (this._manualBetTrace) console.log(`[TRACE:${this.acct.id}] ${msg}`);
  }

  /* ═══ ENGINE STEP (runs every 500ms) ═══ */
  async engineStep() {
    this._tickCount++;
    if (!this.acct.isRunning() || this._busy) {
      this._trace(`tick #${this._tickCount}: SKIPPED — isRunning=${this.acct.isRunning()} busy=${this._busy}`);
      return;
    }

    /* Broadcast countdown */
    const pi = periodInfo(this.acct.gameMode);
    this.broadcast('countdown', { secs: pi.secs, total: KP.modeCycleMs(this.acct.gameMode) / 1000 });
    this._trace(`tick #${this._tickCount}: engine=${this.acct.engine} pendingBet=${this.acct.pendingBet ? this.acct.pendingBet.issue : 'none'} periodSecsLeft=${pi.secs} lastPredIssue=${this.acct.lastPredIssue}`);

    /* ── Pending bet: poll + status ── */
    if (this.acct.pendingBet) {
      if (!this._stuckSince) this._stuckSince = Date.now();
      if (Date.now() - this._stuckSince > STUCK_TIMEOUT) {
        this.log(`⚠️ Stuck for ${Math.round(STUCK_TIMEOUT / 1000)}s — auto-recovering`, 'l-err');
        this.acct.pendingBet = null;
        this._stuckSince = 0;
        this._polling = false;
        this.broadcast();
        return;
      }

      const pend = this.acct.pendingBet;
      if (!pend) return;

      /* Show BET ACTIVE */
      const drawSecs = periodInfo(this.acct.gameMode).secs;
      this.broadcast('betStatus', {
        icon: '📊', label: 'BET ACTIVE',
        detail: `${pend.pred} ₹${pend.amount} on ...${pend.issue.slice(-5)}`,
        cls: 'placed', timer: `Draw in ${drawSecs}s`, bar: '50'
      });

      /* Fetch draw history every 1s and check if our result exists — no clock gate */
      if (!this._polling) {
        if (!pend.pollStart) pend.pollStart = Date.now();
        const sinceLast = Date.now() - (pend._lastFetch || 0);
        if (sinceLast >= 1000) {
          this._polling = true;
          try {
            pend._lastFetch = Date.now();
            const modeBuf = await fetchSharedDrawHistory(true, this.acct.gameMode);
            const found = modeBuf.find(r => String(r.issueNumber) === pend.issue);
            if (found) {
              await this.resolveResult(pend, found);
              return;
            }
            /* Timeout → balance fallback (per-mode: 1M results take ~1 min to publish) */
            if (Date.now() - pend.pollStart > KP.modePollTimeout(this.acct.gameMode)) {
              this.log(`⚠️ Draw result timeout — using balance fallback`, 'l-err');
              await this.fetchBalance();
              await this.processResult(null);
            }
          } catch (err) { /* next tick retries */ }
          finally { this._polling = false; }
        }
      }
      return;
    }
    this._stuckSince = 0;

    /* Hold WIN/LOSS display */
    if (this._showResultUntil > 0 && Date.now() < this._showResultUntil) return;
    if (this._showResultUntil > 0) this._showResultUntil = 0;

    /* Fetch fresh data + predict */
    this._busy = true;
    try {
      await this.fetchDrawHistory();
      const histBuf = this.acct.histBuf;
      if (!histBuf || histBuf.length < 1) { this._busy = false; return; }

      /* Resolve previous predictions against actual results */
      for (let i = 0; i < Math.min(this.acct.predHistory.length, 10); i++) {
        const ph = this.acct.predHistory[i];
        if (ph.correct !== undefined) continue;
        const match = histBuf.find(r => String(r.issueNumber) === String(ph.forIssue));
        if (match) {
          const actualBS = match.number >= 5 ? 'BIG' : 'SMALL';
          this.acct.resolvePredHistory(ph.forIssue, actualBS, ph.pred.toUpperCase() === actualBS);
        }
      }

      /* Guard: skip re-running predict.run() for same period.
         Must happen BEFORE predict.run() — stateful formulas (ZigZag, ZN1P, Oracle…)
         mutate predState on every call, so calling them twice per period corrupts state. */
      const nextIssue = predict.currentIssueNumber(histBuf);
      /* Prune stale blacklist entries — any failed issue now in the PAST. This keeps
         only the CURRENT issue guarded (so we never double-bet or spam it this period)
         while guaranteeing a past failure can never permanently wedge future periods
         ("already failed this session" stall). */
      if (nextIssue && this._failedIssues.size) {
        for (const iss of this._failedIssues) {
          try { if (BigInt(iss) < BigInt(nextIssue)) this._failedIssues.delete(iss); }
          catch { this._failedIssues.delete(iss); }
        }
      }
      if (nextIssue && nextIssue === this.acct.lastPredIssue) {
        this._trace(`tick #${this._tickCount}: still same period (nextIssue=${nextIssue} === lastPredIssue) — waiting for it to roll over, no bet yet`);
        this.broadcast();
        this._busy = false;
        return;
      }
      this._trace(`tick #${this._tickCount}: NEW PERIOD — nextIssue=${nextIssue} !== lastPredIssue=${this.acct.lastPredIssue} — generating prediction`);

      /* Generate prediction — only once per new period (SHARED across accounts) */
      const pred = predict.runShared(histBuf, this.acct.formula, this.acct.gameMode);
      this.acct.prediction = pred;
      this._trace(`prediction: pred=${pred.pred} forIssue=${pred.forIssue} formula=${pred.formula} noRecovery=${!!pred.noRecovery} log="${pred.log}"`);

      /* Record prediction in history */
      if (pred && pred.pred !== 'WAIT' && pred.forIssue) {
        this.acct.addPredHistory({
          forIssue: pred.forIssue,
          pred: pred.pred.toUpperCase(),
          formula: pred.formula || this.acct.formula,
          time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
        });
      }

      this.broadcast();

      /* New period detected */
      if (!pred.forIssue || pred.pred === 'WAIT') {
        /* Recovery: override WAIT when the FORMULA is on a losing streak.
           Driven by the shared streak (not per-account level) so the recovery
           DIRECTION is identical for every account; only the stake differs.
           Formulas that set pred.noRecovery (e.g. N1 1Auto) opt OUT — their
           WAIT is an intentional skip and must never be turned into a bet. */
        if (!pred.noRecovery && predict.sharedStreak(this.acct.gameMode, this.acct.formula) > 1) {
          const fallback = predict.recoveryFallback(histBuf);
          if (fallback) {
            this.log(`🔥 Recovery LV${this.acct.level}: WAIT → ${fallback.pred}`, 'l-bet');
            this.acct.prediction = fallback;
            this.acct.lastPredIssue = fallback.forIssue;
            this.acct.addPredHistory({
              forIssue: fallback.forIssue,
              pred: fallback.pred.toUpperCase(),
              formula: fallback.formula || this.acct.formula,
              time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
            });
            this.broadcast();
            await this.handleNewPeriod(fallback);
            this._busy = false;
            return;
          }
        }
        this.log(`⏳ Skip — prediction WAIT for ...${(pred.forIssue || '?').slice(-5)}`, 'l-skip');
        if (pred.forIssue) this.acct.lastPredIssue = pred.forIssue;
        this._busy = false;
        return;
      }

      /* If this issue was already safety-skipped */
      if (pred.forIssue === this._safetySkippedIssue) {
        this._busy = false;
        return;
      }
      this._safetySkippedIssue = null;
      this.acct.lastPredIssue = pred.forIssue;
      this._trace(`calling handleNewPeriod() for issue=${pred.forIssue} pred=${pred.pred} engine=${this.acct.engine}`);
      await this.handleNewPeriod(pred);
    } catch (err) {
      this.log(`⚠️ ${err.message}`, 'l-err');
    } finally {
      this._busy = false;
    }
  }

  /* ═══ NEW PERIOD HANDLER ═══ */
  async handleNewPeriod(pred) {
    const engine = this.acct.engine;
    this._trace(`handleNewPeriod() entry — engine=${engine} (${engine === E.WATCHING ? 'WATCH mode — will NOT place a real bet unless a virtual loss threshold trips' : 'real betting — will proceed to attemptBet()'})`);

    /* ── WATCHING mode ── */
    if (engine === E.WATCHING) {
      const watchPred = this.acct.watchPred;
      const watchIssue = this.acct.watchIssue;

      if (watchPred && watchIssue) {
        const histBuf = this.acct.histBuf;
        const resolved = histBuf.find(r => String(r.issueNumber) === watchIssue);
        if (resolved) {
          const actualBS = resolved.number >= 5 ? 'Big' : 'Small';
          const correct = (watchPred === actualBS);
          this.acct.virtualWatches++;

          if (correct) {
            this.acct.watchLossCount = 0;
            this.log(`👁️ Watch ✅ ${watchPred} correct (${resolved.number}=${actualBS}) · Still watching...`, 'l-skip');
          } else {
            this.acct.watchLossCount++;
            const lossCount = this.acct.watchLossCount;
            const lossTarget = this.acct.watchLossTarget;

            if (lossCount >= lossTarget) {
              this.log(`👁️ Watch ❌ ${watchPred} WRONG (${resolved.number}=${actualBS}) · ${lossCount}/${lossTarget} losses → Real betting starts!`, 'l-info');
              this.toast('Watch Triggered!', `${lossCount} virtual loss${lossCount > 1 ? 'es' : ''} → real betting starts`, 'info');
              this.acct.engine = E.WAITING;
              this.acct.watchPred = null;
              this.acct.watchIssue = null;
              this.acct.watchLossCount = 0;
              this.broadcast('betStatus', { icon: '⏳', label: 'READY', detail: 'Watch triggered — waiting for next bet window', cls: 'waiting', timer: '', bar: '0' });
            } else {
              this.log(`👁️ Watch ❌ ${watchPred} WRONG (${resolved.number}=${actualBS}) · ${lossCount}/${lossTarget} losses — still watching...`, 'l-skip');
            }
          }
        } else {
          /* Watch result not in buffer yet */
          this.log(`👁️ Watch: result for ...${watchIssue.slice(-5)} not in buffer yet — waiting...`, 'l-skip');
          this.acct.lastPredIssue = null;
          this.broadcast();
          return;
        }
      }

      /* Still watching? Record and return */
      if (this.acct.engine === E.WATCHING) {
        this.acct.watchPred = pred.pred;
        this.acct.watchIssue = pred.forIssue;
        this.log(`👁️ Watching: ${pred.pred} for ...${pred.forIssue.slice(-5)}`, 'l-skip');
        this.broadcast('betStatus', { icon: '👁️', label: 'WATCHING', detail: `${pred.pred} for ...${pred.forIssue.slice(-5)}`, cls: 'watching', timer: '', bar: '0' });
        this.broadcast();
        return;
      }

      /* Watch just triggered → fall through to place real bet */
    }

    /* ── WAITING/BETTING: Place real bet ── */
    this._trace(`handleNewPeriod() falling through to attemptBet() for issue=${pred.forIssue}`);
    await this.attemptBet(pred);
  }

  /* ═══ BET ATTEMPT ═══ */
  async attemptBet(pred) {
    this._trace(`attemptBet() entry — issue=${pred.forIssue} pred=${pred.pred} level=${this.acct.level} manualStakeOverride=${this.acct.manualStakeOverride}`);
    /* Hard guards */
    if (this._failedIssues.has(pred.forIssue)) {
      this.log(`⛔ Skipping ...${pred.forIssue.slice(-5)} — already failed this session`, 'l-skip');
      this._trace(`attemptBet() BLOCKED — issue=${pred.forIssue} is in _failedIssues (this session already gave up on it)`);
      return;
    }
    if (this._lastResolvedIssue && pred.forIssue === this._lastResolvedIssue) {
      this.log(`⛔ Blocked duplicate bet on resolved ...${pred.forIssue.slice(-5)}`, 'l-skip');
      this._trace(`attemptBet() BLOCKED — issue=${pred.forIssue} already resolved as _lastResolvedIssue`);
      return;
    }
    const betHist = this.acct.betHistory;
    if (betHist.some(b => b.issue === pred.forIssue)) {
      this.log(`⛔ Blocked duplicate — already bet on ...${pred.forIssue.slice(-5)}`, 'l-skip');
      this._trace(`attemptBet() BLOCKED — issue=${pred.forIssue} already appears in betHistory`);
      return;
    }

    /* Desync check */
    const histBuf = this.acct.histBuf;
    if (histBuf.length > 0 && pred.forIssue) {
      const latestIss = histBuf[0].issueNumber;
      if (BigInt(pred.forIssue) <= BigInt(latestIss)) {
        this.log(`🚨 DESYNC: pred for ...${pred.forIssue.slice(-5)} but data has ...${latestIss.slice(-5)} — skipping`, 'l-err');
        this._trace(`attemptBet() BLOCKED — DESYNC: pred.forIssue=${pred.forIssue} <= latest known issue=${latestIss}`);
        this.acct.lastPredIssue = null;
        return;
      }
    }

    /* Safety check: enough time left? (per-mode — 1M skips a wider tail to dodge the boundary) */
    const pi = periodInfo(this.acct.gameMode);
    const safetyMs = KP.modeSafetyMs(this.acct.gameMode, this.acct.level > 1);

    if (pi.left < safetyMs) {
      this.log(`⏳ Only ${pi.secs}s left — waiting for next period`, 'l-skip');
      this._trace(`attemptBet() SKIPPED — only ${pi.left}ms left in period, need ${safetyMs}ms safety margin — will retry next period`);
      this._safetySkippedIssue = pred.forIssue;
      this.acct.lastPredIssue = null;
      return;
    }

    /* Human delay */
    const level = this.acct.level;
    const delay = level === 1 ? randomDelay(KP.DELAY_LOSS_LV1) : randomDelay(KP.DELAY_LOSS_REC);

    this.log(`⏳ Betting in ${(delay / 1000).toFixed(1)}s...`, 'l-dim');
    this.broadcast('betStatus', { icon: '⏳', label: 'PREPARING', detail: `Waiting ${(delay / 1000).toFixed(1)}s...`, cls: 'waiting', timer: '', bar: '0' });
    this._trace(`attemptBet() PREPARING — sleeping ${delay}ms before placing (betStatus broadcast sent, this is what abBetStatus should show right now)`);
    await sleep(delay);

    /* Re-check safety after delay */
    const pi2 = periodInfo(this.acct.gameMode);
    if (pi2.left < safetyMs) {
      this.log(`⏳ Time ran out during delay — waiting for next period`, 'l-skip');
      this._trace(`attemptBet() SKIPPED after delay — time ran out (${pi2.left}ms left < ${safetyMs}ms safety) — will retry next period`);
      this._safetySkippedIssue = pred.forIssue;
      this.acct.lastPredIssue = null;
      return;
    }

    if (!this.acct.isRunning()) {
      this._trace(`attemptBet() ABORTED after delay — engine no longer running (stopped mid-delay)`);
      return;
    }

    /* Place bet */
    this.acct.engine = E.BETTING;
    const stake = this.acct.getStake();
    /* Consume the manual-bet override here — this is the one bet it was
       set for. Retries below (code:13/7/network) reuse this local `stake`
       const, not a fresh getStake() call, so clearing now doesn't affect
       them; the NEXT bet after this one (win-continue or next manual
       click) correctly falls back to the normal ladder. */
    this.acct.manualStakeOverride = null;
    const issueNumber = pred.forIssue;
    const betContent = pred.pred === 'Big' ? 'BigSmall_Big' : 'BigSmall_Small';

    this._trace(`attemptBet() stake resolved to ₹${stake} (manualStakeOverride consumed) — balance=₹${this.acct.balance}`);

    /* Insufficient balance */
    if (this.acct.balance < stake) {
      this.log(`🚫 Insufficient balance: ₹${this.acct.balance.toFixed(2)} < ₹${stake} needed`, 'l-err');
      this.toast('Insufficient Balance', `Need ₹${stake}, have ₹${this.acct.balance.toFixed(2)}`, 'error');
      this._trace(`attemptBet() ABORTED — insufficient balance (₹${this.acct.balance} < ₹${stake}) — calling stop(). This is silent in the UI beyond a toast: no betStatus event fires here, engine just goes to STOPPED.`);
      this.stop();
      return;
    }

    this.broadcast('betStatus', { icon: '🎯', label: 'BETTING', detail: `${pred.pred} ₹${stake} on ...${issueNumber.slice(-5)}`, cls: 'betting', timer: '', bar: '0' });
    this.log(`🎯 ${pred.pred} ₹${stake} on ...${issueNumber.slice(-5)} | LV${level}`, 'l-bet');
    this.broadcast();
    this._trace(`attemptBet() BETTING broadcast sent — calling api.placeBet(issue=${issueNumber}, stake=${stake}, betContent=${betContent}) NOW`);

    this._betPlacedAt = Date.now();
    let result = await api.placeBet(this.acct, issueNumber, stake, betContent);
    this._trace(`api.placeBet() returned: code=${result.code} msg=${JSON.stringify(result.msg)}`);

    /* Retry: code:13 (period not available) */
    if (result.code === 13) {
      /* "issue number does not exist" — the freshly-opened period isn't live on the
         bet API yet: the draw CDN flips a beat BEFORE the bet endpoint opens the next
         period. latest+1 IS the correct period (proven — winning bets land on it), so
         re-attempt the SAME issue with short backoff until it opens or the safety
         margin closes.
         Crucially we do NOT block on a full draw-history refresh each loop — that fetch
         can hang up to 8 s on a CDN timeout and blow the whole betting window, which is
         exactly what turns a transient race into a hard "Bet Failed" skip during
         network bursts. We only refresh once every few misses to detect a GENUINE
         period advance; if it advanced we abandon (never re-fire a stale BIG/SMALL onto
         a different period → wrong-side bet at high martingale). */
      for (let r = 1; r <= 6 && result.code === 13; r++) {
        const piNow = periodInfo(this.acct.gameMode);
        if (piNow.left < KP.modeSafetyMs(this.acct.gameMode, this.acct.level > 1)) {
          this.log(`⏳ Period ...${issueNumber.slice(-5)} never opened in time — skipping`, 'l-skip');
          this._safetySkippedIssue = issueNumber;
          this.acct.lastPredIssue = null;
          return;
        }

        this.log(`⏳ Betting window not open yet — retry ${r}/6 on ...${issueNumber.slice(-5)}`, 'l-skip');
        await sleep(700);
        result = await api.placeBet(this.acct, issueNumber, stake, betContent);
        if (result.code !== 13) break;

        /* Every 3rd miss: confirm (lightweight) we haven't fallen a full period behind. */
        if (r % 3 === 0) {
          await this.fetchDrawHistory(true);
          const freshIssue = predict.currentIssueNumber(this.acct.histBuf);
          if (freshIssue && freshIssue !== issueNumber) {
            this.log(`⚠️ Period ...${issueNumber.slice(-5)} advanced → ...${freshIssue.slice(-5)} — skipping (no stale bet)`, 'l-skip');
            this._failedIssues.add(issueNumber);
            this._safetySkippedIssue = issueNumber;
            this.acct.lastPredIssue = null;
            return;
          }
        }
      }
    }

    /* Retry: code:7 (token issue) */
    for (let r = 0; r < 3 && result.code === 7; r++) {
      this.log(`⚠️ code:7 — retry ${r + 1}/3`, 'l-skip');
      await this.fetchBalance();
      await sleep(300 + r * 200);
      result = await api.placeBet(this.acct, pred.forIssue, stake, betContent);
    }

    /* Retry: network error — fast retries, escalating at high levels.
       With 8 s request timeout in proxy, worst case per attempt ≈ 8 s.
       Keep total retry window ≤ 15 s so we stay within the 30 s period. */
    const netMaxRetries = level >= 5 ? 6 : 3;
    for (let r = 0; r < netMaxRetries && result.code === -1; r++) {
      const errCode = result._netError || result.msg || '?';
      const delay = level >= 5 ? 300 * (r + 1) : 500 * (r + 1);     // faster at high levels
      this.log(`🌐 Network error [${errCode}] — retry ${r + 1}/${netMaxRetries} in ${delay}ms (LV${level}, ₹${stake})`, 'l-err');
      await sleep(delay);
      result = await api.placeBet(this.acct, pred.forIssue, stake, betContent);
    }

    /* BET SUCCESS */
    if (result.code === 0) {
      this._consecutiveFailures = 0;
      this._failedIssues.clear();
      const preBal = await this.fetchBalance();
      this.acct.preBetBal = preBal;

      const nowTs = proxy.syncedNow();
      const adj = nowTs - KP.modeOffset(this.acct.gameMode);
      const periodEnd = (Math.ceil(adj / KP.modeCycleMs(this.acct.gameMode)) * KP.modeCycleMs(this.acct.gameMode)) + KP.modeOffset(this.acct.gameMode);

      this.acct.pendingBet = {
        issue: pred.forIssue,
        pred: pred.pred,
        level: level,
        amount: stake,
        betTime: Date.now(),
        periodEnd: periodEnd,
        checkAfter: periodEnd,
        pollStart: 0,
      };

      const waitSec = Math.ceil((periodEnd - nowTs) / 1000);
      this.toast('Bet Placed!', `${pred.pred} ₹${stake} LV${level}`, 'info');
      this.log(`✅ Bet placed! ${pred.pred} ₹${stake} on ...${pred.forIssue.slice(-5)}`, 'l-bet');

      this.acct.engine = E.CHECKING;
      this.broadcast('betStatus', { icon: '📊', label: 'BET ACTIVE', detail: `${pred.pred} ₹${stake} on ...${pred.forIssue.slice(-5)}`, cls: 'placed', timer: `Draw in ${waitSec}s`, bar: '0' });
      this.broadcast();
      this._trace(`attemptBet() SUCCESS — bet is LIVE, pendingBet set, engine=CHECKING, waiting ${waitSec}s for draw to resolve`);
      return;
    }

    /* BET FAILED */
    this.toast('Bet Failed', result.msg || 'Unknown error', 'error');
    this.log(`❌ Bet FAILED: ${result.msg || JSON.stringify(result)}`, 'l-err');
    this._trace(`attemptBet() FAILED after all retries — final result: code=${result.code} msg=${JSON.stringify(result.msg)} — falling into the code:4/401 relogin branch or just returning as a skip`);
    this._failedIssues.add(pred.forIssue);
    this._consecutiveFailures++;

    /* Auth failure → try re-login, then retry bet */
    if (result.code === 4 || result.code === 401) {
      const relogged = await this.tryRelogin();
      if (relogged) {
        this.log('🔄 Retrying bet after re-login...', 'l-info');
        this._failedIssues.delete(pred.forIssue);
        this._consecutiveFailures = 0;
        /* Check if still in time */
        const piRetry = periodInfo(this.acct.gameMode);
        if (piRetry.left > KP.modeSafetyMs(this.acct.gameMode, this.acct.level > 1)) {
          const retryResult = await api.placeBet(this.acct, pred.forIssue, stake, betContent);
          if (retryResult.code === 0) {
            this.log(`✅ Bet placed after re-login! ${pred.pred} ₹${stake}`, 'l-bet');
            this._consecutiveFailures = 0;
            this._failedIssues.clear();
            const preBal = await this.fetchBalance();
            this.acct.preBetBal = preBal;
            const nowTs = proxy.syncedNow();
            const adj = nowTs - KP.modeOffset(this.acct.gameMode);
            const periodEnd = (Math.ceil(adj / KP.modeCycleMs(this.acct.gameMode)) * KP.modeCycleMs(this.acct.gameMode)) + KP.modeOffset(this.acct.gameMode);
            this.acct.pendingBet = {
              issue: pred.forIssue, pred: pred.pred, level: level, amount: stake,
              betTime: Date.now(), periodEnd, checkAfter: periodEnd, pollStart: 0,
            };
            this.acct.engine = E.CHECKING;
            this.broadcast();
            return;
          }
        }
        /* Re-login OK but bet still failed or out of time — continue to next period */
        this.acct.engine = E.WAITING;
        this.acct.lastPredIssue = null;
        this.broadcast();
        return;
      }
      this.log('🔐 Token expired — stopping', 'l-err');
      this.stop();
      return;
    }

    /* Persistent code:13 → validate token via balance check */
    if (result.code === 13 && this._consecutiveFailures >= 2) {
      this.log('🔐 Persistent code:13 — validating token...', 'l-info');
      try {
        const balRes = await api.getBalance(this.acct);
        if (balRes && (balRes.code === 4 || balRes.code === 401 || balRes.code === 403)) {
          /* Try re-login before giving up */
          const relogged = await this.tryRelogin();
          if (!relogged) {
            this.log('🔐 Token expired (confirmed via balance) — stopping', 'l-err');
            this.toast('Session Expired', 'Please log in again', 'error');
            this.stop();
            return;
          }
          /* Re-login succeeded — reset failures and continue */
          this._consecutiveFailures = 0;
          this.acct.engine = E.WAITING;
          this.acct.lastPredIssue = null;
          this.broadcast();
          return;
        }
      } catch (e) { /* silent */ }
    }

    /* Circuit breaker: 3+ consecutive failures → stop engine */
    if (this._consecutiveFailures >= 3) {
      this.log(`🛑 ${this._consecutiveFailures} consecutive bet failures — auto-stopping engine`, 'l-err');
      this.toast('Engine Stopped', `${this._consecutiveFailures} consecutive failures. Check your session or try again.`, 'error');
      this.stop();
      return;
    }

    this.acct.engine = E.WAITING;
    this.acct.lastPredIssue = null;
    this.broadcast();
  }

  /* ═══ RESOLVE RESULT (instant — from draw buffer) ═══ */
  async resolveResult(pend, resolved) {
    try {
      await this.fetchBalance();
      const drawnNumber = parseInt(resolved.number);
      const drawnBS = drawnNumber >= 5 ? 'Big' : 'Small';
      const won = (pend.pred === drawnBS);
      const winAmount = won ? Math.round(pend.amount * KP.WIN_MULTIPLIER * 100) / 100 : 0;
      const pnl = won ? (winAmount - pend.amount) : -pend.amount;

      this.log(`📊 Draw ...${pend.issue.slice(-5)}: number=${drawnNumber} (${drawnBS}) → ${won ? 'WIN' : 'LOSS'}`, 'l-info');
      await this.processResult({ won, drawnNumber, winAmount, pnl, method: 'draw-api' });
    } catch (err) {
      this.log(`⚠️ Error resolving result: ${err.message}`, 'l-err');
    }
  }

  /* ═══ PROCESS RESULT ═══ */
  async processResult(drawResult) {
    const pending = this.acct.pendingBet;
    if (!pending) return;
    this._trace(`processResult() entry — issue=${pending.issue} via ${drawResult ? 'draw-api' : 'balance-fallback'}`);

    const issue = pending.issue;
    const betCost = pending.amount;
    const level = pending.level;
    let won = false;
    let pnlDelta = 0;
    let drawnNumber = null;
    let winAmount = 0;

    if (drawResult) {
      won = drawResult.won;
      drawnNumber = drawResult.drawnNumber;
      winAmount = drawResult.winAmount || 0;
      pnlDelta = drawResult.pnl;
    } else {
      /* Balance fallback */
      const curBal = this.acct.balance;
      const preBal = this.acct.preBetBal;
      if (preBal > 0 && curBal > 0) {
        const delta = curBal - preBal;
        won = delta > 0.5;
        pnlDelta = won ? delta : -betCost;
        winAmount = won ? (betCost + delta) : 0;
      } else {
        won = false;
        pnlDelta = -betCost;
      }
      this.log(`⚠️ Using balance fallback for ...${issue.slice(-5)}`, 'l-skip');
    }

    /* Record */
    const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    this.acct.addBetHistory({ issue, pred: pending.pred, level, amount: betCost, won, pnl: pnlDelta, winAmount, time });

    /* Immediately resolve the matching predHistory entry so the
       broadcast below includes the resolved result (don't wait
       for the next-cycle resolution loop in handleNewPeriod). */
    const actualBS = drawnNumber != null ? (drawnNumber >= 5 ? 'BIG' : 'SMALL') : null;
    if (actualBS) {
      const ph = this.acct.predHistory.find(p => String(p.forIssue) === String(issue));
      if (ph && ph.correct === undefined) {
        this.acct.resolvePredHistory(issue, actualBS, ph.pred.toUpperCase() === actualBS);
      }
    }

    if (won) {
      this.acct.recordWin(pnlDelta);
      /* Reset TITAN loss streak on win */
      if (this.acct.formula === 'titan_v3') this.acct.predState.titanLossStreak = 0;
      this.acct.setLevel(1);
      this.broadcast('betStatus', { icon: '🏆', label: 'WIN', detail: `+₹${winAmount.toFixed(2)} (profit ₹${pnlDelta.toFixed(2)}) on ...${issue.slice(-5)} → LV1`, cls: 'win', timer: '', bar: '100' });
      this.toast('WIN! 🎉', `+₹${winAmount.toFixed(2)} profit ₹${pnlDelta.toFixed(2)} · Reset to LV1`, 'win');
      this.log(`🏆 WIN! +₹${winAmount.toFixed(2)} (profit: ₹${pnlDelta.toFixed(2)}) on ...${issue.slice(-5)} → LV1`, 'l-win');
      this._trace(`processResult() WIN — level reset to LV1, autobet continues running, movie ends here`);
      this._manualBetTrace = false;
    } else {
      this.acct.recordLoss(betCost);
      /* Increment TITAN loss streak on loss */
      if (this.acct.formula === 'titan_v3') this.acct.predState.titanLossStreak = (this.acct.predState.titanLossStreak || 0) + 1;
      const nextLv = this.acct.level + 1;

      /* Circuit breaker: max level */
      if (nextLv > this.acct.getMaxLevel()) {
        this.acct.pendingBet = null;
        /* Stays stopped, but flagged for the manual-bet recovery panel
           (DEFAULT_KEY only — see manualBet() and index.js) instead of a
           dead end. acct.level is deliberately left at getMaxLevel() here
           (never incremented past it) so a recovery attempt fires at the
           stake that actually lost, not back at LV1. */
        this.acct.maxLossActive = true;
        console.log(`[MAXLOSS-DEBUG] circuit breaker tripped for ${this.acct.id} — maxLossActive set to ${this.acct.maxLossActive}, level pinned at ${this.acct.level}/${this.acct.getMaxLevel()}`);
        this.log(`🚨 ALL LEVELS EXHAUSTED at LV${this.acct.getMaxLevel()} — ENGINE STOPPED`, 'l-err');
        this.toast('Max Level!', `All ${this.acct.getMaxLevel()} levels used · Engine stopped`, 'error');
        this.broadcast('maxLevel', { msg: `Lost ₹${betCost} at LV${this.acct.getMaxLevel()} on ...${issue.slice(-5)}` });
        this.broadcast();
        this._trace(`processResult() LOSS — circuit breaker RE-TRIPPED, maxLossActive=true again, popup should reopen. movie ends here`);
        this._manualBetTrace = false;
        this.stop();
        return;
      }

      this.acct.setLevel(nextLv);
      const nextStake = this.acct.getStake();
      this.broadcast('betStatus', { icon: '💀', label: 'LOSS', detail: `-₹${betCost} → LV${nextLv} (₹${nextStake})`, cls: 'loss', timer: '', bar: '0' });
      this.toast('LOSS', `-₹${betCost} → LV${nextLv} (₹${nextStake})`, 'loss');
      this.log(`💀 LOSS ₹${betCost} on ...${issue.slice(-5)} → LV${nextLv} (₹${nextStake})`, 'l-loss');
      this._trace(`processResult() LOSS but under max level — advanced to LV${nextLv}, autobet continues, movie ends here`);
      this._manualBetTrace = false;
    }

    this.acct.pendingBet = null;
    this._safetySkippedIssue = null;
    this._lastResolvedIssue = issue;
    this.acct.lastPredIssue = issue;
    this.broadcast();

    /* Refresh GOA bet record and push to client */
    this.refreshBetRecord();

    /* Post-result */
    if (!this.acct.isRunning()) return;

    if (won && this.acct.watchEnabled) {
      this.acct.engine = E.WATCHING;
      this.acct.watchPred = null;
      this.acct.watchIssue = null;
      this.acct.watchLossCount = 0;
      this.log(`👁️ WIN → Back to Watch Mode`, 'l-info');
      this.broadcast('betStatus', { icon: '👁️', label: 'WATCHING', detail: 'Observing next prediction...', cls: 'watching', timer: '', bar: '0' });
      this.broadcast();
      return;
    }

    const postDelay = won
      ? randomDelay(KP.DELAY_WIN)
      : (this.acct.level > 1 ? randomDelay(KP.DELAY_LOSS_REC) : randomDelay(KP.DELAY_LOSS_LV1));

    this._showResultUntil = Date.now() + postDelay + 500;
    await sleep(postDelay);
    this._showResultUntil = 0;

    /* Immediate re-bet */
    if (!this.acct.isRunning() || this.acct.pendingBet) return;
    await this.tryImmediateBet(won);
  }

  /* ═══ IMMEDIATE RE-BET ═══ */
  async tryImmediateBet(prevWon) {
    if (!this.acct.isRunning() || this.acct.pendingBet || this._busy) return;

    this._busy = true;
    try {
      await this.fetchDrawHistory(true);
      const histBuf = this.acct.histBuf;
      if (!histBuf || histBuf.length < 1) return;

      /* Same pre-guard as engineStep: compute issue before calling predict.run() */
      const nextIssueImm = predict.currentIssueNumber(histBuf);
      if (nextIssueImm && nextIssueImm === this.acct.lastPredIssue) return;

      const pred = predict.runShared(histBuf, this.acct.formula, this.acct.gameMode);
      this.acct.prediction = pred;

      /* Record prediction in history */
      if (pred && pred.pred !== 'WAIT' && pred.forIssue) {
        this.acct.addPredHistory({
          forIssue: pred.forIssue,
          pred: pred.pred.toUpperCase(),
          formula: pred.formula || this.acct.formula,
          time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
        });
      }

      if (!pred.forIssue || pred.pred === 'WAIT') {
        if (!pred.noRecovery && predict.sharedStreak(this.acct.gameMode, this.acct.formula) > 1) {
          const fb = predict.recoveryFallback(histBuf);
          if (fb) {
            this.log(`🔥 Recovery LV${this.acct.level}: WAIT → ${fb.pred}`, 'l-bet');
            this.acct.prediction = fb;
            this.acct.lastPredIssue = fb.forIssue;
            this._safetySkippedIssue = null;
            this.acct.addPredHistory({
              forIssue: fb.forIssue,
              pred: fb.pred.toUpperCase(),
              formula: fb.formula || this.acct.formula,
              time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
            });
            this.broadcast();
            await this.attemptBet(fb);
            return;
          }
        }
        return;
      }

      if (pred.forIssue === this.acct.lastPredIssue) return;

      this.acct.lastPredIssue = pred.forIssue;
      this._safetySkippedIssue = null;
      this.acct.engine = E.WAITING;
      this.broadcast();
      await this.attemptBet(pred);
    } catch (err) {
      this.log(`⚠️ Re-bet error: ${err.message}`, 'l-err');

      /* Critical retry: if we're at a high martingale level, a single
         network failure means losing the entire chain. Retry aggressively. */
      const lv = this.acct.level || 1;
      if (lv > 1 && this.acct.isRunning() && !this.acct.pendingBet) {
        const maxRetry = Math.min(lv, 5);
        for (let r = 1; r <= maxRetry; r++) {
          this.log(`🔄 Re-bet recovery ${r}/${maxRetry} (LV${lv})...`, 'l-err');
          await sleep(800 * r);
          try {
            await this.fetchDrawHistory(true);
            const histBuf = this.acct.histBuf;
            if (!histBuf || histBuf.length < 1) break;

            const retryPred = predict.runShared(histBuf, this.acct.formula, this.acct.gameMode);
            if (!retryPred || !retryPred.forIssue || retryPred.pred === 'WAIT') {
              const fb = predict.recoveryFallback(histBuf);
              if (!fb) continue;
              retryPred.forIssue = fb.forIssue;
              retryPred.pred = fb.pred;
            }

            this.acct.prediction = retryPred;
            this.acct.lastPredIssue = retryPred.forIssue;
            this.acct.engine = E.WAITING;
            this.broadcast();
            await this.attemptBet(retryPred);
            this.log(`✅ Re-bet recovery succeeded on retry ${r}`, 'l-bet');
            return; /* success — exit retry loop */
          } catch (retryErr) {
            this.log(`⚠️ Re-bet recovery ${r}/${maxRetry} failed: ${retryErr.message}`, 'l-err');
          }
        }
        this.log(`💀 All ${maxRetry} re-bet recovery attempts failed at LV${lv}`, 'l-err');
        this.toast('CRITICAL', `Re-bet failed ${maxRetry}x at LV${lv}!`, 'error');
      }
    } finally {
      this._busy = false;
    }
  }

  /* ═══ PASSIVE PREDICTION LOOP ═══ */
  async passiveStep() {
    if (this.acct.isRunning()) return;

    const pi = periodInfo(this.acct.gameMode);
    this.broadcast('countdown', { secs: pi.secs, total: KP.modeCycleMs(this.acct.gameMode) / 1000 });

    const now = Date.now();
    if (now - this._passiveFetchTime >= PASSIVE_FETCH_CD) {
      this._passiveFetchTime = now;
      try {
        await this.fetchDrawHistory(true);
        const histBuf = this.acct.histBuf;
        if (histBuf && histBuf.length > 0) {
          /* Resolve previous predictions against actual results */
          for (let i = 0; i < Math.min(this.acct.predHistory.length, 10); i++) {
            const ph = this.acct.predHistory[i];
            if (ph.correct !== undefined) continue;
            const match = histBuf.find(r => String(r.issueNumber) === String(ph.forIssue));
            if (match) {
              const actualBS = match.number >= 5 ? 'BIG' : 'SMALL';
              this.acct.resolvePredHistory(ph.forIssue, actualBS, ph.pred.toUpperCase() === actualBS);
            }
          }

          /* Pre-guard: don't re-run stateful engines for same period */
          const nextIssuePass = predict.currentIssueNumber(histBuf);
          if (nextIssuePass && nextIssuePass === this.acct.lastPredIssue) {
            this.broadcast();
            return;
          }

          const pred = predict.runShared(histBuf, this.acct.formula, this.acct.gameMode);
          this.acct.prediction = pred;
          if (pred.forIssue) this.acct.lastPredIssue = pred.forIssue;

          /* Record this prediction in history */
          if (pred && pred.pred !== 'WAIT' && pred.forIssue) {
            const existing = this.acct.predHistory.find(p => p.forIssue === pred.forIssue);
            if (!existing) {
              this.log(`🔮 ${pred.pred} for ...${pred.forIssue.slice(-5)} [${this.acct.formula}]`, 'l-info');
            }
            this.acct.addPredHistory({
              forIssue: pred.forIssue,
              pred: pred.pred.toUpperCase(),
              formula: pred.formula || this.acct.formula,
              time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
            });
          }

          /* Log prediction resolutions */
          const predHist2 = this.acct.predHistory;
          for (let j = 0; j < Math.min(predHist2.length, 5); j++) {
            const ph2 = predHist2[j];
            if (ph2.correct !== undefined && !ph2._logged) {
              ph2._logged = true;
              this.log(`${ph2.correct ? '✅' : '❌'} ...${ph2.forIssue.slice(-5)}: predicted ${ph2.pred}, actual ${ph2.result}`, ph2.correct ? 'l-win' : 'l-loss');
            }
          }

          this.broadcast();
        }
      } catch (e) { /* silent */ }
    }
  }

  startPassive() {
    if (this._passiveTick) return;
    this._passiveTick = setInterval(() => this.passiveStep(), PASSIVE_TICK_MS);
    this.log('👁️ Passive prediction started — watching draws', 'l-info');
    console.log(`[ENGINE:${this.acct.phone}] Passive prediction loop started`);
  }

  stopPassive() {
    if (this._passiveTick) { clearInterval(this._passiveTick); this._passiveTick = null; }
  }

  /* ═══ Full cleanup ═══ */
  destroy() {
    if (this.acct.isRunning()) {
      this.acct.engine = E.STOPPED;
    }
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._balInterval) { clearInterval(this._balInterval); this._balInterval = null; }
    if (this._passiveTick) { clearInterval(this._passiveTick); this._passiveTick = null; }
    this.acct.pendingBet = null;
    this._busy = false;
    this._polling = false;
    console.log(`[ENGINE:${this.acct.phone}] Destroyed`);
  }
}

module.exports = { AccountEngine, setIO };
