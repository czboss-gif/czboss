/* ═══════════════════════════════════════════
   KINGPIN — Platform Registry
   ─────────────────────────────────────────
   One entry per betting site. A platform describes only the
   "house" layer — login / captcha / wallet — which is unique
   to each white-label site.

   The GAME layer (api.ar-lottery01.com for bets/balance and
   draw.ar-lottery01.com for results) is SHARED by every platform
   and lives in proxy.js. The public draw feed carries no tenant
   parameter, so issue numbers and drawn numbers are identical
   across platforms — prediction is therefore platform-independent
   and needs no entry here.

   Adding a new platform = one entry in PLATFORMS. No code changes.
   ═══════════════════════════════════════════ */

/* ── Sign conventions ──────────────────────────────────────────
   Both platforms use the SAME signature algorithm (MD5 of sorted,
   empty-dropped, JSON-stringified payload — see proxy.signPayload,
   timestamp excluded). They differ only in the two auto-added
   fields:
     'webapi'    → language: 0     + 32-char hex random   (GOA)
     'webapi_en' → language: 'en'  + 12-digit int random  (Dhani)
   NOTE: 'webapi_en' must NOT coerce numeric strings to numbers the
   way signLottery does — userName is a digit string and coercing it
   changes the JSON and breaks the signature.
   ──────────────────────────────────────────────────────────── */

const PLATFORMS = {

  goa: {
    id:      'goa',
    name:    'GOA Games',
    webHost: 'https://api.goa7777.com',
    origin:  'https://goagames.social',
    sign:    'webapi',

    paths: {
      login:    '/api/webapi/Login',
      captcha:  '/api/webapi/Captcha',
      userInfo: '/api/webapi/GetUserInfo',
      transfer: '/api/webapi/Transfer',
    },

    /* Endpoints the browser may POST through /api/platform/goa/webapi/:ep,
       mapped to the `paths` key each one resolves to. Acts as the SSRF
       whitelist: anything not named here is refused. */
    webapiPost: { Login: 'login', Captcha: 'captcha', GetUserInfo: 'userInfo', Transfer: 'transfer' },

    /* Slider captcha geometry, in DISPLAYED pixels — these are the
       values the site reports in the login track payload, not the
       native image size. */
    captcha: { bgW: 280, bgH: 175, slW: 56, slH: 175 },

    /* Login body field names for server-side relogin. The browser
       builds its own body for interactive login; this map is only
       used when the engine re-logs in headlessly. */
    login: {
      user: 'username',
      pass: 'pwd',
      type: 'logintype', typeValue: 'mobile',
      pack: 'packId',
      extra: (rnd) => ({ phonetype: 0, deviceId: 'kp_' + rnd(8) }),
    },
  },

  dhan: {
    id:      'dhan',
    name:    'Dhani Win',
    webHost: 'https://dhaniwin88.com',
    origin:  'https://dhaniwin88.com',
    sign:    'webapi_en',

    paths: {
      login:    '/api/Home/Login',
      captcha:  '/api/Home/Captcha',
      userInfo: '/api/User/GetUserInfo',
      /* Transfer endpoint not yet captured. Until it is, login skips
         the main→lottery wallet transfer step (proxy.activateSession
         treats a null path as "no transfer needed"). If Dhani turns
         out to require one, add the path here and nothing else changes. */
      transfer: null,
    },

    /* Note the differing prefixes — Home/ for auth, User/ for profile.
       This is why endpoints are mapped explicitly rather than derived. */
    webapiPost: { Login: 'login', Captcha: 'captcha', GetUserInfo: 'userInfo' },

    /* Native images are 552x344 (bg) and 110x344 (slider); the site
       renders them at ~61.6% scale and reports THESE numbers. */
    captcha: { bgW: 340, bgH: 212, slW: 68, slH: 212 },

    login: {
      user: 'userName',
      pass: 'password',
      type: 'loginType', typeValue: 'Mobile',
      pack: 'packageName',
      /* Dhani sends deviceId empty and carries a browser fingerprint
         instead. A fresh 32-hex id per login mimics a new browser. */
      extra: (rnd) => ({ deviceId: '', browserId: rnd(32) }),
    },
  },

};

const DEFAULT_PLATFORM = 'goa';

/** Normalise + validate a platform id. Falls back to GOA so that
 *  legacy callers and pre-platform DB rows keep working. */
function resolve(id) {
  const pid = String(id || '').trim().toLowerCase();
  return PLATFORMS[pid] ? pid : DEFAULT_PLATFORM;
}

/** Platform descriptor by id (always returns one — never null). */
function get(id) {
  return PLATFORMS[resolve(id)];
}

/** True only for an exact, known platform id (no fallback). */
function isValid(id) {
  return !!PLATFORMS[String(id || '').trim().toLowerCase()];
}

/** Public list for the client's platform picker. Includes the login
 *  field-name map (user/pass/type/typeValue/pack) so the browser can
 *  build a correctly-shaped login body without hardcoding it — adding
 *  a platform here is then a client-side no-op. `extra` is left out:
 *  it's a function (server-side relogin only), not serializable, and
 *  the one field it adds beyond deviceId (GOA's phonetype) is small
 *  enough that the client sets it directly for the one platform that
 *  needs it. */
function list() {
  return Object.values(PLATFORMS).map(p => ({
    id: p.id, name: p.name, captcha: p.captcha,
    login: { user: p.login.user, pass: p.login.pass, type: p.login.type, typeValue: p.login.typeValue, pack: p.login.pack },
  }));
}

/** Absolute URL for one of a platform's named house endpoints.
 *  Returns null when the platform has no such endpoint. */
function url(id, pathKey) {
  const p = get(id);
  const rel = p.paths[pathKey];
  return rel ? p.webHost + rel : null;
}

/** Outbound Origin/Referer for a platform — sites reject mismatches. */
function headers(id) {
  const p = get(id);
  return { 'Origin': p.origin, 'Referer': p.origin + '/' };
}

/** Build a login body in the platform's own field naming, for
 *  server-side relogin. Caller supplies the platform-neutral values
 *  plus `rnd(n)` — a random-hex generator of n characters. */
function buildLoginBody(id, { username, pwd, captchaId, track, rnd }) {
  const f = get(id).login;
  return {
    [f.user]: username,
    [f.pass]: pwd,
    [f.type]: f.typeValue,
    [f.pack]: '',
    captchaId,
    track,
    ...f.extra(rnd),
  };
}

module.exports = {
  PLATFORMS, DEFAULT_PLATFORM,
  resolve, get, isValid, list, url, headers, buildLoginBody,
};
