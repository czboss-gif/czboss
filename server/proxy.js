/* ═══════════════════════════════════════════
   KINGPIN 3.0 — GoaGames API Proxy
   Clean reverse proxy with SSRF whitelist.
   ═══════════════════════════════════════════ */

const https  = require('https');
const crypto = require('crypto');
const betLog = require('./bet-logger');

const GOA_API  = process.env.GOA_API || 'https://api.ar-lottery01.com';
const GOA_WEB  = 'https://api.goa7777.com';
const GOA_DRAW = 'https://draw.ar-lottery01.com';

/* ── Browser fingerprint for outbound requests ── */
const BROWSER_HEADERS = {
  'User-Agent':       'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Accept':           'application/json, text/plain, */*',
  'Accept-Language':  'en-US,en;q=0.9,hi;q=0.8',
  'sec-ch-ua':        '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest':   'empty',
  'sec-fetch-mode':   'cors',
  'sec-fetch-site':   'cross-site',
  'Origin':           'https://goagames.social',
  'Referer':          'https://goagames.social/',
};

/* ── SSRF Whitelists ── */
const LOTTERY_GET  = new Set(['GetBalance', 'GetBetRecordList', 'GetUserInfo', 'GetMyEmerdList', 'GetRecordPage', 'GetHistoryIssuePage']);
const LOTTERY_POST = new Set(['WinGoBet']);
const WEBAPI_POST  = new Set(['Transfer', 'GetUserInfo', 'Captcha', 'Login']);

/* ── Time Sync ── */
let timeOffsetMs = 0;
let lastSyncAt   = 0;

function syncedNow() { return Date.now() + timeOffsetMs; }

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

function randomHex() { return crypto.randomBytes(16).toString('hex'); }

function signPayload(data) {
  const skip = new Set(['signature', 'track', 'xosoBettingData']);
  const sorted = {};
  Object.keys(data).sort().forEach(k => {
    if (skip.has(k)) return;
    const v = data[k];
    if (v === null || v === undefined || v === '') return;
    sorted[k] = v;
  });
  return md5(JSON.stringify(sorted));
}

function lotteryRandom() { return Math.floor(Math.random() * 1e12); }

/** Auto-sign a webapi payload (captcha, login, transfer) */
function signWebapi(body) {
  const d = { ...body, language: 0, random: randomHex() };
  d.signature = signPayload(d);
  d.timestamp = Math.floor(Date.now() / 1000);
  return d;
}

/** Auto-sign a lottery payload (bet, balance, results) */
function signLottery(body) {
  const d = { ...body, language: 'en', random: lotteryRandom() };
  for (const k of Object.keys(d)) {
    if (typeof d[k] === 'string' && /^\d+$/.test(d[k])) {
      const n = Number(d[k]);
      if (Number.isSafeInteger(n)) d[k] = n;
    }
  }
  d.signature = signPayload(d);
  d.timestamp = Math.floor(Date.now() / 1000);
  return d;
}

function extractBearer(header) {
  if (!header) return '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

function mask(str, show = 8) {
  if (!str || str.length <= show) return str || '';
  return str.slice(0, show) + '…';
}

/* ═══════════════════════════════════════════
   HTTP Helpers — POST / GET to GoaGames
   ─────────────────────────────────────────
   • Per-host agents with maxSockets cap
     (GoaGames sends Connection:close — keepAlive MUST be off)
   • 8 s request timeout → fast-fail + retry
   • res.on('error') to catch mid-stream drops
   • Detailed error tagging for diagnostics
   ═══════════════════════════════════════════ */

const REQUEST_TIMEOUT_MS = 8000;   // hard ceiling per request
const MAX_SOCKETS        = 6;      // max concurrent conns per host

/** One agent per hostname — prevents unlimited socket fan-out */
const _agents = {};                // hostname → https.Agent
function agentFor(hostname) {
  if (!_agents[hostname]) {
    _agents[hostname] = new https.Agent({
      keepAlive:      false,       // servers send Connection:close
      maxSockets:     MAX_SOCKETS,
      maxFreeSockets: 0,
      timeout:        REQUEST_TIMEOUT_MS,
    });
    console.log(`[PROXY] Created HTTPS agent for ${hostname}  (maxSockets=${MAX_SOCKETS}, timeout=${REQUEST_TIMEOUT_MS}ms)`);
  }
  return _agents[hostname];
}

/** Tag an error with diagnostics fields */
function tagError(err, method, url, elapsedMs) {
  err._proxy = {
    method, url,
    code:    err.code    || 'UNKNOWN',
    syscall: err.syscall || '',
    errno:   err.errno   || '',
    ms:      elapsedMs,
  };
  return err;
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const u = new URL(url);
    const bodyStr = JSON.stringify(body);
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };

    const opts = {
      hostname: u.hostname, port: u.port || 443, path: u.pathname,
      method: 'POST',
      agent: agentFor(u.hostname),
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('error', err => {
        console.error(`[PROXY] POST ${u.pathname} response-stream error: ${err.code || err.message} (${Date.now() - t0}ms)`);
        settle(reject, tagError(err, 'POST', url, Date.now() - t0));
      });
      res.on('end', () => {
        if (res.statusCode === 401) return settle(resolve, { code: 401, msg: 'Upstream 401', _httpStatus: 401 });
        if (!data.trim()) return settle(resolve, { code: -2, msg: 'Empty upstream response', _httpStatus: res.statusCode });
        try {
          const parsed = JSON.parse(data);
          parsed._httpStatus = res.statusCode;
          if (res.headers['authorization']) parsed._respAuth = res.headers['authorization'];
          settle(resolve, parsed);
        } catch { settle(resolve, { code: -1, msg: 'Non-JSON upstream response', _httpStatus: res.statusCode }); }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      console.error(`[PROXY] POST ${u.pathname} TIMEOUT after ${Date.now() - t0}ms — destroying socket`);
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', err => {
      console.error(`[PROXY] POST ${u.pathname} error: ${err.code || ''} ${err.message} (${Date.now() - t0}ms)`);
      settle(reject, tagError(err, 'POST', url, Date.now() - t0));
    });
    req.write(bodyStr);
    req.end();
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const u = new URL(url);
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };

    const opts = {
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'GET',
      agent: agentFor(u.hostname),
      headers: { ...BROWSER_HEADERS, ...headers },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('error', err => {
        console.error(`[PROXY] GET ${u.pathname} response-stream error: ${err.code || err.message} (${Date.now() - t0}ms)`);
        settle(reject, tagError(err, 'GET', url, Date.now() - t0));
      });
      res.on('end', () => {
        if (res.statusCode === 401) return settle(resolve, { code: 401, msg: 'Upstream 401', _httpStatus: 401 });
        if (!data.trim()) return settle(resolve, { code: -2, msg: 'Empty upstream response', _httpStatus: res.statusCode });
        try {
          const parsed = JSON.parse(data);
          if (res.headers['authorization']) parsed._respAuth = res.headers['authorization'];
          settle(resolve, parsed);
        } catch { settle(resolve, { code: -1, msg: 'Non-JSON upstream response', _httpStatus: res.statusCode }); }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      console.error(`[PROXY] GET ${u.pathname} TIMEOUT after ${Date.now() - t0}ms — destroying socket`);
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', err => {
      console.error(`[PROXY] GET ${u.pathname} error: ${err.code || ''} ${err.message} (${Date.now() - t0}ms)`);
      settle(reject, tagError(err, 'GET', url, Date.now() - t0));
    });
    req.end();
  });
}

/* ═══════════════════════════════════════════
   Time Sync — Align with GoaGames server
   Uses HTTP Date header (no auth required).
   ═══════════════════════════════════════════ */

function syncTime() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const u = new URL(`${GOA_WEB}/api/webapi/GetNoaverpowerful`);
    const bodyStr = JSON.stringify({ language: 0 });
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST',
      agent: agentFor(u.hostname),
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, (res) => {
      res.on('data', () => {});  // drain
      res.on('end', () => {
        const rtt = Date.now() - t0;
        const dateHeader = res.headers['date'];
        if (dateHeader) {
          const serverMs = new Date(dateHeader).getTime();
          timeOffsetMs = serverMs - (t0 + Math.floor(rtt / 2));
          lastSyncAt = Date.now();
          console.log(`[PROXY] Time sync OK: offset=${timeOffsetMs > 0 ? '+' : ''}${timeOffsetMs}ms (RTT ${rtt}ms, server=${dateHeader})`);
        } else {
          console.warn('[PROXY] Time sync: no Date header in response');
        }
        resolve();
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      console.error(`[PROXY] Time sync TIMEOUT after ${Date.now() - t0}ms`);
      req.destroy();
      resolve();
    });
    req.on('error', (e) => {
      console.error(`[PROXY] Time sync failed: ${e.code || ''} ${e.message} (${Date.now() - t0}ms)`);
      resolve();
    });
    req.write(bodyStr);
    req.end();
  });
}

function startTimeSync() {
  syncTime();
  setInterval(syncTime, 5 * 60 * 1000);
}

/* ═══════════════════════════════════════════
   Auto Re-Login (server-side)
   ─────────────────────────────────────────
   1. Fetch captcha
   2. Generate synthetic slider track
   3. Call Login API
   4. Extract both tokens
   5. Activate lottery session + transfer
   ═══════════════════════════════════════════ */

/** Generate a realistic-looking slider track */
function _fakeTrack(sliderX) {
  const tracks = [];
  const steps = 15 + Math.floor(Math.random() * 10);
  for (let i = 0; i < steps; i++) {
    const x = Math.round((sliderX / steps) * (i + 1) + (Math.random() - 0.5) * 3);
    const y = Math.round(87 + (Math.random() - 0.5) * 4);
    tracks.push({ x: Math.max(0, Math.min(x, 244)), y, t: i + 1 });
  }
  return tracks;
}

/**
 * Auto re-login for a given phone + password.
 * @param {string} phone  — raw phone number (e.g. "9150306499")
 * @param {string} pwd    — plain-text password
 * @returns {{ ok:boolean, lotteryToken?:string, webapiToken?:string, msg?:string }}
 */
async function relogin(phone, pwd) {
  if (!phone || !pwd) return { ok: false, msg: 'No phone or password' };

  const cleaned = phone.replace(/[^0-9]/g, '');
  const username = cleaned.length <= 10 ? '91' + cleaned : cleaned;

  try {
    /* Step 1: Get captcha */
    const captchaPayload = signWebapi({});
    const captchaRes = await httpPost(`${GOA_WEB}/api/webapi/Captcha`, captchaPayload);
    if (!captchaRes || captchaRes.code !== 0 || !captchaRes.data) {
      return { ok: false, msg: 'Captcha fetch failed: ' + (captchaRes?.msg || 'unknown') };
    }

    const captchaId = captchaRes.data.captchaId;
    if (!captchaId) return { ok: false, msg: 'No captchaId in response' };

    /* Step 2: Generate slider track (random x between 100-180) */
    const sliderX = 100 + Math.floor(Math.random() * 80);
    const tracks = _fakeTrack(sliderX);
    const startTime = new Date(Date.now() - 2000).toISOString();
    const endTime = new Date().toISOString();

    /* Step 3: Login */
    const loginBody = {
      username,
      captchaId,
      track: {
        backgroundImageWidth: 280,
        backgroundImageHeight: 175,
        sliderImageWidth: 56,
        sliderImageHeight: 175,
        startTime,
        endTime,
        tracks,
      },
      pwd,
      phonetype: 0,
      logintype: 'mobile',
      packId: '',
      deviceId: 'kp3_relogin_' + crypto.randomBytes(4).toString('hex'),
    };

    const loginPayload = signWebapi(loginBody);
    const loginRes = await httpPost(`${GOA_WEB}/api/webapi/Login`, loginPayload);

    if (!loginRes || loginRes.code !== 0 || !loginRes.data) {
      return { ok: false, msg: 'Login failed: ' + (loginRes?.msg || 'code=' + loginRes?.code) };
    }

    const d = loginRes.data;
    const webapiToken = d.token || '';
    let lotteryToken = '';

    if (d.lotteryLoginUrl) {
      const m = d.lotteryLoginUrl.match(/Token=([^&]+)/);
      if (m) lotteryToken = decodeURIComponent(m[1]);
    }

    if (!lotteryToken && !webapiToken) {
      return { ok: false, msg: 'Login OK but no tokens returned' };
    }

    console.log(`[RELOGIN] ✅ ${phone} | webapi:${webapiToken ? mask(webapiToken) : 'none'} lottery:${lotteryToken ? mask(lotteryToken) : 'none'}`);

    /* Step 4: Activate lottery session (fire-and-forget) */
    if (d.lotteryLoginUrl) {
      httpGet(d.lotteryLoginUrl).catch(() => {});
    }

    /* Step 5: Transfer funds main → lottery wallet (fire-and-forget) */
    if (webapiToken) {
      const p = { language: 0, random: randomHex() };
      p.signature = signPayload(p);
      p.timestamp = Math.floor(Date.now() / 1000);
      httpPost(`${GOA_WEB}/api/webapi/Transfer`, p, { Authorization: `Bearer ${webapiToken}` }).catch(() => {});
    }

    return { ok: true, lotteryToken, webapiToken };
  } catch (e) {
    console.error(`[RELOGIN] ❌ ${phone} error: ${e.message}`);
    return { ok: false, msg: e.message };
  }
}

/* ═══════════════════════════════════════════
   Route Mounter
   ═══════════════════════════════════════════ */

function mount(app) {

  /* ── Captcha (public) ── */
  app.post('/api/goa/captcha', async (req, res) => {
    try {
      const payload = signWebapi(req.body || {});
      const result = await httpPost(`${GOA_WEB}/api/webapi/Captcha`, payload);
      res.json(result);
    } catch (e) {
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Login — full activation flow ── */
  app.post('/api/goa/login', async (req, res) => {
    try {
      const payload = signWebapi(req.body || {});
      const result = await httpPost(`${GOA_WEB}/api/webapi/Login`, payload);

      if (result.code === 0 && result.data) {
        const d = result.data;
        const webapiToken  = d.token || '';
        let   lotteryToken = '';

        if (d.lotteryLoginUrl) {
          const m = d.lotteryLoginUrl.match(/Token=([^&]+)/);
          if (m) lotteryToken = decodeURIComponent(m[1]);
        }

        console.log(`[PROXY] Login OK | webapi:${webapiToken ? mask(webapiToken) : 'none'} lottery:${lotteryToken ? mask(lotteryToken) : 'none'}`);

        // Activate lottery session (fire-and-forget)
        if (d.lotteryLoginUrl) {
          httpGet(d.lotteryLoginUrl).catch(() => {});
        }

        // Transfer funds main → lottery wallet (fire-and-forget)
        if (webapiToken) {
          const p = { language: 0, random: randomHex() };
          p.signature = signPayload(p);
          p.timestamp = Math.floor(Date.now() / 1000);
          httpPost(`${GOA_WEB}/api/webapi/Transfer`, p, { Authorization: `Bearer ${webapiToken}` }).catch(() => {});
        }
      }

      res.json(result);
    } catch (e) {
      console.error(`[PROXY] Login error: ${e.message}`);
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Wallet transfer ── */
  app.post('/api/goa/wallet-transfer', async (req, res) => {
    const token = extractBearer(req.headers['authorization']);
    if (!token) return res.status(401).json({ code: -1, msg: 'No token' });
    try {
      const p = { language: 0, random: randomHex() };
      p.signature = signPayload(p);
      p.timestamp = Math.floor(Date.now() / 1000);
      const result = await httpPost(`${GOA_WEB}/api/webapi/Transfer`, p, { Authorization: `Bearer ${token}` });
      res.json(result);
    } catch (e) {
      res.status(500).json({ code: -1, msg: 'Transfer error' });
    }
  });

  /* ── Webapi POST (whitelisted) ── */
  app.post('/api/goa/webapi/:ep', async (req, res) => {
    const ep = req.params.ep;
    if (!WEBAPI_POST.has(ep)) return res.status(403).json({ code: -1, msg: 'Blocked' });
    try {
      const token = extractBearer(req.headers['authorization']);
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const payload = signWebapi(req.body || {});
      const result = await httpPost(`${GOA_WEB}/api/webapi/${ep}`, payload, headers);
      res.json(result);
    } catch (e) {
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Lottery POST — Bet placement ── */
  app.post('/api/goa/lottery/:ep', async (req, res) => {
    const ep = req.params.ep;
    if (!LOTTERY_POST.has(ep)) return res.status(403).json({ code: -1, msg: 'Blocked' });

    const token = extractBearer(req.headers['authorization']);
    if (!token) return res.status(401).json({ code: 401, msg: 'No auth token' });

    if (ep === 'WinGoBet' && req.body) {
      const mult = parseInt(req.body.betMultiple);
      if (isNaN(mult) || mult < 1) {
        return res.status(400).json({ code: -1, msg: `Invalid betMultiple: ${mult}` });
      }
    }

    try {
      const payload = signLottery(req.body || {});
      const t0 = Date.now();

      if (ep === 'WinGoBet') betLog.betRequest(req.body || {}, token);

      const result = await httpPost(`${GOA_API}/api/Lottery/${ep}`, payload, {
        'Content-Type': 'application/json',
        'Origin': 'https://goagames.social',
        'Referer': 'https://goagames.social/',
        'Authorization': `Bearer ${token}`,
      });

      console.log(`[PROXY] BET ${ep} → code:${result.code} ${result.msg || ''}`);

      let hadRotation = false;
      if (result._respAuth) {
        res.set('X-Lottery-Token', result._respAuth);
        hadRotation = true;
        delete result._respAuth;
      }

      if (ep === 'WinGoBet') {
        result._hadTokenRotation = hadRotation;
        betLog.betResponse(req.body?.issueNumber, result, Date.now() - t0);
        delete result._hadTokenRotation;
      }
      res.json(result);
    } catch (e) {
      console.error(`[PROXY] BET error: ${e.message}`);
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Lottery GET — Balance, results, etc ── */
  app.get('/api/goa/lottery/:ep', async (req, res) => {
    const ep = req.params.ep;
    if (!LOTTERY_GET.has(ep)) return res.status(403).json({ code: -1, msg: 'Blocked' });

    const token = extractBearer(req.headers['authorization']);
    if (!token) return res.status(401).json({ code: 401, msg: 'No auth token' });

    res.set('Cache-Control', 'no-store');

    try {
      const signedQuery = signLottery({ ...req.query });
      const qs = new URLSearchParams(signedQuery).toString();
      const url = `${GOA_API}/api/Lottery/${ep}${qs ? '?' + qs : ''}`;
      const t0 = Date.now();

      if (ep === 'GetBalance') betLog.balanceRequest(token);

      const result = await httpGet(url, {
        'Origin': 'https://goagames.social',
        'Referer': 'https://goagames.social/',
        'Authorization': `Bearer ${token}`,
      });

      let hadRotation = false;
      if (result._respAuth) {
        res.set('X-Lottery-Token', result._respAuth);
        hadRotation = true;
        delete result._respAuth;
      }

      if (ep === 'GetBalance') {
        result._hadTokenRotation = hadRotation;
        betLog.balanceResponse(result, Date.now() - t0);
        delete result._hadTokenRotation;
      }

      if (result._httpStatus === 401) return res.status(401).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Draw history (public — no auth) ── */
  app.get('/api/goa/draw/:mode', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const pageSize = Math.min(parseInt(req.query.pageSize) || 100, 200);
      const url = `${GOA_DRAW}/WinGo/${req.params.mode}/GetHistoryIssuePage.json?pageSize=${pageSize}&t=${Date.now()}`;
      const result = await httpGet(url);
      res.json(result);
    } catch (e) {
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Time info ── */
  app.get('/api/goa/time', (_req, res) => {
    res.json({ syncedNow: syncedNow(), offsetMs: timeOffsetMs, lastSyncAt });
  });

  console.log('[PROXY] GoaGames proxy routes mounted');
}

/* ── Exports ── */
module.exports = { mount, startTimeSync, syncedNow, httpPost, httpGet, signLottery, signWebapi, signPayload, randomHex, extractBearer, relogin, GOA_API, GOA_WEB, GOA_DRAW };
