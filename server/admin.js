/* ═══════════════════════════════════════════════════════════
   KINGPIN 3.0 — Admin Routes
   Session-based admin auth + freq-map CRUD
   (AB passwords replaced by key-based access — see keys.js)
   ═══════════════════════════════════════════════════════════ */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const FREQ_MAP_PATH = path.join(DATA_DIR, 'freq-map.json');

// Admin password hash loaded from .env (bcrypt, never plaintext)
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || '';
if (!ADMIN_HASH) console.warn('[ADMIN] ⚠️  ADMIN_PASSWORD_HASH not set in .env — admin login disabled');
else console.log('[ADMIN] Password hash loaded (' + ADMIN_HASH.length + ' chars, starts: ' + ADMIN_HASH.slice(0,7) + '...)');

/* ═══ In-memory caches ═══ */
let _freqMapCache = null;

function loadFreqMap() {
  if (_freqMapCache) return _freqMapCache;
  try { _freqMapCache = JSON.parse(fs.readFileSync(FREQ_MAP_PATH, 'utf8')); }
  catch { _freqMapCache = {}; }
  return _freqMapCache;
}
function saveFreqMap(map) {
  _freqMapCache = map;
  fs.writeFileSync(FREQ_MAP_PATH, JSON.stringify(map, null, 2) + '\n');
}

/* ═══ Session store (simple in-memory) ═══ */
const sessions = {};

function createSession() {
  const id = crypto.randomBytes(24).toString('hex');
  sessions[id] = { created: Date.now() };
  return id;
}
function isValidSession(id) {
  if (!id || !sessions[id]) return false;
  // 24-hour expiry
  if (Date.now() - sessions[id].created > 86400000) { delete sessions[id]; return false; }
  return true;
}

/* ═══ Middleware ═══ */
function requireAdmin(req, res, next) {
  const sid = req.headers['x-admin-session'] || '';
  if (!isValidSession(sid)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ═══ Mount all admin routes ═══ */
function mount(app) {

  // ── Auth (bcrypt verified) ──
  app.post('/admin/login', async (req, res) => {
    try {
      const { password } = req.body || {};
      if (!password || !ADMIN_HASH) {
        return res.status(401).json({ error: 'Wrong password' });
      }
      const match = await bcrypt.compare(password, ADMIN_HASH);
      console.log('[ADMIN] Login attempt — match:', match);
      if (match) {
        const sid = createSession();
        res.json({ ok: true, session: sid });
      } else {
        res.status(401).json({ error: 'Wrong password' });
      }
    } catch (e) {
      console.error('[ADMIN] Login error:', e.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/admin/logout', (req, res) => {
    const sid = req.headers['x-admin-session'] || '';
    delete sessions[sid];
    res.json({ ok: true });
  });

  app.get('/admin/check', (req, res) => {
    const sid = req.headers['x-admin-session'] || '';
    res.json({ authenticated: isValidSession(sid) });
  });

  // ── Freq Map ──
  app.get('/admin/freqmap', requireAdmin, (req, res) => {
    res.json(loadFreqMap());
  });

  app.post('/admin/freqmap', requireAdmin, (req, res) => {
    const newMap = req.body;
    for (let i = 0; i <= 9; i++) {
      const val = parseInt(newMap[String(i)]);
      if (isNaN(val) || val < 0 || val > 9) {
        return res.status(400).json({ error: `Invalid value for key ${i}` });
      }
    }
    saveFreqMap(newMap);
    console.log('[ADMIN] Freq map updated');
    res.json({ ok: true, map: newMap });
  });

  console.log('[ADMIN] Admin routes mounted');
}

module.exports = { mount, requireAdmin, loadFreqMap };
