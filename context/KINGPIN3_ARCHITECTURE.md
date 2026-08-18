# KINGPIN 3.0 — Full Architecture & Code Context

> **Purpose of this document:** Drop this file into any new chat as context.  
> It gives a complete, developer-accurate picture of the entire codebase so an AI can understand architecture, code style, patterns, and constraints without re-reading source files.

---

## 1. Project Overview

**KINGPIN 3.0** is a multi-account autobet system for the **GoaGames WinGo** lottery game.  
It runs as a **Node.js + Express + Socket.IO** server with a **vanilla JS single-page frontend**.

| Item | Value |
|------|-------|
| Game | WinGo_30S (30-second rounds), configurable |
| Game API Base | `https://api.ar-lottery01.com` (env: `GOA_API`) |
| Web API Base | `https://api.goa7777.com` |
| Draw API Base | `https://draw.ar-lottery01.com` |
| Server Port | `3000` (env: `PORT`) |
| MongoDB | `mongodb://127.0.0.1:27017/kingpin` |
| Win Multiplier | `1.96` |
| Cycle Duration | `30,000 ms` |
| GOA Period Offset | `27,000 ms` (bets placed ~27s into each 30s period) |

---

## 2. Directory Structure

```
wingo-server/backend/
├── server/
│   ├── index.js          # App entry point — Express + Socket.IO + MongoDB (305 lines)
│   ├── config.js         # All constants, game settings, formula metadata (52 lines)
│   ├── proxy.js          # HTTP proxy to GoaGames APIs, signing, relogin (585 lines)
│   ├── api.js            # Server-side authenticated API calls (191 lines)
│   ├── state.js          # Account class, in-memory registry, MongoDB persistence (310 lines)
│   ├── engine.js         # AccountEngine — core betting loop per account (1108 lines)
│   ├── prediction.js     # All 7 formula implementations, dispatcher (327 lines)
│   ├── admin.js          # Admin panel HTTP routes, auth, freq-map CRUD (190 lines)
│   ├── bet-logger.js     # Structured bet/balance audit logging (41 lines)
│   └── models/
│       ├── UserConfig.js # Mongoose schema: per-account config (51 lines)
│       ├── BetHistory.js # Mongoose schema: per-bet records (26 lines)
│       └── PredHistory.js# Mongoose schema: per-prediction records (24 lines)
├── public/
│   ├── index.html        # Main dashboard SPA — 1237 lines (HTML + inline JS)
│   ├── admin.html        # Admin panel UI (346 lines)
│   └── css/
│       └── autobet.css   # All styles
├── data/
│   ├── freq-map.json     # Admin-managed digit→frequency map
│   └── ab-passwords.json # Access control password list
├── context/
│   └── KINGPIN3_ARCHITECTURE.md  # ← this file
├── package.json
└── .env                  # GOA_API, ENC_SECRET, ADMIN_PASSWORD_HASH, PORT
```

---

## 3. Authentication & Token Flow

### Critical Constraints
- **`lotteryToken` lives in server memory only** — stored in `acct.lotteryToken` (an `Account` instance field).
- It is **NOT persisted to MongoDB**. After server restart, all accounts need to re-authenticate via the browser login.
- `webapiToken` same — in-memory only.
- `pwd` (plain-text password) is stored in-memory for auto-relogin; the **encrypted version** (`encPwd`) is saved to MongoDB.

### Login Flow (Browser → Server)
```
Browser:
  1. POST /api/goa/captcha → get captchaId + slider image
  2. User drags slider → collect track data
  3. POST /api/goa/login { username, captchaId, track, pwd }
     → server extracts lotteryToken from response.data.lotteryLoginUrl
       (regex: /Token=([^&]+)/)
     → server also fires GET lotteryLoginUrl (activates session)
     → server fires POST Transfer (moves funds to lottery wallet)
  4. Browser stores { phone, lotteryToken, webapiToken, pwd } in sessionStorage['kp_accounts']
  5. Browser emits socket.emit('auth', { phone, lotteryToken, webapiToken, pwd })
  6. Server: createAccount(phone) → sets acct.lotteryToken, acct.pwd
  7. Server emits 'state' + 'logs' back to the socket room (phone-scoped)
```

### Token Rotation
Every response from the lottery API may include an `Authorization` header.  
`proxy.js` detects this and stores it in `result._respAuth`.  
`api.js → rotateToken(acct, result)` reads it and updates `acct.lotteryToken` in-place.

### Auto Re-Login (`proxy.relogin(phone, pwd)`)
- Steps: fetch captcha → generate fake slider track (`_fakeTrack()`) → POST Login → extract tokens
- **Known Issue: Often fails** — GoaGames captcha slider rejects synthetic tracks
- Used by `engine.js` on `code: 4 / 401 / 403` responses; fires `broadcast('reauth', ...)` to update browser tokens

---

## 4. API Signing

All calls to GoaGames lottery API require signing. Two signing functions in `proxy.js`:

### `signLottery(body)` — for lottery endpoints
```js
// Adds: language:'en', random (12-digit int), signature (MD5), timestamp
// MD5 input: JSON.stringify of sorted non-empty non-special keys (uppercase hex)
// Special keys skipped in signature: 'signature', 'track', 'xosoBettingData'
const d = { ...body, language: 'en', random: lotteryRandom() };
d.signature = signPayload(d);   // MD5 of sorted JSON
d.timestamp = Math.floor(Date.now() / 1000);
```

### `signWebapi(body)` — for webapi endpoints (login, captcha, transfer)
```js
// Adds: language:0, random (hex string), signature, timestamp
const d = { ...body, language: 0, random: randomHex() };
d.signature = signPayload(d);
d.timestamp = Math.floor(Date.now() / 1000);
```

### `signPayload(data)` — core MD5 logic
```js
// Sort keys alphabetically, skip empty/null/'signature'/'track'/'xosoBettingData'
// MD5(JSON.stringify(sortedObj)) → uppercase hex
```

---

## 5. File-by-File Breakdown

---

### `server/config.js` — Constants
**Exports:** `KP` object (the only constants source)

```js
KP.GAME_MODE      = 'WinGo_30S'        // or 'WinGo_1M', etc.
KP.WIN_MULTIPLIER = 1.96
KP.CYCLE_MS       = 30000
KP.GOA_PERIOD_OFFSET = 27000           // ms offset for bet timing
KP.ENGINE_TICK    = 500                // ms per engineStep() call
KP.DEFAULT_LEVELS = [2,4,10,23,49,102,212,436,898,1830]   // 10-level martingale
KP.DEFAULT_FORMULA = 'hash'
KP.DRAW_POLL_TIMEOUT = 30000

KP.FORMULAS = {
  hash:     { name:'🎲 Simple Hash',     desc:'...' },
  gemini:   { name:'👑 Gemini Ensemble', desc:'...' },
  snake:    { name:'🐍 Snake Trend',     desc:'...' },
  kingpin3: { name:'🔱 Kingpin 3.0',     desc:'...' },
  f123:     { name:'🎯 F123 Pro',        desc:'...' },
  f123a:    { name:'🔄 F123 Analyze',    desc:'...' },
  dna3:     { name:'🧬 DNA 3',           desc:'...' },
}
```

---

### `server/index.js` — Entry Point
**What it does:**
- Creates Express app, HTTP server, Socket.IO server
- Connects to MongoDB (gracefully falls back if unavailable)
- Mounts routes: `proxy.mount(app)`, `admin.mount(app)`, `express.static('public')`
- Manages `engines = new Map()` (phone → AccountEngine instance)
- Broadcasts `accountList` every 10s to all connected clients

**Key functions:**
```js
getOrCreateEngine(phone)   // gets existing or creates new AccountEngine
destroyEngine(phone)       // stops engine, removes account, clears map entry
```

**Socket.IO Event Handlers (server-side):**

| Event Received | What Server Does |
|---|---|
| `auth` | `createAccount(phone)`, set tokens, `getOrCreateEngine`, join room, `startPassive()`, emit `state` + `logs` + `accountList` |
| `switchView` | join new room, emit `state` + `logs` for that account |
| `start` | `engine.start()` |
| `stop` | `engine.stop()` |
| `setFormula` | `acct.setFormula(f)`, `saveConfig(phone)`, emit `state` |
| `setLevels` | compute martingale array from `{baseAmt, maxLevel}`, `acct.setLevels()`, `saveConfig()` |
| `setWatch` | set `watchEnabled`, `watchLossTarget`, `saveConfig()` |
| `refreshBalance` | `engine.fetchBalance()` |
| `getBetRecord` | `engine.refreshBetRecord()` |
| `resetStats` | `acct.resetSession()`, emit `state` |
| `logout` | `destroyEngine(phone)`, emit `accountRemoved` |
| `listAccounts` | emit `accountList` |

**Martingale Level Generation** (in `setLevels` handler):
```js
// baseAmt * 2.5^(level-1) rounded, capped at maxLevel entries
const levels = [];
for (let i = 0; i < maxLevel; i++) {
  levels.push(Math.round(baseAmt * Math.pow(2.5, i)));
}
```

---

### `server/proxy.js` — HTTP Proxy + Signing
**Exports:** `{ mount, startTimeSync, syncedNow, httpPost, httpGet, signLottery, signWebapi, signPayload, randomHex, extractBearer, relogin, GOA_API, GOA_WEB, GOA_DRAW }`

**Key constants:**
```js
GOA_API  = 'https://api.ar-lottery01.com'   // lottery API (auth required)
GOA_WEB  = 'https://api.goa7777.com'        // web API (login, captcha, transfer)
GOA_DRAW = 'https://draw.ar-lottery01.com'  // public draw history (no auth)
```

**SSRF Whitelists:**
```js
LOTTERY_GET  = ['GetBalance','GetBetRecordList','GetUserInfo','GetMyEmerdList','GetRecordPage','GetHistoryIssuePage']
LOTTERY_POST = ['WinGoBet']
WEBAPI_POST  = ['Transfer','GetUserInfo','Captcha','Login']
```

**HTTP helpers (`httpGet`, `httpPost`):**
- Use `https.Agent` per-hostname with `keepAlive: false` (GoaGames sends `Connection: close`)
- `maxSockets: 6`, `REQUEST_TIMEOUT_MS: 8000`
- On `401` → resolve with `{ code: 401, msg: 'Upstream 401' }`
- On empty response → `{ code: -2, msg: 'Empty upstream response' }`
- On JSON parse failure → `{ code: -1, msg: 'Non-JSON' }`
- Errors tagged with `tagError()` → `err._proxy = { method, url, code, syscall, ms }`
- Response `Authorization` header captured as `result._respAuth` for token rotation

**Mounted Routes:**
```
POST /api/goa/captcha           → GOA_WEB/api/webapi/Captcha (public)
POST /api/goa/login             → GOA_WEB/api/webapi/Login + activate + transfer
POST /api/goa/wallet-transfer   → GOA_WEB/api/webapi/Transfer (needs auth)
POST /api/goa/webapi/:ep        → GOA_WEB/api/webapi/:ep (whitelist: WEBAPI_POST)
POST /api/goa/lottery/:ep       → GOA_API/api/Lottery/:ep (whitelist: LOTTERY_POST, needs auth)
GET  /api/goa/lottery/:ep       → GOA_API/api/Lottery/:ep (whitelist: LOTTERY_GET, needs auth)
GET  /api/goa/draw/:mode        → GOA_DRAW/WinGo/:mode/GetHistoryIssuePage.json (public)
GET  /api/goa/time              → returns { syncedNow, offsetMs, lastSyncAt }
```

**Time Sync:**
- `startTimeSync()` called on boot; re-syncs every 5 minutes
- Uses `GOA_WEB/api/webapi/GetNoaverpowerful` HTTP `Date` header
- `syncedNow()` = `Date.now() + timeOffsetMs` — use this everywhere for GOA-aligned time

---

### `server/api.js` — Server-Side API Calls
**Exports:** `{ getBalance, placeBet, getDrawHistory, getDeepHistory, getBetRecord, getRecordPage, getServerTime }`

All functions except `getDrawHistory` and `getServerTime` accept an `acct` object and use `acct.lotteryToken`.

| Function | Endpoint | Auth | Notes |
|---|---|---|---|
| `getBalance(acct)` | `GET GetBalance` | ✅ | Returns `data.totalMoney` |
| `placeBet(acct, issueNumber, betAmount, betContent)` | `POST WinGoBet` | ✅ | `betContent` = `'Big'` or `'Small'` |
| `getDrawHistory(pageSize=20)` | `GET GOA_DRAW/.../GetHistoryIssuePage.json` | ❌ Public | Shared by all accounts |
| `getDeepHistory(acct, total=160)` | `GET GetHistoryIssuePage` | ✅ | Paginated, 10/page; returns merged list |
| `getBetRecord(acct, page, pageSize)` | `GET GetRecordPage` | ✅ | **User's own bet records** |
| `getRecordPage(acct, pageNo, pageSize)` | `GET GetRecordPage` | ✅ | Same as getBetRecord |
| `getServerTime()` | — | — | Returns local synced time info |

**`getDeepHistory` pagination logic:**
```js
// Loops pages 1..maxPages, stops when page fails or serverTotalPages reached
// API caps: totalCount=500, totalPage=50 (max ~500 records ≈ 4hrs for 30S)
// Each page: pageSize=10 (API max per page)
```

**Important API distinction:**
- `GetRecordPage` → **user's own placed bets** (empty if no bets placed yet)
- `GetHistoryIssuePage` → **game draw history** (all round results, requires auth)
- Public draw history → `GOA_DRAW` host, no auth, use `getDrawHistory()`

---

### `server/state.js` — Account State
**Exports:** `{ ENGINE, Account, getAccount, createAccount, removeAccount, listAccounts, getAccountCount, saveConfig, loadConfig }`

#### `ENGINE` enum
```js
{ STOPPED: 'stopped', WATCHING: 'watching', WAITING: 'waiting', BETTING: 'betting', CHECKING: 'checking' }
```

#### `Account` class fields
```js
// Identity
phone, lotteryToken, webapiToken, pwd  // pwd = plain-text (in-memory only)

// Engine state
engine (ENGINE enum), level, highestLevel, pendingBet, preBetBal, prediction, lastPredIssue

// Stats
pnl, wins, losses, balance, sessionStart

// Config (persisted to DB)
formula, levels[], watchEnabled, watchLossTarget

// Buffers (in-memory)
histBuf[]        // draw history, newest-first, [{issueNumber, number, color}]
betHistory[]     // last 200 bets placed by bot
predHistory[]    // last 100 predictions

// Watch mode
watchPred, watchIssue, virtualWatches, watchLossCount

// Prediction internal state
predState = { geminiFlipped, geminiWarmedUp, geminiBuf[] }
```

#### `Account` key methods
```js
getStake()           // levels[level-1] — current bet amount
getMaxLevel()        // levels.length
getTotalRisk()       // sum of all levels
isRunning()          // engine !== STOPPED
snapshot()           // serializable state object (sent to browser via socket)
resetSession()       // full reset (stats + engine state)
resetEngineState()   // engine state only, keeps cumulative stats
resetForNewCycle()   // level reset after a full martingale cycle
addBetHistory(entry) // adds to in-memory + fires MongoDB upsert
addPredHistory(entry)// adds to in-memory + fires MongoDB upsert
resolvePredHistory(forIssue, result, correct)  // fills in actual result
clearTokens()        // clears lotteryToken + webapiToken
```

#### AES Password Encryption
```js
// Key: SHA-256 of process.env.ENC_SECRET (default: 'kp3-default-key')
// Algorithm: AES-256-CBC with random IV
// Format stored in DB: 'ivHex:encHex'
// Only encPwd saved to DB; plain-text pwd stays in memory
```

#### MongoDB Operations (all fire-and-forget unless during startup)
- `createAccount(phone)` → async, loads config + history from DB
- `saveConfig(phone)` → upserts `UserConfig` document
- `loadConfig(acct)` → reads `UserConfig`, applies to account fields
- `addBetHistory` / `addPredHistory` → `findOneAndUpdate` with `upsert:true`

---

### `server/engine.js` — Betting Engine
**Exports:** `AccountEngine` class  
**One instance per account.** Manages its own timers, logs, and state.

#### Constructor parameters
```js
new AccountEngine(acct, io)
// acct: Account instance from state.js
// io:   Socket.IO server instance
```

#### Internal fields
```js
_tick            // setInterval handle (500ms engine step)
_balInterval     // setInterval handle (30s balance refresh)
_passiveTick     // setInterval handle (1s passive prediction)
_busy            // prevents concurrent engineStep() calls
_polling         // prevents concurrent result polling
_logs[]          // last 100 log entries
_deepHistoryLoaded  // true after DNA3 deep history fetch
_consecutiveFailures
_failedIssues    // Set of issue numbers that failed to bet
_stuckSince      // timestamp when pendingBet got stuck (90s timeout)
```

#### Engine States & Flow
```
STOPPED → start() → WATCHING (if watchEnabled) or WAITING
WAITING → engineStep() → fetch history → predict → time window → BETTING → placeBet()
BETTING → CHECKING → poll for result in draw history → resolveResult()
  → WIN: level back to 1, log win, loop
  → LOSS: level++, if level > maxLevel → emit maxLevel event, stop
WATCHING → virtual prediction → if watchLossCount >= watchLossTarget → switch to WAITING
```

#### Key Methods

**`start()`**
- Resets engine state, resets prediction state
- Sets engine to WATCHING or WAITING
- Fetches initial history + balance
- Generates first prediction
- Starts `_tick = setInterval(engineStep, 500)` + `_balInterval = setInterval(fetchBalance, 30000)`
- Stops passive prediction loop

**`stop()`**
- Sets engine to STOPPED, clears timers
- Restarts passive prediction loop

**`engineStep()` (runs every 500ms)**
- Broadcasts countdown
- If `pendingBet` exists: poll draw history for result every 1s, broadcast bet status
- If no pending: fetch history → resolve any unresolved predHistory → predict → check timing window → place bet

**Timing logic for bet placement:**
```js
function periodInfo() {
  const adjusted = (syncedNow() - KP.GOA_PERIOD_OFFSET) % KP.CYCLE_MS;
  const pos = adjusted < 0 ? adjusted + KP.CYCLE_MS : adjusted;  // ms into current period
  const left = KP.CYCLE_MS - pos;    // ms until next period
  const secs = Math.ceil(left / 1000);
  return { pos, left, secs };
}
// Bets placed when: pos < BETTING_WINDOW (a specific ms range within period)
```

**`fetchDrawHistory(force)`**
- For DNA3 formula: first call loads 160 records via `api.getDeepHistory()`
- For others: uses shared `_sharedHistBuf` (one public API call serves all accounts)
- DNA3 merges new public records into existing deep buffer

**`tryRelogin()`**
- Calls `proxy.relogin(phone, pwd)`
- On success: updates tokens, broadcasts `reauth` event to browser
- On failure: logs error (captcha rejection is common)

**`resolveResult(pendingBet, foundRecord)`**
```js
// Compare prediction vs actual draw result
// number >= 5 → BIG, number < 5 → SMALL
// WIN: level back to 1, record win, P&L += (stake * WIN_MULTIPLIER - stake)
// LOSS: level++, record loss, P&L -= stake
//   if level > maxLevel: emit maxLevel, stop engine
```

**Shared draw history:**
```js
let _sharedHistBuf   = [];  // module-level, shared across all AccountEngine instances
let _sharedFetchTime = 0;

async function fetchSharedDrawHistory(force) {
  // Throttled: min 2s between fetches unless forced
  // Uses api.getDrawHistory(20) — public endpoint, no auth
}
```

---

### `server/prediction.js` — Formula Engine
**Exports:** `{ run, recoveryFallback, reset, currentIssueNumber }`

#### Dispatcher
```js
function run(histBuf, formulaKey, predState)
// Returns: { pred:'Big'|'Small'|'WAIT', log:string, forIssue:string, formula:string }
// histBuf: array of draw records, newest first: [{issueNumber, number, color}]
// predState: per-account mutable state object (used by gemini + hash)
```

#### Issue Number
```js
function currentIssueNumber(histBuf) {
  // Returns (BigInt(histBuf[0].issueNumber) + 1n).toString()
  // Predicts NEXT issue = latest resolved + 1
  // Format: YYYYMMDDHHMMSS### (date+time + 3-digit sequence)
}
```

#### Formulas

| Key | Function | Min Records | Needs predState | Notes |
|-----|----------|-------------|-----------------|-------|
| `hash` | `simpleHash` | 2 | ✅ (uses `.level` for L2-flip) | Sum of last 2 → range table; flips on Level 2 |
| `gemini` | `geminiEnsemble` | 5 | ✅ (geminiFlipped, geminiBuf) | 3-engine majority: Q-DNA + DigitalRoot + AntiStreak; adaptive flip |
| `snake` | `snakeTrend` | 4 | ❌ | Target number pattern match in history |
| `kingpin3` | `kingpin3Pattern` | 15 | ❌ | 10 hardcoded B/S patterns + streak reversal fallback |
| `f123` | `f123ProMajority` | 3 | ❌ | 3 sub-formulas: occurrence + period diff + two-sum; majority vote |
| `f123a` | `f123Analyze` | 3 | ❌ | Same as f123 but flips on unanimous agreement |
| `dna3` | `dna3` | 5 | ❌ | 3-BS triplet match in 160-deep history; needs deep buffer |

**`hash` (simpleHash) detail:**
```js
sum = history[0].number + history[1].number
// Range table:
// 1-4 → SMALL, 5-9 → BIG, 10-14 → SMALL, 15-18 → BIG, >=19 → BIG
// Level 2: flip the prediction
// Level 3+: same as normal (logged as L3, L4, etc.)
```

**`gemini` (geminiEnsemble) detail:**
```js
// 3 sub-engines:
_quantumDNA(buf)        // DNA pattern match: look for 4-match then 3-match in history → majority
_digitalRootPred(period, prevNum)  // digital root of (last2 of issueNumber * prevNum) >= 5 → BIG
_antiStreak(buf)        // if last 3 same → opposite; else minority of last 6

// Adaptive flip: tracks actual results vs predicted; flips global flag on mismatch
// Warmup: runs silently over first GOA_INITIAL_SIZE=10 records to calibrate flip state
// State persisted in predState.geminiFlipped, predState.geminiWarmedUp, predState.geminiBuf[]
```

**`dna3` detail:**
```js
// Needs 160-deep history (loaded once by engine.js for this formula)
// Finds 3-element B/S triplet matches in history
// Returns majority of what came BEFORE each match
// Also computes N1, N2, N3 predictions (number-level patterns)
```

**`reset(predState)`** — clears gemini state (called on engine stop/start)

---

### `server/admin.js` — Admin Routes
**Exports:** `{ mount, loadFreqMap, loadAbPasswords }`

**Authentication:** In-memory sessions (24h expiry). Session ID passed as `X-Admin-Session` header.  
Admin password stored as bcrypt hash in `process.env.ADMIN_PASSWORD_HASH`.

**Routes mounted:**
```
POST /admin/login                       → bcrypt compare → return session ID
POST /admin/logout                      → delete session
GET  /admin/check                       → validate session
GET  /admin/freqmap          [auth]     → read data/freq-map.json
POST /admin/freqmap          [auth]     → validate + save freq-map
GET  /admin/ab-passwords     [auth]     → list access passwords
POST /admin/ab-passwords     [auth]     → add new password entry
PUT  /admin/ab-passwords/:id/toggle [auth] → enable/disable
DELETE /admin/ab-passwords/:id [auth]  → delete (not protected ones)
POST /api/admin/validate-password       → public — validates against ab-passwords list
```

**AB Passwords** (`data/ab-passwords.json`) control access to `index.html` via the Root Gate:
```json
[{ "id":"ab_xxxx", "password":"...", "label":"User", "enabled":true, "protected":false, "created":"2025-01-01" }]
```
`protected: true` entries cannot be toggled or deleted.  
`role: 'admin'` returned when `protected: true` — browser stores password in sessionStorage for admin panel.

---

### `server/bet-logger.js` — Bet Audit Log
Structured logging of bet requests/responses and balance checks.  
Logs are console-only (file logging not implemented in this module).

---

### `server/models/UserConfig.js` — Mongoose Schema
```js
// Collection: user_configs
{
  phone: String (unique, required),
  formula: String,
  levels: [Number],
  encPwd: String,          // AES-256-CBC encrypted password
  watchEnabled: Boolean,
  watchLossTarget: Number,
  timestamps: true         // createdAt, updatedAt
}
```

### `server/models/BetHistory.js` — Mongoose Schema
```js
// Collection: bet_histories
{
  phone: String (required),
  issue: String,           // issueNumber
  pred: String,            // 'BIG' | 'SMALL'
  level: Number,
  amount: Number,
  won: Boolean,
  pnl: Number,
  winAmount: Number,
  time: String,
  timestamps: true
}
```

### `server/models/PredHistory.js` — Mongoose Schema
```js
// Collection: pred_histories
{
  phone: String (required),
  forIssue: String,        // issueNumber the prediction was for
  pred: String,            // 'BIG' | 'SMALL'
  formula: String,
  time: String,
  result: String,          // actual result (filled in after draw)
  correct: Boolean,        // filled in after draw
  timestamps: true
}
```

---

## 6. Frontend Architecture (`public/index.html`)

### Structure
Three screens controlled by `display` toggling:
1. **Root Gate** (`#rootGate`) — password protection before anything loads
2. **Login Screen** (`#abLoginSection`) — captcha + slider + credential login
3. **Dashboard** (`#abDashboard`) — main autobet control panel

### JavaScript Pattern
Single IIFE wrapping all logic:
```js
(function(){
  'use strict';
  // All code here
})();
```

Helper: `var $ = function(id) { return document.getElementById(id); };`

### Multi-Account State
```js
var accounts = [];        // [{ phone, lotteryToken, webapiToken, pwd }]
var currentView = null;   // phone string of account currently displayed
var socket = null;
```

**Persistence:** `sessionStorage`
- `kp_accounts` → JSON array of account objects
- `kp_current_view` → phone string
- `kp_root_unlocked` → `'1'` (root gate bypass)
- `kp_root_role` → `'admin'` or `'user'`
- `kp_admin_pwd` → admin password (stored only for role=admin)

### Socket.IO Events

**Emitted (browser → server):**
| Event | Payload |
|-------|---------|
| `auth` | `{ phone, lotteryToken, webapiToken, pwd }` |
| `switchView` | `{ phone }` |
| `start` | `{ phone }` |
| `stop` | `{ phone }` |
| `setFormula` | `{ phone, formula }` |
| `setLevels` | `{ phone, baseAmt, maxLevel }` |
| `setWatch` | `{ phone, enabled, count }` |
| `refreshBalance` | `{ phone }` |
| `getBetRecord` | `{ phone, page }` |
| `resetStats` | `{ phone }` |
| `logout` | `{ phone }` |
| `listAccounts` | `{}` |

**Received (server → browser):**
| Event | Data | Action |
|-------|------|--------|
| `state` | Full `acct.snapshot()` | Renders entire dashboard |
| `logs` | Array of log entries | Replaces log display |
| `log` | Single log entry | Prepends to log |
| `accountList` | Array of account summaries | Renders account tabs |
| `accountRemoved` | `{ phone }` | Removes from local list |
| `countdown` | `{ secs, total }` | Updates countdown display |
| `betStatus` | `{ icon, label, detail, cls, timer, bar }` | Updates bet status card |
| `maxLevel` | `{ msg }` | Shows max level banner |
| `betRecord` | `{ page, result }` | Renders bet record list |
| `toast` | `{ title, msg, type }` | Shows toast notification |
| `reauth` | `{ phone, lotteryToken, webapiToken }` | Updates stored tokens |
| `error` | `{ msg }` | Shows toast error |

### Dashboard UI Sections (Card IDs)
All cards use collapsible pattern:
```html
<div class="kp-card collapsed" id="secXxx">
  <div class="kp-card-head" onclick="this.parentElement.classList.toggle('collapsed')">
    <div class="kp-card-title"><span class="icon">...</span> TITLE</div>
    <span class="kp-chevron">▼</span>
  </div>
  <div class="kp-card-body">...</div>
</div>
```

| ID | Content |
|----|---------|
| `secLog` | Activity log (left column, default open) |
| `secPredHistory` | Prediction history table (left, collapsed) |
| `secConfig` | Formula + watch + base amount config (right, open) |
| `secLevels` | Martingale levels editor (right, open) |
| `secBetHistory` | Bot bet history table (right, collapsed) |
| `secBetRecord` | GOA bet record (right, collapsed) |

### Button CSS Classes
```
kp-btn-main        → primary action (login, unlock)
kp-btn-eng         → engine start/stop
kp-sec-btn         → secondary/utility action
kp-sec-btn btn-danger → destructive action (red tint)
kp-pg-btn          → table pagination prev/next
```

### `renderState(s)` — Main UI Render Function
Called on every `state` socket event. Updates:
- Balance, engine pill status, prediction display, countdown
- Mini stats (bets, W/L, P&L, level, high, session time)
- Bet history table (paginated, 10 rows/page)
- Pred history table
- Config inputs (base amount, max level, formula name, watch toggle)
- Martingale levels display

### Account Tabs (`#abAcctTabs`)
Rendered from `accountList` socket event.  
Each tab shows: last 4 digits of phone, engine status pill, balance, P&L.  
Click → `switchToAccount(phone)` → `socket.emit('switchView', { phone })`

### `reAuthAll()`
Called on socket connect/reconnect. Re-emits `auth` for every saved account.

---

## 7. Draw Record Format

Records from `GetHistoryIssuePage` (auth) and public draw API:

```json
{
  "issueNumber": "20250115143000001",   // YYYYMMDDHHMMSS + 3-digit seq
  "number": 7,                           // 0-9 (>= 5 = BIG, < 5 = SMALL)
  "color": "green",                      // 'red' | 'green' | 'red,violet' | 'green,violet'
  "premium": "...",
  "sum": "...",
  "blockId": "...",
  "blockNumber": "...",
  "blockTimestamp": "..."
}
```

**No explicit timestamp field.** Parse time from `issueNumber`:
```js
const s = issueNumber;
// year=s.slice(0,4), month=s.slice(4,6), day=s.slice(6,8)
// hour=s.slice(8,10), min=s.slice(10,12), sec=s.slice(12,14)
// seq = s.slice(14)  // 3-digit sequence number
```

**Color logic:**
- `0` → `'red,violet'`
- `5` → `'green,violet'`
- `1,3,7,9` → `'green'`
- `2,4,6,8` → `'red'`

---

## 8. Known Constraints & Gotchas

| Constraint | Detail |
|---|---|
| Token in memory only | `lotteryToken` lost on server restart; users must re-login via browser |
| `relogin()` usually fails | GoaGames captcha slider verification rejects fake `track` arrays |
| `GetRecordPage` vs `GetHistoryIssuePage` | Former = user's own bets (empty if no bets). Latter = all game results. **Don't confuse them.** |
| API record cap | `GetHistoryIssuePage` max: `totalCount=500`, `totalPage=50`, 10 per page ≈ 4hrs history |
| Public vs Auth draw API | Public (`GOA_DRAW`) ≠ Auth (`GOA_API`) — both exist, serve same data but different hosts |
| No timestamp in records | Parse time from `issueNumber` string (format: `YYYYMMDDHHMMSS###`) |
| Shared histBuf | Public draw history is shared across all engines; DNA3 uses per-account deep buffer |
| Socket rooms are phone-scoped | `io.to(phone).emit(...)` targets only that account's connected browsers |
| `sessionStorage` not `localStorage` | Tokens cleared on browser tab close (intentional security choice) |
| `Connection: close` | GoaGames sends this; HTTPS agent MUST have `keepAlive: false` |
| `betMultiple` validation | Server validates `betMultiple >= 1` before forwarding bet to upstream |

---

## 9. Code Style Guide

### General
- **File header:** `/* ═══ ... ═══ */` banner comment at top of every file
- **Section separators:** `/* ═══ Section Name ═══ */` for major blocks
- **Inline separators:** `/* ── Minor section ── */`
- **No TypeScript** — pure ES6+ JavaScript
- **No external HTTP libraries** — uses Node.js `https` module directly
- **No frontend framework** — vanilla JS, no bundler

### Naming
- Constants: `UPPER_CASE` or `KP.CONSTANT_NAME`
- Classes: `PascalCase` (Account, AccountEngine)
- Functions: `camelCase`
- Private methods/fields: `_camelCase` (prefix underscore)
- DOM IDs: `abCamelCase` (ab prefix for autobet) or `secCamelCase` (for sections)
- Socket events: `camelCase` strings (`'betRecord'`, `'switchView'`)

### Error Handling Pattern
```js
try {
  const result = await api.someCall(acct);
  if (result && result.code === 0 && result.data) {
    // success path
  } else if (result.code === 4 || result.code === 401) {
    // auth failure — try relogin
  }
} catch (err) {
  const diag = err._proxy || {};
  console.error(`[MODULE] NETWORK FAIL | ${diag.code || err.code || '?'} ${err.message} (${diag.ms}ms)`);
  return { code: -1, msg: err.message };
}
```

### Log Prefixes
- `[ENGINE:phone]` — engine logs (per account)
- `[API]` — api.js calls
- `[PROXY]` — proxy.js HTTP calls
- `[STATE]` — state.js account operations
- `[DB]` — MongoDB operations
- `[ADMIN]` — admin.js
- `[RELOGIN]` — relogin attempts
- `[KP]` — frontend console logs

### Socket Broadcast Pattern
```js
// Engine broadcasts are always room-scoped (phone = room name)
this.broadcast('event', data);    // emits to socket room = this.acct.phone
this.broadcast();                 // emits 'state' event with full snapshot
```

### MongoDB Pattern (fire-and-forget)
```js
Collection.findOneAndUpdate(
  { phone: this.phone, key: value },
  { phone: this.phone, ...entry },
  { upsert: true, new: true }
).catch(e => console.error(`[DB] error: ${e.message}`));
```

---

## 10. Environment Variables

```bash
PORT=3000
GOA_API=https://api.ar-lottery01.com    # Override lottery API host
ENC_SECRET=your-secret-key              # AES encryption key for stored passwords
ADMIN_PASSWORD_HASH=$2b$10$...          # bcrypt hash of admin panel password
```

---

## 11. Data Files

| File | Purpose |
|------|---------|
| `data/freq-map.json` | `{"0":3,"1":7,...}` — digit→frequency mapping (admin-managed) |
| `data/ab-passwords.json` | Array of access passwords for root gate |

---

## 12. Python Monitor Scripts (`data/` folder)

Separate standalone scripts (not part of the Node.js server):

| File | Purpose |
|------|---------|
| `advance_monitor.py` | 9-algorithm weighted vote terminal monitor for WinGo |
| `kingpin1m_monitor.py` | ultraPatternEngine for WinGo_1M |
| `umbinv_monitor.py` | OVERTHINKER AI 42-pattern monitor for WinGo_30S |
| `newpreds_monitor.py` | 4-engine majority vote with per-engine MLvl/MaxLvl columns |

These scripts are **read-only observers** — they call the public draw API and print predictions to terminal. They do **not** interact with the Node.js server.

---

*Document generated from full source analysis. Last updated: 2025.*
