/* ═══════════════════════════════════════════
   KINGPIN 3.0 — GoaGames API Proxy
   Clean reverse proxy with SSRF whitelist.
   ═══════════════════════════════════════════ */

const https  = require('https');
const crypto = require('crypto');
const betLog = require('./bet-logger');
const platforms = require('./platforms');

/* GAME layer — shared by every platform. The draw feed carries no tenant
   parameter, so issues/results are identical for all of them. */
const GOA_API  = process.env.GOA_API || 'https://api.ar-lottery01.com';
const GOA_DRAW = 'https://draw.ar-lottery01.com';
/* HOUSE layer — per-platform; see platforms.js. GOA_WEB is kept as an
   alias for the GOA host so existing callers keep working. */
const GOA_WEB  = platforms.get('goa').webHost;

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

/* ── SSRF Whitelists (game layer — shared by all platforms).
   The house-layer whitelist is per-platform: see platforms.js webapiPost. ── */
const LOTTERY_GET  = new Set(['GetBalance', 'GetBetRecordList', 'GetUserInfo', 'GetMyEmerdList', 'GetRecordPage', 'GetHistoryIssuePage']);
const LOTTERY_POST = new Set(['WinGoBet']);

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

/* Uniform over [0, 1e12) puts ~10% of outputs below 1e11 — i.e. fewer
   than 12 digits. GOA's own endpoints silently tolerate that (or the
   retry logic elsewhere masks it), but Dhani's Captcha endpoint hard-
   rejects it: "The parameter Random is not a valid 12 digit number".
   Sampling from [1e11, 1e12) instead guarantees exactly 12 digits. */
function lotteryRandom() { return Math.floor(1e11 + Math.random() * 9e11); }

/** Auto-sign a webapi payload (captcha, login, transfer) — GOA convention */
function signWebapi(body) {
  const d = { ...body, language: 0, random: randomHex() };
  d.signature = signPayload(d);
  d.timestamp = Math.floor(Date.now() / 1000);
  return d;
}

/** Auto-sign a webapi payload — Dhani convention: language:'en' and a
 *  12-digit integer random. Deliberately does NOT coerce numeric strings
 *  the way signLottery does: userName is a digit string, and turning it
 *  into a number changes the JSON and therefore the signature. */
function signWebapiEn(body) {
  const d = { ...body, language: 'en', random: lotteryRandom() };
  d.signature = signPayload(d);
  d.timestamp = Math.floor(Date.now() / 1000);
  return d;
}

/** Sign a house-layer payload using the platform's own convention. */
function signFor(pid, body) {
  return platforms.get(pid).sign === 'webapi_en'
    ? signWebapiEn(body)
    : signWebapi(body);
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

/** Generate a realistic-looking slider track, sized to the platform's
 *  captcha geometry. The clamp and centre-line used to be hardcoded to
 *  GOA's 280x175 image; Dhani renders 340x212, where those numbers cut
 *  the drag short. Both now come from platforms.js.
 *
 *  `t` MUST be real elapsed milliseconds since drag start, matching the
 *  caller's startTime/endTime — it previously carried the loop's STEP
 *  INDEX (1, 2, 3…) instead, so a claimed 2-second drag had track points
 *  spanning only ~20ms. That contradiction is exactly what a track-shape
 *  anti-bot check looks for, and is the confirmed cause of Dhani's
 *  "Verification failed" on relogin (GOA apparently doesn't check this).
 *  Eased so early movement is faster and it decelerates into the target,
 *  the way a real drag-to-release does, with small per-point jitter. */
function _fakeTrack(sliderX, geo, durationMs) {
  const maxX   = geo.bgW - geo.slW;      // furthest the piece can travel
  const midY   = Math.round(geo.bgH / 2);
  const tracks = [];
  const steps  = 15 + Math.floor(Math.random() * 10);
  for (let i = 0; i < steps; i++) {
    const frac  = (i + 1) / steps;
    const eased = 1 - Math.pow(1 - frac, 2);   // ease-out: decelerate near the end
    const x = Math.round(sliderX * eased + (Math.random() - 0.5) * 3);
    const y = Math.round(midY + (Math.random() - 0.5) * 4);
    const t = Math.max(1, Math.round(durationMs * frac + (Math.random() - 0.5) * 15));
    tracks.push({ x: Math.max(0, Math.min(x, maxX)), y, t });
  }
  tracks[tracks.length - 1].x = Math.max(0, Math.min(sliderX, maxX)); // land exactly on target
  return tracks;
}

/**
 * Auto re-login for a given account on a given platform.
 * @param {string} platformId — 'goa' | 'dhan' (see platforms.js)
 * @param {string} phone      — raw phone number (e.g. "9150306499")
 * @param {string} pwd        — plain-text password
 * @returns {{ ok:boolean, lotteryToken?:string, webapiToken?:string, msg?:string }}
 */
async function relogin(platformId, phone, pwd) {
  if (!phone || !pwd) return { ok: false, msg: 'No phone or password' };

  const pid  = platforms.resolve(platformId);
  const P    = platforms.get(pid);
  const TAG  = `[RELOGIN:${pid}]`;
  const rnd  = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

  const cleaned = phone.replace(/[^0-9]/g, '');
  const username = cleaned.length <= 10 ? '91' + cleaned : cleaned;
  const maskedUser = username.length > 4 ? username.slice(0, -4).replace(/./g, '*') + username.slice(-4) : username;

  try {
    console.log(`${TAG} step1: fetching captcha for ${maskedUser}`);

    /* Step 1: Get captcha */
    const captchaRes = await httpPost(platforms.url(pid, 'captcha'), signFor(pid, {}), platforms.headers(pid));
    if (!captchaRes || captchaRes.code !== 0 || !captchaRes.data) {
      console.error(`${TAG} step1 FAILED: ${JSON.stringify(captchaRes).slice(0, 300)}`);
      return { ok: false, msg: 'Captcha fetch failed: ' + (captchaRes?.msg || 'unknown') };
    }

    const captchaId = captchaRes.data.captchaId;
    if (!captchaId) return { ok: false, msg: 'No captchaId in response' };
    console.log(`${TAG} step1 OK: captchaId=${mask(captchaId, 8)}`);

    /* Step 2: Generate slider track, sized to this platform's geometry.
       durationMs drives BOTH the track's t values and the startTime/endTime
       gap — they must agree (see _fakeTrack's comment for why). Randomized
       around the real ~1951ms human drag captured from Dhani's own client. */
    const geo        = P.captcha;
    const maxDrag     = geo.bgW - geo.slW;
    const sliderX     = Math.round(maxDrag * (0.4 + Math.random() * 0.4));
    const durationMs  = 1500 + Math.floor(Math.random() * 900); // ~1.5-2.4s
    const tracks      = _fakeTrack(sliderX, geo, durationMs);
    const now         = Date.now();
    console.log(`${TAG} step2: track ${tracks.length} pts, sliderX=${sliderX}/${maxDrag}, duration=${durationMs}ms, t span=${tracks[0].t}-${tracks[tracks.length - 1].t}ms`);

    /* Step 3: Login */
    const loginBody = platforms.buildLoginBody(pid, {
      username, pwd, captchaId, rnd,
      track: {
        backgroundImageWidth:  geo.bgW,
        backgroundImageHeight: geo.bgH,
        sliderImageWidth:      geo.slW,
        sliderImageHeight:     geo.slH,
        startTime: new Date(now - durationMs).toISOString(),
        endTime:   new Date(now).toISOString(),
        tracks,
      },
    });

    const loginRes = await httpPost(platforms.url(pid, 'login'), signFor(pid, loginBody), platforms.headers(pid));

    if (!loginRes || loginRes.code !== 0 || !loginRes.data) {
      console.error(`${TAG} step3 FAILED: ${JSON.stringify(loginRes).slice(0, 500)}`);
      return { ok: false, msg: 'Login failed: ' + (loginRes?.msg || 'code=' + loginRes?.code) };
    }
    console.log(`${TAG} step3 OK: code=${loginRes.code}`);

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

    console.log(`${TAG} ✅ ${phone} | webapi:${webapiToken ? mask(webapiToken) : 'none'} lottery:${lotteryToken ? mask(lotteryToken) : 'none'}`);

    /* Steps 4+5: activate the lottery session and fund the lottery wallet */
    activateSession(pid, d, webapiToken);

    return { ok: true, lotteryToken, webapiToken };
  } catch (e) {
    console.error(`${TAG} ❌ ${phone} error: ${e.message}`);
    return { ok: false, msg: e.message };
  }
}

/* Post-login activation, shared by relogin and the browser login route:
   open the lottery session URL, then move funds main → lottery wallet.
   Both are fire-and-forget — a failure here must not fail the login.
   A platform with no transfer endpoint (transfer: null) skips that step. */
function activateSession(pid, data, webapiToken) {
  if (data.lotteryLoginUrl) {
    httpGet(data.lotteryLoginUrl).catch(() => {});
  }
  const transferUrl = platforms.url(pid, 'transfer');
  if (transferUrl && webapiToken) {
    httpPost(transferUrl, signFor(pid, {}), {
      ...platforms.headers(pid),
      Authorization: `Bearer ${webapiToken}`,
    }).catch(() => {});
  }
}

/* ═══════════════════════════════════════════
   Route Mounter
   ═══════════════════════════════════════════ */

function mount(app) {

  /* ══════════════════════════════════════════════════════════════════
     HOUSE LAYER — per-platform (login / captcha / wallet).
     Mounted twice: the canonical /api/platform/:pid/… form, and the
     legacy /api/goa/… paths kept as GOA aliases so an older client
     keeps working through a deploy.
     ══════════════════════════════════════════════════════════════════ */

  /* Platform id from the route, defaulting to GOA for the legacy paths.
     Unknown ids are rejected rather than silently falling back — a typo
     must not send someone's credentials to the wrong site. */
  function pidOf(req, res) {
    if (req.params.pid === undefined) return platforms.DEFAULT_PLATFORM;
    if (!platforms.isValid(req.params.pid)) {
      res.status(404).json({ code: -1, msg: 'Unknown platform' });
      return null;
    }
    return platforms.resolve(req.params.pid);
  }

  /** Register one handler on both the platform route and the legacy
   *  /api/goa alias, so old and new clients hit the same code. */
  const route = (method, suffix, handler) => {
    app[method](`/api/platform/:pid${suffix}`, handler);
    app[method](`/api/goa${suffix}`, handler);
  };

  /* ── Platform list — drives the client's platform picker ── */
  app.get('/api/platforms', (_req, res) => res.json(platforms.list()));

  /* ── Captcha (public) ── */
  route('post', '/captcha', async (req, res) => {
    const pid = pidOf(req, res); if (!pid) return;
    try {
      const result = await httpPost(platforms.url(pid, 'captcha'), signFor(pid, req.body || {}), platforms.headers(pid));
      res.json(result);
    } catch (e) {
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Login — full activation flow ── */
  route('post', '/login', async (req, res) => {
    const pid = pidOf(req, res); if (!pid) return;
    try {
      const result = await httpPost(platforms.url(pid, 'login'), signFor(pid, req.body || {}), platforms.headers(pid));

      if (result.code === 0 && result.data) {
        const d = result.data;
        const webapiToken  = d.token || '';
        let   lotteryToken = '';

        if (d.lotteryLoginUrl) {
          const m = d.lotteryLoginUrl.match(/Token=([^&]+)/);
          if (m) lotteryToken = decodeURIComponent(m[1]);
        }

        console.log(`[PROXY:${pid}] Login OK | webapi:${webapiToken ? mask(webapiToken) : 'none'} lottery:${lotteryToken ? mask(lotteryToken) : 'none'}`);

        activateSession(pid, d, webapiToken);
      }

      res.json(result);
    } catch (e) {
      console.error(`[PROXY:${pid}] Login error: ${e.message}`);
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Wallet transfer (main → lottery) ── */
  route('post', '/wallet-transfer', async (req, res) => {
    const pid = pidOf(req, res); if (!pid) return;
    const token = extractBearer(req.headers['authorization']);
    if (!token) return res.status(401).json({ code: -1, msg: 'No token' });

    const transferUrl = platforms.url(pid, 'transfer');
    /* Platforms without a transfer endpoint fund the lottery wallet
       directly — report success so the client flow is identical. */
    if (!transferUrl) return res.json({ code: 0, msg: 'No transfer step on this platform' });

    try {
      const result = await httpPost(transferUrl, signFor(pid, {}), {
        ...platforms.headers(pid),
        Authorization: `Bearer ${token}`,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ code: -1, msg: 'Transfer error' });
    }
  });

  /* ── Webapi POST (whitelisted per platform) ── */
  route('post', '/webapi/:ep', async (req, res) => {
    const pid = pidOf(req, res); if (!pid) return;

    /* Resolve the requested endpoint name against this platform's
       whitelist. Endpoints are mapped explicitly, not derived from a
       shared prefix — Dhani roots auth under /api/Home but the profile
       call under /api/User, so any derived base would misroute. */
    const pathKey = platforms.get(pid).webapiPost[req.params.ep];
    if (!pathKey) return res.status(403).json({ code: -1, msg: 'Blocked' });

    const target = platforms.url(pid, pathKey);
    if (!target) return res.status(404).json({ code: -1, msg: 'Not available on this platform' });

    try {
      const token   = extractBearer(req.headers['authorization']);
      const headers = { ...platforms.headers(pid), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const result  = await httpPost(target, signFor(pid, req.body || {}), headers);
      res.json(result);
    } catch (e) {
      res.status(500).json({ code: -1, msg: 'Proxy error' });
    }
  });

  /* ── Lottery POST — Bet placement ── */
  route('post', '/lottery/:ep', async (req, res) => {
    const pid = pidOf(req, res); if (!pid) return;
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
        ...platforms.headers(pid),
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
  route('get', '/lottery/:ep', async (req, res) => {
    const pid = pidOf(req, res); if (!pid) return;
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
        ...platforms.headers(pid),
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
  route('get', '/draw/:mode', async (req, res) => {
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
  route('get', '/time', (_req, res) => {
    res.json({ syncedNow: syncedNow(), offsetMs: timeOffsetMs, lastSyncAt });
  });

  console.log(`[PROXY] Routes mounted — platforms: ${Object.keys(platforms.PLATFORMS).join(', ')}`);
}

/* ── Exports ── */
module.exports = {
  mount, startTimeSync, syncedNow, httpPost, httpGet,
  signLottery, signWebapi, signWebapiEn, signFor, signPayload,
  randomHex, extractBearer, relogin, activateSession,
  GOA_API, GOA_WEB, GOA_DRAW,
};
