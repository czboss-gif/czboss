/* ═══════════════════════════════════════════
   KINGPIN 3.0 — Entry Point (Multi-Account)
   Express + Socket.IO + Per-Account Engines
   ═══════════════════════════════════════════ */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');

const mongoose = require('mongoose');
const KP      = require('./config');
const proxy   = require('./proxy');
const platforms = require('./platforms');
const state   = require('./state');
const { AccountEngine, setIO } = require('./engine');
const api     = require('./api');
const admin   = require('./admin');
const keys    = require('./keys');
const { NexusEngine } = require('./nexus');
const monitor = require('./monitor');
const predictorEngine = require('./predictorEngine');
const AccessKey = require('./models/AccessKey');
const DEFAULT_KEY = (process.env.DEFAULT_KEY || '').trim().toUpperCase();

// ── Global NEXUS instance (one per server, shared across all accounts) ──
const nexus = new NexusEngine();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  transports: ['websocket', 'polling'],  // prefer WebSocket, fallback to polling
  pingInterval: 10000,   // heartbeat every 10s (default 25s)
  pingTimeout: 5000,     // timeout after 5s (default 20s)
  perMessageDeflate: {   // compress WebSocket messages
    threshold: 256,      // only compress > 256 bytes
  },
  maxHttpBufferSize: 1e6,
});
const PORT   = process.env.PORT || 3000;
/* Bind host: default 0.0.0.0 (current behaviour, unchanged). Set BIND_HOST=127.0.0.1
   in .env once a reverse proxy (see deploy/nginx-kingpin.conf) fronts the app, so the
   raw socket port is no longer exposed to the internet. */
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';

// Give engine module access to io for global newDraw broadcasts
setIO(io);

/* ── Per-account engine instances, keyed by "platform:phone" ── */
const engines = new Map(); // acctId → AccountEngine

function getOrCreateEngine(platform, phone) {
  const id = state.acctId(platform, phone);
  if (engines.has(id)) return engines.get(id);
  let acct = state.getAccount(platform, phone);
  if (!acct) acct = state.createAccount(platform, phone);
  const eng = new AccountEngine(acct, io);
  engines.set(id, eng);
  return eng;
}

/* ── Socket-side access-key gate (SECURITY) ────────────────────────────────
   The key system used to be enforced only in the browser; the Socket.IO layer
   that runs the real-money engine accepted any phone+token, so anyone who could
   reach the port could `auth` + `start` with no admin key. These helpers re-check
   the AccessKey on the SERVER — on connect AND live on every bet-start — so a
   missing / disabled / phone-mismatched key can neither connect nor place bets,
   and deleting a key revokes it immediately. The default super-user key still
   works for any phone (isDefault).
   A key binds to (phone, platform) together — see AccessKey.js — so this also
   rejects a key being replayed against the wrong platform. */
async function gateCheck(key, phone, platform) {
  key      = (key   || '').trim().toUpperCase();
  phone    = (phone || '').trim();
  platform = platforms.resolve(platform);
  if (!key)   return { ok: false, msg: 'Access key required' };
  if (!phone) return { ok: false, msg: 'Phone required' };
  try {
    const rec = await AccessKey.findOne({ key });
    if (!rec)         return { ok: false, msg: 'Invalid access key' };
    if (!rec.enabled) return { ok: false, msg: 'Access key disabled' };
    if (!rec.isDefault && rec.boundPhone) {
      const a = rec.boundPhone.replace(/[^0-9]/g, '');
      const b = phone.replace(/[^0-9]/g, '');
      if (a !== b) return { ok: false, msg: 'Key registered to a different number' };
      if (rec.boundPlatform && rec.boundPlatform !== platform) {
        return { ok: false, msg: `Key registered to ${platforms.get(rec.boundPlatform).name}` };
      }
    }
    return { ok: true, isDefault: rec.isDefault };
  } catch (e) {
    console.error('[GATE] check error:', e.message);
    return { ok: false, msg: 'Auth check failed' };
  }
}

/* Sync presence check for control events — set only after a successful auth gate. */
function authed(socket) { return !!(socket.data && socket.data.authKey); }

/** Accepts a composite id, or (platform, phone). */
function destroyEngine(platform, phone) {
  const id = phone === undefined ? platform : state.acctId(platform, phone);
  const eng = engines.get(id);
  if (eng) {
    eng.destroy();
    engines.delete(id);
  }
  state.removeAccount(id);
}

// ── Body parsing ──
app.use(express.json());

// ── GOA API Proxy routes (still needed for browser login flow) ──
proxy.mount(app);

// ── Admin routes (separate admin panel + root gate validation) ──
admin.mount(app);

// ── Key-based access routes (replaces AB passwords system) ──
keys.mount(app, admin.requireAdmin, (platform, phone) => {
  /* Key disabled/deleted → stop the bound account's engine immediately. */
  if (!phone) return;
  const pid = platforms.resolve(platform);
  const id  = state.acctId(pid, phone);
  let eng = engines.get(id);
  if (!eng) {
    /* Fall back to a digit-only match on the same platform — covers a
       phone stored with different formatting (spaces, +91, etc). */
    const digits = String(phone).replace(/[^0-9]/g, '');
    for (const [eid, e] of engines) {
      const [ePid, ePhone] = eid.split(':');
      if (ePid === pid && String(ePhone).replace(/[^0-9]/g, '') === digits) { eng = e; break; }
    }
  }
  if (eng) { eng.stop(); console.log(`[GATE] Engine stopped — key revoked for ${id}`); }
  io.to(id).emit('authError', { phone, platform: pid, msg: 'Access key revoked' });
  io.emit('accountList', state.listAccounts());
});

// ── Static files ──
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── EIP Monitor (Regular + Pro traders, live stats via Socket.IO) ──
monitor.mount(app, io);

// ── Predictor accuracy tester (always-on, independent of any browser tab) ──
predictorEngine.mount(app, io);

// ── Nexus warmup endpoint: GET /api/nexus-warmup?phone=PHONE&platform=goa&records=500 ──
app.get('/api/nexus-warmup', async (req, res) => {
  const phone = req.query.phone;
  const platform = platforms.resolve(req.query.platform);
  const totalRecords = Math.min(parseInt(req.query.records) || 500, 1000);
  if (!phone) return res.json({ ok: false, msg: 'phone required', list: [] });
  const acct = state.getAccount(platform, phone);
  if (!acct) return res.json({ ok: false, msg: `account ${platform}:${phone} not found — open browser and log in first`, list: [] });
  if (!acct.lotteryToken) return res.json({ ok: false, msg: 'no token — account not logged in', list: [] });

  const PER_PAGE = 100;
  const maxPages = Math.ceil(totalRecords / PER_PAGE);
  const allRecords = [];
  const gameCode = acct.gameMode || KP.GAME_MODE || 'WinGo_30S';
  console.log(`[nexus-warmup] phone=${phone} want=${totalRecords} maxPages=${maxPages} token=${acct.lotteryToken.slice(0,16)}…`);

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    let r = null;
    // Retry up to 3 times with token refresh
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const signedParams = proxy.signLottery({ gameCode, pageNo, pageSize: PER_PAGE });
        const qs = new URLSearchParams(signedParams).toString();
        const url = `${proxy.GOA_API}/api/Lottery/GetHistoryIssuePage?${qs}`;
        r = await proxy.httpGet(url, {
          ...platforms.headers(acct.platform),
          'Authorization': `Bearer ${acct.lotteryToken}`,
        });
        if (r._respAuth) {
          const rotated = proxy.extractBearer(r._respAuth);
          if (rotated) { acct.lotteryToken = rotated; console.log(`[nexus-warmup] token rotated`); }
          delete r._respAuth;
        }
        const list = r?.data?.list || [];
        console.log(`[nexus-warmup] page ${pageNo}/${maxPages} attempt=${attempt} code=${r.code} got=${list.length} total=${allRecords.length + list.length}`);
        if (r.code === 0) break;  // success
        // code=7 or other error — try relogin
        if (attempt < 3) {
          console.log(`[nexus-warmup] code=${r.code} (${r.msg}) — attempting relogin…`);
          /* Was passing the account object where (platform, phone, pwd) is
             expected, so this path never actually re-logged in. */
          const reloginRes = await proxy.relogin(acct.platform, acct.phone, acct.pwd);
          if (reloginRes.ok && reloginRes.lotteryToken) {
            acct.lotteryToken = reloginRes.lotteryToken;
            console.log(`[nexus-warmup] relogin OK, new token=${acct.lotteryToken.slice(0,16)}…`);
          } else {
            console.log(`[nexus-warmup] relogin failed: ${reloginRes.msg}`);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (e) {
        console.error(`[nexus-warmup] page ${pageNo} attempt=${attempt} error:`, e.message);
        if (attempt === 3) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (!r || r.code !== 0) { console.log(`[nexus-warmup] page ${pageNo} gave up. stopping.`); break; }
    const list = r?.data?.list || [];
    if (!list.length) { console.log(`[nexus-warmup] empty page — done`); break; }
    allRecords.push(...list);
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`[nexus-warmup] DONE total=${allRecords.length}`);
  const mapped = allRecords.map(x => ({
    issue:  String(x.issueNumber),
    number: parseInt(x.number),
    bs:     parseInt(x.number) >= 5 ? 'B' : 'S',
  }));
  res.json({ ok: true, list: mapped, total: mapped.length });
});

/* ═══ Socket.IO Connection Handler ═══ */
io.on('connection', (socket) => {
  console.log(`[IO] Client connected: ${socket.id}`);

  let viewingId = null; // "platform:phone" of the account this socket is currently viewing

  /* Resolve which account a handler's payload refers to: an explicit
     {platform, phone} on the message, else whatever this socket is
     currently viewing. Every handler below goes through this so the
     room name, the engines-Map key and the Mongo scope always agree. */
  function targetId(data) {
    if (data?.phone) return state.acctId(data.platform, data.phone);
    return viewingId;
  }

  /* ── Auth: browser sends tokens after login ── */
  socket.on('auth', async (data) => {
    try {
      const phone    = data.phone || '';
      const platform = platforms.resolve(data.platform);
      if (!phone) { socket.emit('error', { msg: 'No phone provided' }); return; }

      /* ── SECURITY GATE: validate the access key server-side before doing
         anything. Without this the key check was browser-only and bypassable. */
      const gate = await gateCheck(data.key, phone, platform);
      if (!gate.ok) {
        console.warn(`[GATE] auth REJECTED ${platform}:${phone} key=${(data.key||'').slice(0,5)}… — ${gate.msg}`);
        socket.emit('authError', { phone, platform, msg: gate.msg });
        return;
      }
      socket.data.authKey     = (data.key || '').trim().toUpperCase();
      socket.data.authDefault = !!gate.isDefault;

      // Create/get account + engine (createAccount loads saved config from DB)
      let acct = state.getAccount(platform, phone);
      if (!acct) acct = await state.createAccount(platform, phone);
      const id = acct.id;

      acct.lotteryToken = data.lotteryToken || '';
      acct.webapiToken  = data.webapiToken || '';

      /* Save encrypted password if provided */
      if (data.pwd) {
        acct.pwd = data.pwd;
        state.saveConfig(platform, phone).catch(() => {});
      }

      const eng = getOrCreateEngine(platform, phone);

      console.log(`[IO] Auth: ${id}, token=${data.lotteryToken ? 'yes' : 'no'}`);

      // Join this account's room for updates
      if (viewingId && viewingId !== id) socket.leave(viewingId);
      socket.join(id);
      viewingId = id;
      console.log(`[MAXLOSS-DEBUG] auth: socket=${socket.id} joined room="${id}" authDefault=${socket.data.authDefault}`);

      // Validate by fetching balance
      await eng.fetchBalance();
      console.log(`[IO] Balance for ${id}: ₹${acct.balance}`);

      // Start passive prediction
      eng.startPassive();

      // Send state + logs to this socket only
      socket.emit('state', acct.snapshot());
      socket.emit('logs', eng.getLogs());

      // Send account list to all connected clients
      io.emit('accountList', state.listAccounts());
    } catch (e) {
      console.error('[IO] Auth error:', e.message);
    }
  });

  /* ── Switch View: change which account this socket views ── */
  socket.on('switchView', (data) => {
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct) return;

    if (viewingId) socket.leave(viewingId);
    socket.join(id);
    viewingId = id;

    const eng = engines.get(id);
    socket.emit('state', acct.snapshot());
    if (eng) socket.emit('logs', eng.getLogs());
    console.log(`[IO] Switched view to ${id}`);
    console.log(`[MAXLOSS-DEBUG] switchView: socket=${socket.id} joined room="${id}" maxLossActive=${acct.maxLossActive}`);
  });

  /* ── List Accounts ── */
  socket.on('listAccounts', () => {
    socket.emit('accountList', state.listAccounts());
  });

  /* ── Engine Controls ── */
  socket.on('start', async (data) => {
    const id        = targetId(data);
    const sessionId = data?.sessionId || null;
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct) return;
    const { platform, phone } = acct;

    /* ── SECURITY GATE: this socket must have authed, and the key must STILL be
       valid right now (live re-check → deleting/disabling a key blocks betting
       immediately, and a key bound to another phone or platform can't start this one). */
    if (!authed(socket)) { socket.emit('authError', { phone, msg: 'Not authenticated' }); return; }
    const gate = await gateCheck(socket.data.authKey, phone, platform);
    if (!gate.ok) {
      console.warn(`[GATE] start REJECTED ${id} — ${gate.msg}`);
      engines.get(id)?.stop();
      socket.emit('authError', { phone, platform, msg: gate.msg });
      return;
    }

    console.log(`[IO] Start: ${id}`);
    engines.get(id)?.start();
    io.emit('accountList', state.listAccounts());

    /* Record bet start time in KeySession */
    if (sessionId) {
      const KeySession = require('./models/KeySession');
      KeySession.findOneAndUpdate({ sessionId }, { betStartTime: new Date() }).catch(() => {});
    }
  });

  /* ── Manual Recovery Bet — DEFAULT_KEY only ──
     One-shot resume after the max-level circuit breaker (acct.maxLossActive).
     Same live key/platform gate as `start`, PLUS socket.data.authDefault:
     the client hides this button for non-default sessions, but that's a UI
     nicety, not the boundary — a regular key must never be able to fire a
     max-stake bet on someone else's account by hand-crafting the event. */
  socket.on('manualBet', async (data) => {
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct) return;
    const { platform, phone } = acct;

    if (!authed(socket)) { socket.emit('authError', { phone, msg: 'Not authenticated' }); return; }
    if (!socket.data.authDefault) {
      console.warn(`[GATE] manualBet REJECTED ${id} — not a DEFAULT_KEY session`);
      socket.emit('authError', { phone, platform, msg: 'Manual bet requires the default key' });
      return;
    }
    const gate = await gateCheck(socket.data.authKey, phone, platform);
    if (!gate.ok) {
      console.warn(`[GATE] manualBet REJECTED ${id} — ${gate.msg}`);
      socket.emit('authError', { phone, platform, msg: gate.msg });
      return;
    }
    if (!acct.maxLossActive) return; // nothing to recover from — ignore stray clicks

    console.log(`[IO] Manual recovery bet: ${id} side=${data?.side}${data?.amount ? ` amount=₹${data.amount}` : ''}`);
    await engines.get(id)?.manualBet(data?.amount, data?.side);
    io.emit('accountList', state.listAccounts());
  });

  /* ── Cancel Manual Bet — DEFAULT_KEY only ──
     Dismisses the recovery popup without placing anything. Same gate as
     manualBet — it's part of the same admin-only feature, and while it's
     not itself a money-moving action, only the session that's allowed to
     start the recovery should be allowed to call it off. */
  socket.on('cancelManualBet', async (data) => {
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct) return;
    const { platform, phone } = acct;

    if (!authed(socket)) { socket.emit('authError', { phone, msg: 'Not authenticated' }); return; }
    if (!socket.data.authDefault) {
      console.warn(`[GATE] cancelManualBet REJECTED ${id} — not a DEFAULT_KEY session`);
      socket.emit('authError', { phone, platform, msg: 'Manual bet requires the default key' });
      return;
    }
    const gate = await gateCheck(socket.data.authKey, phone, platform);
    if (!gate.ok) {
      console.warn(`[GATE] cancelManualBet REJECTED ${id} — ${gate.msg}`);
      socket.emit('authError', { phone, platform, msg: gate.msg });
      return;
    }

    console.log(`[IO] Manual bet cancelled: ${id}`);
    engines.get(id)?.cancelManualBet();
    io.emit('accountList', state.listAccounts());
  });

  socket.on('stop', async (data) => {
    const id        = targetId(data);
    const sessionId = data?.sessionId || null;
    const profit    = parseFloat(data?.profit) || 0;
    if (!id) return;
    console.log(`[IO] Stop: ${id}`);
    engines.get(id)?.stop();
    io.emit('accountList', state.listAccounts());

    /* Record bet stop time and profit in KeySession */
    if (sessionId) {
      const KeySession = require('./models/KeySession');
      KeySession.findOneAndUpdate(
        { sessionId },
        { betStopTime: new Date(), profit }
      ).catch(() => {});
    }
  });

  /* ── Formula Change ── */
  socket.on('setFormula', (data) => {
    if (!authed(socket)) return;
    const id = targetId(data);
    const formula = typeof data === 'string' ? data : data?.formula;
    if (!id || !formula) return;
    const acct = state.getAccount(id);
    if (!acct || acct.isRunning()) return;
    acct.setFormula(formula);
    console.log(`[IO] Formula for ${id}: ${formula}`);
    io.to(id).emit('state', acct.snapshot());
    state.saveConfig(id);
  });

  /* ── Game Mode Change (30S ↔ 1M) — per account ── */
  socket.on('setGameMode', (data) => {
    if (!authed(socket)) return;
    const id   = targetId(data);
    const mode = typeof data === 'string' ? data : data?.gameMode;
    if (!id || !mode) return;
    const acct = state.getAccount(id);
    if (!acct) return;
    /* Can't switch mode mid-run — different period stream & timing */
    if (acct.isRunning()) {
      io.to(id).emit('toast', { title: 'Stop first', msg: 'Stop the engine before changing game mode.', type: 'warn' });
      return;
    }
    const changed = acct.setGameMode(mode);   // resets histBuf/predState + snaps formula
    if (!changed) return;
    console.log(`[IO] GameMode for ${id}: ${mode} (formula→${acct.formula})`);
    /* Re-init passive prediction loop so it fetches the new mode's history */
    const eng = engines.get(id);
    if (eng) { eng.stopPassive(); eng.startPassive(); }
    io.to(id).emit('state', acct.snapshot());
    state.saveConfig(id);
  });

  /* ── Levels Config ── */
  socket.on('setLevels', (data) => {
    if (!authed(socket)) return;
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct || acct.isRunning()) return;
    try {
      if (Array.isArray(data.custom) && data.custom.length > 0) {
        const levels = data.custom.map(v => Math.max(1, parseInt(v) || 1));
        acct.setLevels(levels);
        console.log(`[IO] Custom levels for ${id}: [${levels.join(',')}]`);
      } else {
        const baseAmt = Math.max(1, parseInt(data.baseAmt) || 2);
        const maxLevel = Math.max(1, Math.min(15, parseInt(data.maxLevel) || 10));
        const levels = [];
        for (let i = 0; i < maxLevel; i++) {
          if (i === 0) levels.push(baseAmt);
          else levels.push(Math.ceil(levels[i - 1] * 2.15));
        }
        acct.setLevels(levels);
        console.log(`[IO] Levels for ${id}: base=₹${baseAmt} max=${maxLevel}`);
      }
      io.to(id).emit('state', acct.snapshot());
      state.saveConfig(id);
    } catch (e) {
      console.error('[IO] setLevels error:', e.message);
    }
  });

  /* ── Watch Mode ── */
  socket.on('setWatch', (data) => {
    if (!authed(socket)) return;
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct || acct.isRunning()) return;
    acct.watchEnabled = !!data.enabled;
    if (data.count !== undefined) acct.setWatchLossTarget(data.count);
    console.log(`[IO] Watch for ${id}: ${data.enabled ? 'ON' : 'OFF'} target=${acct.watchLossTarget}`);
    io.to(id).emit('state', acct.snapshot());
    state.saveConfig(id);
  });

  /* ── Refresh Balance ── */
  socket.on('refreshBalance', async (data) => {
    const id = targetId(data);
    if (!id) return;
    const eng = engines.get(id);
    if (eng) {
      await eng.fetchBalance();
      const acct = state.getAccount(id);
      if (acct) io.to(id).emit('state', acct.snapshot());
    }
  });

  /* ── Get Bet Record ── */
  socket.on('getBetRecord', async (data) => {
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct) return;
    try {
      const page = data?.page || 1;
      console.log(`[IO] getBetRecord: ${id} page=${page}`);
      const result = await api.getBetRecord(acct, page, 10);
      socket.emit('betRecord', { page, result });
    } catch (e) {
      console.error(`[IO] getBetRecord error:`, e.message);
      socket.emit('betRecord', { page: 1, result: { code: -1, msg: e.message } });
    }
  });

  /* ── Export Game History ── */
  socket.on('exportHistory', async (data) => {
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct) return;

    const totalRecords = Math.min(parseInt(data?.totalRecords) || 500, 500);
    const PER_PAGE = 10;
    const maxPages = Math.ceil(totalRecords / PER_PAGE);
    console.log(`[IO] exportHistory: ${id} want=${totalRecords} pages=${maxPages} token=${acct.lotteryToken ? acct.lotteryToken.slice(0,20)+'…' : 'NONE'}`);

    if (!acct.lotteryToken) {
      return socket.emit('exportHistoryResult', { ok: false, msg: 'No token — account not logged in', list: [] });
    }

    const allRecords = [];

    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [800, 2000, 4000]; // ms before each retry attempt

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const gameCode = acct.gameMode || KP.GAME_MODE || 'WinGo_30S';
      let res = null;
      let lastErr = null;
      let success = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 1) {
            const delay = RETRY_DELAYS[attempt - 2] || 4000;
            console.log(`[IO] exportHistory page ${pageNo} retry ${attempt}/${MAX_RETRIES} — waiting ${delay}ms`);
            socket.emit('exportHistoryProgress', { page: pageNo, maxPages, total: allRecords.length, retrying: attempt });
            await new Promise(r => setTimeout(r, delay));
          }

          const signedParams = proxy.signLottery({ gameCode, pageNo, pageSize: PER_PAGE });
          const qs = new URLSearchParams(signedParams).toString();
          const url = `${proxy.GOA_API}/api/Lottery/GetHistoryIssuePage?${qs}`;

          console.log(`[IO] exportHistory page ${pageNo}/${maxPages} attempt=${attempt} signedParams=${JSON.stringify(signedParams)}`);

          res = await proxy.httpGet(url, {
            ...platforms.headers(acct.platform),
            'Authorization': `Bearer ${acct.lotteryToken}`,
          });

          // capture token rotation — strip 'Bearer ' prefix before storing
          if (res._respAuth) {
            const rotated = proxy.extractBearer(res._respAuth);
            if (rotated) {
              console.log(`[IO] exportHistory page ${pageNo}: token rotated`);
              acct.lotteryToken = rotated;
            }
            delete res._respAuth;
          }

          console.log(`[IO] exportHistory page ${pageNo} attempt=${attempt} → code=${res?.code} msg=${res?.msg} listLen=${res?.data?.list?.length} httpStatus=${res?._httpStatus}`);

          if (res.code === 0) { success = true; break; }

          lastErr = `code=${res.code} ${res.msg || ''}`;
          console.warn(`[IO] exportHistory page ${pageNo} attempt=${attempt} FAILED ${lastErr}`);

        } catch (e) {
          lastErr = e.message;
          console.error(`[IO] exportHistory page ${pageNo} attempt=${attempt} exception:`, e.message);
        }
      }

      if (!success) {
        console.warn(`[IO] exportHistory page ${pageNo} gave up after ${MAX_RETRIES} attempts — ${lastErr}`);
        socket.emit('exportHistoryProgress', { page: pageNo, maxPages, total: allRecords.length, error: `Page ${pageNo} failed after ${MAX_RETRIES} retries: ${lastErr}` });
        break;
      }

      const list = res?.data?.list || [];
      if (list.length === 0) {
        console.log(`[IO] exportHistory page ${pageNo} empty — done`);
        socket.emit('exportHistoryProgress', { page: pageNo, maxPages, total: allRecords.length, done: true });
        break;
      }

      allRecords.push(...list);
      socket.emit('exportHistoryProgress', { page: pageNo, maxPages, total: allRecords.length });
      console.log(`[IO] exportHistory page ${pageNo} ok +${list.length} → total ${allRecords.length}`);

      // pace requests to avoid bot detection: 200ms normal, 1s every 10 pages
      await new Promise(r => setTimeout(r, pageNo % 10 === 0 ? 1000 : 200));
    }

    console.log(`[IO] exportHistory DONE: ${allRecords.length} records`);
    socket.emit('exportHistoryResult', { ok: allRecords.length > 0, list: allRecords, msg: allRecords.length === 0 ? 'No records fetched' : null });
  });

  /* ── NEXUS prediction requests ── */
  socket.on('nexusPredict', (data) => _handleNexusPredict(socket, data));

  /* ── NEXUS: warmup engine using account token (same as exportHistory) ── */
  socket.on('nexusWarmup', async (data) => {
    const id = targetId(data);
    if (!id) return socket.emit('nexusWarmupDone', { ok: false, msg: 'No account selected' });
    const acct = state.getAccount(id);
    if (!acct?.lotteryToken) return socket.emit('nexusWarmupDone', { ok: false, msg: 'Account not logged in' });

    const totalRecords = 500;
    const PER_PAGE = 10;
    const maxPages = Math.ceil(totalRecords / PER_PAGE);
    const allRecords = [];
    const gameCode = acct.gameMode || KP.GAME_MODE || 'WinGo_30S';
    console.log(`[NEXUS] nexusWarmup for ${id}: fetching up to ${totalRecords} records (${maxPages} pages)…`);
    socket.emit('nexusWarmupProgress', { page: 0, maxPages, total: 0, status: 'Starting…' });

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      let success = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const sp = proxy.signLottery({ gameCode, pageNo, pageSize: PER_PAGE });
          const qs = new URLSearchParams(sp).toString();
          const r = await proxy.httpGet(`${proxy.GOA_API}/api/Lottery/GetHistoryIssuePage?${qs}`, {
            ...platforms.headers(acct.platform),
            'Authorization': `Bearer ${acct.lotteryToken}`,
          });
          if (r._respAuth) { const t = proxy.extractBearer(r._respAuth); if (t) acct.lotteryToken = t; delete r._respAuth; }
          const list = r?.data?.list || [];
          if (r.code === 0 && list.length > 0) {
            allRecords.push(...list);
            socket.emit('nexusWarmupProgress', { page: pageNo, maxPages, total: allRecords.length, status: `Page ${pageNo}/${maxPages} → ${allRecords.length} records` });
            success = true; break;
          }
          if (r.code === 0 && list.length === 0) { success = true; break; } // empty = end of history
          if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt));
        } catch(e) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt));
        }
      }
      if (!success) break;
      await new Promise(r => setTimeout(r, 150));
    }

    // Warm up nexus engine
    const records = allRecords.reverse().map(x => ({
      issue: String(x.issueNumber), bs: parseInt(x.number) >= 5 ? 'B' : 'S',
    }));
    nexus.warmup(records);
    console.log(`[NEXUS] Warmed up on ${records.length} records`);
    socket.emit('nexusWarmupDone', { ok: true, total: records.length, stats: nexus._stats() });
  });

  /* ── Reset Stats ── */
  socket.on('resetStats', (data) => {
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    if (!acct || acct.isRunning()) return;
    acct.resetSession();
    io.to(id).emit('state', acct.snapshot());
    io.to(id).emit('toast', { title: 'Stats Reset', msg: 'All stats cleared', type: 'info' });
  });

  /* ── Logout (single account) ── */
  socket.on('logout', (data) => {
    const id = targetId(data);
    if (!id) return;
    const acct = state.getAccount(id);
    console.log(`[IO] Logout: ${id}`);
    destroyEngine(id);
    if (viewingId === id) {
      socket.leave(id);
      viewingId = null;
    }
    socket.emit('accountRemoved', { phone: acct?.phone, platform: acct?.platform, id });
    io.emit('accountList', state.listAccounts());
  });

  socket.on('disconnect', () => {
    console.log(`[IO] Client disconnected: ${socket.id}`);
    // Don't destroy engines — they keep running independently
  });
});

/* ── NEXUS: fetch public draw history to warm up ── */
async function _warmupNexus() {
  try {
    console.log('[NEXUS] Warming up from public draw history…');
    const gameCode = KP.GAME_MODE || 'WinGo_30S';
    // Public API returns latest 100 records in one call
    const url = `${proxy.GOA_DRAW}?gameCode=${gameCode}&pageNo=1&pageSize=100`;
    const res = await proxy.httpGet(url);
    const list = res?.data?.list || res?.list || [];
    if (list.length > 0) {
      const records = list
        .reverse()  // oldest first
        .map(r => ({
          issue: r.issueNumber || r.issue,
          bs: (parseInt(r.number,10) >= 5) ? 'B' : 'S',
        }));
      nexus.warmup(records);
      console.log(`[NEXUS] Warmed up with ${records.length} public records`);
    } else {
      console.log('[NEXUS] No public draw records returned — starting cold');
    }
  } catch(e) {
    console.error('[NEXUS] Warmup failed:', e.message);
  }
}

/* ── NEXUS Socket handlers ── */
// Called by the dashboard every round to get a prediction for the NEXT issue
// data: { nextIssue: '20260422...', lastIssue: '...', lastResult: 'B'|'S' }
function _handleNexusPredict(socket, data) {
  try {
    let fbResult = null;
    if (data.lastIssue && data.lastResult) {
      const fb = nexus.feedback(data.lastIssue, data.lastResult);
      if (fb.scored) {
        fbResult = fb;
        console.log(`[NEXUS] Feedback: issue=${data.lastIssue} actual=${data.lastResult} won=${fb.won} L${fb.level} | ${JSON.stringify(fb.stats)}`);
        // add to recent history display
        nexus.addRecentRow({
          issue:   data.lastIssue,
          number:  data.lastNumber || '?',
          bs:      data.lastResult,
          pred:    data.lastPred   || '—',
          pct:     data.lastPct    || 0,
          level:   fb.level,
          stake:   fb.stake,
          result:  fb.won ? 'WIN' : 'LOSS',
          reason:  data.lastReason || '—',
        });
      }
    }
    const decision = nexus.predict(data.nextIssue);
    console.log(`[NEXUS] predict(${data.nextIssue}) → ${decision.signal} ${decision.pred||''} ${decision.pct}% L${decision.level} | ${decision.reason}`);
    socket.emit('nexusDecision', { ...decision, recentRows: nexus.recentRows });
  } catch(e) {
    console.error('[NEXUS] predict error:', e.message);
    socket.emit('nexusDecision', { signal: 'BET', pred: 'B', confidence: 0.5, pct: 50, reason: 'Engine error: '+e.message, level:1, stake:1, stats: nexus._stats(), recentRows: nexus.recentRows });
  }
}

/* ── Periodic account list broadcast (every 10s) ── */
setInterval(() => {
  if (state.getAccountCount() > 0) {
    io.emit('accountList', state.listAccounts());
  }
}, 10000);

// ── Connect MongoDB + Start Server ──
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kingpin';

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log(`[DB] MongoDB connected: ${MONGO_URI}`);

    // Seed the default key from .env into the AccessKey collection
    await keys.seedDefaultKey();

    server.listen(PORT, BIND_HOST, () => {
      console.log(`\n⚡ KINGPIN ${KP.VERSION} (Multi-Account) listening on ${BIND_HOST}:${PORT}`);
      console.log(`  Static  : /public`);
      console.log(`  Proxy   : /api/goa/*`);
      console.log(`  Socket  : ws://localhost:${PORT}`);
      console.log(`  MongoDB : ${MONGO_URI}\n`);

      // Start time sync with GOA servers
      proxy.startTimeSync();

      // Warm up NEXUS from the public draw history (no token needed)
      _warmupNexus();
    });
  })
  .catch(err => {
    console.error(`[DB] MongoDB connection FAILED: ${err.message}`);
    console.error('[DB] Server will start WITHOUT persistence — configs will not survive restart');
    server.listen(PORT, BIND_HOST, () => {
      console.log(`\n⚡ KINGPIN ${KP.VERSION} (Multi-Account) listening on ${BIND_HOST}:${PORT} [NO DB]\n`);
      proxy.startTimeSync();
      _warmupNexus();
    });
  });

mongoose.connection.on('error', err => console.error(`[DB] MongoDB error: ${err.message}`));
mongoose.connection.on('disconnected', () => console.warn('[DB] MongoDB disconnected'));
