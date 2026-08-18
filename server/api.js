/* ═══════════════════════════════════════════
   KINGPIN 3.0 — Server-Side API Module (Multi-Account)
   All functions accept account object for tokens.
   Token rotation writes back to account directly.
   ═══════════════════════════════════════════ */

const proxy = require('./proxy');
const KP    = require('./config');

const HEADERS = {
  'Origin':  'https://goagames.social',
  'Referer': 'https://goagames.social/',
};

/** Handle token rotation from response — updates account directly */
function rotateToken(acct, result) {
  if (result && result._respAuth) {
    const raw = proxy.extractBearer(result._respAuth);
    if (raw) {
      acct.lotteryToken = raw;
      console.log(`[API] Token rotated for ${acct.phone}`);
    }
    delete result._respAuth;
  }
}

/* ═══ Balance ═══ */
async function getBalance(acct) {
  const token = acct.lotteryToken;
  if (!token) return { code: -1, msg: 'No token' };

  const signed = proxy.signLottery({});
  const qs = new URLSearchParams(signed).toString();
  const url = `${proxy.GOA_API}/api/Lottery/GetBalance?${qs}`;

  try {
    const result = await proxy.httpGet(url, {
      ...HEADERS,
      'Authorization': `Bearer ${token}`,
    });
    rotateToken(acct, result);
    return result;
  } catch (err) {
    const diag = err._proxy || {};
    console.error(`[API] getBalance NETWORK FAIL | ${diag.code || err.code || '?'} ${err.message} (${diag.ms || '?'}ms)`);
    return { code: -1, msg: err.message || 'Network error' };
  }
}

/* ═══ Place Bet ═══ */
async function placeBet(acct, issueNumber, betAmount, betContent) {
  const token = acct.lotteryToken;
  if (!token) return { code: -1, msg: 'No token' };

  const body = proxy.signLottery({
    gameCode: acct.gameMode || KP.GAME_MODE,
    issueNumber,
    amount: 1,
    betMultiple: betAmount,
    betContent,
  });

  try {
    const result = await proxy.httpPost(`${proxy.GOA_API}/api/Lottery/WinGoBet`, body, {
      ...HEADERS,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    });
    rotateToken(acct, result);
    return result;
  } catch (err) {
    /* Network errors (socket hang up, ECONNRESET, timeout, etc.) → return code:-1
       so callers' existing retry logic handles them instead of crashing.
       Diagnostic fields from proxy.tagError are passed through for logging. */
    const diag = err._proxy || {};
    console.error(`[API] placeBet NETWORK FAIL | issue=${issueNumber} amt=${betAmount} | ${diag.code || err.code || '?'} ${err.message} (${diag.ms || '?'}ms)`);
    return { code: -1, msg: err.message || 'Network error', _netError: diag.code || err.code || 'UNKNOWN' };
  }
}

/* ═══ Draw History (public — no auth) ═══ */
async function getDrawHistory(pageSize = 20, gameMode = KP.GAME_MODE) {
  const url = `${proxy.GOA_DRAW}/WinGo/${gameMode}/GetHistoryIssuePage.json?pageSize=${pageSize}&t=${Date.now()}`;
  try {
    return await proxy.httpGet(url);
  } catch (err) {
    const diag = err._proxy || {};
    console.error(`[API] getDrawHistory NETWORK FAIL | ${diag.code || err.code || '?'} ${err.message} (${diag.ms || '?'}ms)`);
    return { code: -1, msg: err.message || 'Network error', data: { list: [] } };
  }
}

/* ═══ Deep History (authenticated — paginated) ═══ */
async function getDeepHistory(acct, total = 160) {
  const token = acct.lotteryToken;
  if (!token) return { code: -1, msg: 'No token', data: { list: [] } };

  const PER_PAGE = 10;
  const maxPages = Math.ceil(total / PER_PAGE);
  const allRecords = [];
  let serverTotalPages = Infinity;

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    try {
      const signed = proxy.signLottery({
        gameCode: acct.gameMode || KP.GAME_MODE,
        pageNo,
        pageSize: 10,
      });
      const qs = new URLSearchParams(signed).toString();
      const url = `${proxy.GOA_API}/api/Lottery/GetHistoryIssuePage?${qs}`;

      const res = await proxy.httpGet(url, {
        ...HEADERS,
        'Authorization': `Bearer ${token}`,
      });
      rotateToken(acct, res);

      console.log(`[API] DeepHist page ${pageNo} raw → code=${res?.code} totalPage=${res?.data?.totalPage} totalCount=${res?.data?.totalCount} listLen=${res?.data?.list?.length}`);
      if (res && res.code === 0 && res.data && Array.isArray(res.data.list)) {
        allRecords.push(...res.data.list);
        // NOTE: do NOT cap by serverTotalPages — the server reports current-window totalPage
        // which can be < maxPages. We trust maxPages (caller-controlled) instead.
        if (res.data.totalPage && serverTotalPages === Infinity) {
          serverTotalPages = res.data.totalPage;
          console.log(`[API] DeepHist: server says totalPage=${serverTotalPages}, totalCount=${res.data.totalCount}, but we want ${maxPages} pages — will continue past server totalPage`);
        }
        console.log(`[API] Deep history page ${pageNo}/${maxPages}: +${res.data.list.length} (total ${allRecords.length})`);
        if (res.data.list.length === 0) {
          console.log(`[API] DeepHist: empty list on page ${pageNo} — stopping.`);
          break;
        }
      } else {
        console.warn(`[API] Deep history page ${pageNo} failed: code=${res?.code} msg=${res?.msg}`);
        break;
      }
    } catch (e) {
      console.warn(`[API] Deep history page ${pageNo} error:`, e.message);
      break;
    }
  }
  return { code: allRecords.length > 0 ? 0 : -1, data: { list: allRecords } };
}

/* ═══ Bet Record (My Bet Record — authenticated) ═══ */
async function getBetRecord(acct, page = 1, pageSize = 10) {
  const token = acct.lotteryToken;
  if (!token) return { code: -1, msg: 'No token' };

  const signed = proxy.signLottery({
    gameCode: acct.gameMode || KP.GAME_MODE,
    pageNo: page,
    pageSize,
    language: 'en',
  });
  const qs = new URLSearchParams(signed).toString();
  const url = `${proxy.GOA_API}/api/Lottery/GetRecordPage?${qs}`;

  const result = await proxy.httpGet(url, {
    ...HEADERS,
    'Authorization': `Bearer ${token}`,
  });
  rotateToken(acct, result);
  return result;
}

/* ═══ Record Page (Game History — authenticated) ═══ */
async function getRecordPage(acct, pageNo = 1, pageSize = 10) {
  const token = acct.lotteryToken;
  if (!token) return { code: -1, msg: 'No token' };

  const signed = proxy.signLottery({
    gameCode: acct.gameMode || KP.GAME_MODE,
    pageNo,
    pageSize,
    language: 'en',
  });
  const qs = new URLSearchParams(signed).toString();
  const url = `${proxy.GOA_API}/api/Lottery/GetRecordPage?${qs}`;

  const result = await proxy.httpGet(url, {
    ...HEADERS,
    'Authorization': `Bearer ${token}`,
  });
  rotateToken(acct, result);
  return result;
}

/* ═══ Server Time ═══ */
function getServerTime() {
  return {
    syncedNow: proxy.syncedNow(),
    offsetMs: 0,
    lastSyncAt: Date.now(),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   PER-ACCOUNT REQUEST SERIALIZATION  (fixes the code:7 → code:13 cascade)
   ──────────────────────────────────────────────────────────────────────────
   GOA issues SINGLE-USE rotating tokens: every response returns the next token
   and invalidates the current one (see rotateToken). If two requests for the
   same account run concurrently they send the SAME token, GOA accepts the first
   and REJECTS the second with code:7. That rejection then cascades — the bet
   retry burns ~1s, the period rolls over, GOA returns code:13 "issue does not
   exist", the issue gets blacklisted in _failedIssues, and the account stalls
   ("already failed this session" / "only 1s left" loops).
   The 30s balance interval and the un-awaited bet-record refresh race the bet
   exactly this way. Serializing every token-consuming call per account makes the
   rotating token strictly sequential, eliminating the race at its source.
   Public draw history (getDrawHistory — no token) is intentionally left
   concurrent so polling stays fast. ══════════════════════════════════════════ */
function withTokenLock(acct, fn) {
  const prev = acct._reqChain || Promise.resolve();
  const run = prev.then(fn, fn);               // run after the previous call settles (either way)
  acct._reqChain = run.then(() => {}, () => {}); // keep the chain alive; never poison it on error
  return run;                                   // caller still gets the real result/rejection
}
function _serialize(fn) {
  return function (acct, ...args) {
    if (!acct) return fn(acct, ...args);
    return withTokenLock(acct, () => fn(acct, ...args));
  };
}

module.exports = {
  rotateToken,
  getDrawHistory, getServerTime,               // public / no token — not serialized
  getBalance:    _serialize(getBalance),
  placeBet:      _serialize(placeBet),
  getDeepHistory:_serialize(getDeepHistory),
  getBetRecord:  _serialize(getBetRecord),
  getRecordPage: _serialize(getRecordPage),
};
