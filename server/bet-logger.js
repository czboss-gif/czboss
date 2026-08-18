/* ═══════════════════════════════════════════
   KINGPIN 3.0 — Bet Logger (stub)
   File-based logging for bet requests/responses.
   Will be expanded later.
   ═══════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function ts() { return new Date().toISOString(); }

function append(file, line) {
  try { fs.appendFileSync(path.join(LOG_DIR, file), line + '\n'); } catch {}
}

function betRequest(body, token) {
  const issue = body.issueNumber || '?';
  const amt   = body.betMultiple || '?';
  const side  = body.betContent  || '?';
  append('bets.log', `${ts()} BET-REQ | issue=${issue} amt=${amt} side=${side}`);
}

function betResponse(issue, result, ms) {
  const code = result?.code ?? '?';
  const msg  = result?.msg  || '';
  append('bets.log', `${ts()} BET-RES | issue=${issue} code=${code} msg=${msg} ${ms}ms`);
}

function balanceRequest(token) {
  append('balance.log', `${ts()} BAL-REQ`);
}

function balanceResponse(result, ms) {
  const bal = result?.data?.totalMoney || result?.data?.balance || '?';
  append('balance.log', `${ts()} BAL-RES | balance=${bal} ${ms}ms`);
}

module.exports = { betRequest, betResponse, balanceRequest, balanceResponse };
