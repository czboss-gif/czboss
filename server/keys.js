/* ═══════════════════════════════════════════════════════════
   KINGPIN 3.0 — Key Management Routes
   Public: validate key + phone binding, bind after login
   Admin: CRUD for keys, session logs
   ═══════════════════════════════════════════════════════════ */

const crypto    = require('crypto');
const AccessKey = require('./models/AccessKey');
const KeySession = require('./models/KeySession');
const UserConfig = require('./models/UserConfig');

const DEFAULT_KEY = (process.env.DEFAULT_KEY || '').trim().toUpperCase();

/* ── Key generator: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX ── */
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateKey() {
  const groups = [];
  for (let g = 0; g < 5; g++) {
    let part = '';
    for (let i = 0; i < 5; i++) {
      part += CHARS[Math.floor(Math.random() * CHARS.length)];
    }
    groups.push(part);
  }
  return groups.join('-');
}

function normaliseKey(k) {
  return (k || '').trim().toUpperCase();
}

/* ── Ensure default key exists in DB on startup ── */
async function seedDefaultKey() {
  if (!DEFAULT_KEY) {
    console.warn('[KEYS] DEFAULT_KEY not set in .env — default key disabled');
    return;
  }
  try {
    await AccessKey.findOneAndUpdate(
      { key: DEFAULT_KEY },
      { key: DEFAULT_KEY, label: 'Default (Super User)', enabled: true, isDefault: true },
      { upsert: true, new: true }
    );
    console.log(`[KEYS] Default key seeded: ${DEFAULT_KEY.slice(0, 5)}…`);
  } catch (e) {
    console.error('[KEYS] seedDefaultKey error:', e.message);
  }
}

/* ─────────────────────────────────────────────────────────
   Mount all key routes
   ───────────────────────────────────────────────────────── */
function mount(app, requireAdmin, onRevoke) {
  /* onRevoke(phone) — optional callback fired when a key is disabled or deleted,
     so the caller can immediately STOP the bound account's running engine
     (revocation takes effect live, not just at the next bet-start). */
  const revoke = (phone) => { try { if (phone && typeof onRevoke === 'function') onRevoke(phone); } catch (e) { console.error('[KEYS] onRevoke error:', e.message); } };

  /* ══════════════════════════════════════════
     PUBLIC — called from browser (no admin)
     ══════════════════════════════════════════ */

  /* POST /api/keys/check
     Body: { key }
     Called by the root gate — only checks key exists and is enabled.
     No phone needed here; phone binding is checked later at captcha step. */
  app.post('/api/keys/check', async (req, res) => {
    const key = normaliseKey(req.body?.key);
    if (!key) return res.json({ ok: false, msg: 'Key is required' });
    try {
      const record = await AccessKey.findOne({ key });
      if (!record)         return res.json({ ok: false, msg: 'Invalid key' });
      if (!record.enabled) return res.json({ ok: false, msg: 'Key is disabled' });
      return res.json({ ok: true, isDefault: record.isDefault, boundPhone: record.boundPhone || null });
    } catch (e) {
      console.error('[KEYS] check error:', e.message);
      return res.status(500).json({ ok: false, msg: 'Server error' });
    }
  });

  /* POST /api/keys/validate
     Body: { key, phone }
     Called BEFORE GOA captcha/login to check:
       - key exists
       - key is enabled
       - phone binding: if bound → must match; if not bound → allow
       - default key → always allow any phone
     Returns: { ok, isDefault, sessionId? }                    */
  app.post('/api/keys/validate', async (req, res) => {
    const key   = normaliseKey(req.body?.key);
    const phone = (req.body?.phone || '').trim();

    if (!key)   return res.json({ ok: false, msg: 'Key is required' });
    if (!phone) return res.json({ ok: false, msg: 'Phone is required' });

    try {
      const record = await AccessKey.findOne({ key });
      if (!record)         return res.json({ ok: false, msg: 'Invalid key' });
      if (!record.enabled) return res.json({ ok: false, msg: 'Key is disabled' });

      /* Default key: super user, skip phone binding */
      if (record.isDefault) {
        return res.json({ ok: true, isDefault: true });
      }

      /* Non-default: check phone binding */
      if (record.boundPhone && record.boundPhone !== phone) {
        return res.json({ ok: false, msg: 'This key is registered to a different number' });
      }

      return res.json({ ok: true, isDefault: false, bound: !!record.boundPhone });
    } catch (e) {
      console.error('[KEYS] validate error:', e.message);
      return res.status(500).json({ ok: false, msg: 'Server error' });
    }
  });

  /* POST /api/keys/login-check — hard server gate, verbose debug */
  app.post('/api/keys/login-check', async (req, res) => {
    const key   = normaliseKey(req.body?.key);
    const phone = (req.body?.phone || '').trim().replace(/[^0-9]/g, '');

    console.log(`[LOGIN-CHECK] key=${key} phone=${phone}`);

    if (!key || !phone) {
      console.log(`[LOGIN-CHECK] REJECTED — missing key or phone`);
      return res.status(400).json({ ok: false, msg: 'key and phone required' });
    }

    try {
      const record = await AccessKey.findOne({ key });
      console.log(`[LOGIN-CHECK] DB record=`, record ? { key: record.key, boundPhone: record.boundPhone, enabled: record.enabled, isDefault: record.isDefault } : 'NOT FOUND');

      if (!record) return res.status(403).json({ ok: false, msg: 'Invalid key' });
      if (!record.enabled) return res.status(403).json({ ok: false, msg: 'Key is disabled' });

      if (record.isDefault) {
        console.log(`[LOGIN-CHECK] ALLOWED — default key`);
        return res.json({ ok: true });
      }

      if (record.boundPhone) {
        const stored    = record.boundPhone.replace(/[^0-9]/g, '');
        const attempted = phone.replace(/[^0-9]/g, '');
        console.log(`[LOGIN-CHECK] bound=${stored} attempted=${attempted} match=${stored === attempted}`);
        if (stored !== attempted) {
          console.warn(`[LOGIN-CHECK] BLOCKED — phone mismatch`);
          return res.status(403).json({ ok: false, msg: 'This key is registered to a different number' });
        }
      } else {
        console.log(`[LOGIN-CHECK] ALLOWED — key not yet bound, first login`);
      }

      console.log(`[LOGIN-CHECK] ALLOWED`);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[KEYS] login-check error:', e.message);
      return res.status(500).json({ ok: false, msg: 'Server error' });
    }
  });

  /* POST /api/keys/bind
     Body: { key, phone, balance, sessionId }
     Called AFTER successful GOA login.
       - If not default and phone not yet bound → save binding
       - Creates a new KeySession row
     Returns: { ok, sessionId }                                 */
  app.post('/api/keys/bind', async (req, res) => {
    const key       = normaliseKey(req.body?.key);
    const phone     = (req.body?.phone || '').trim();
    const balance   = parseFloat(req.body?.balance) || 0;
    const sessionId = req.body?.sessionId || crypto.randomUUID();

    if (!key || !phone) return res.json({ ok: false, msg: 'key and phone required' });

    try {
      const record = await AccessKey.findOne({ key });
      if (!record || !record.enabled) return res.json({ ok: false, msg: 'Invalid or disabled key' });

      /* Bind phone on first login (non-default keys only) */
      if (!record.isDefault && !record.boundPhone) {
        record.boundPhone = phone;
        await record.save();
        console.log(`[KEYS] Bound key ${key.slice(0,5)}… to phone ${phone}`);
      }

      /* Create session row */
      await KeySession.create({ sessionId, key, phone, balanceAtLogin: balance });
      console.log(`[KEYS] Session created: ${sessionId} key=${key.slice(0,5)}… phone=${phone}`);

      return res.json({ ok: true, sessionId });
    } catch (e) {
      console.error('[KEYS] bind error:', e.message);
      return res.status(500).json({ ok: false, msg: 'Server error' });
    }
  });

  /* POST /api/keys/session/balance
     Body: { sessionId, balance }
     Called from client on first 'state' event after login.
     Only updates if balanceAtLogin is still 0 (one-time set). */
  app.post('/api/keys/session/balance', async (req, res) => {
    const { sessionId } = req.body || {};
    const balance = parseFloat(req.body?.balance) || 0;
    if (!sessionId) return res.json({ ok: false });
    try {
      await KeySession.findOneAndUpdate(
        { sessionId, balanceAtLogin: 0 },
        { balanceAtLogin: balance }
      );
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false });
    }
  });

  /* POST /api/keys/session/start
     Body: { sessionId }
     Called when user clicks START button                       */
  app.post('/api/keys/session/start', async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.json({ ok: false });
    try {
      await KeySession.findOneAndUpdate(
        { sessionId },
        { betStartTime: new Date() }
      );
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false });
    }
  });

  /* POST /api/keys/session/stop
     Body: { sessionId, profit }
     Called when user clicks STOP or engine auto-stops         */
  app.post('/api/keys/session/stop', async (req, res) => {
    const { sessionId } = req.body || {};
    const profit = parseFloat(req.body?.profit) || 0;
    if (!sessionId) return res.json({ ok: false });
    try {
      await KeySession.findOneAndUpdate(
        { sessionId },
        { betStopTime: new Date(), profit }
      );
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false });
    }
  });

  /* ══════════════════════════════════════════
     ADMIN — protected by requireAdmin middleware
     ══════════════════════════════════════════ */

  /* GET /admin/keys — list all keys with aggregated stats */
  app.get('/admin/keys', requireAdmin, async (req, res) => {
    try {
      const keys = await AccessKey.find().sort({ createdAt: -1 }).lean();

      /* Aggregate session stats per key */
      const stats = await KeySession.aggregate([
        {
          $group: {
            _id:          '$key',
            sessions:     { $sum: 1 },
            totalProfit:  { $sum: '$profit' },
            lastSeen:     { $max: '$createdAt' },
          }
        }
      ]);
      const statsMap = {};
      stats.forEach(s => { statsMap[s._id] = s; });

      /* Plain-text password per bound phone (for the admin copy button). */
      const cfgs = await UserConfig.find({}, { phone: 1, pwdPlain: 1, _id: 0 }).lean();
      const pwdMap = {};
      cfgs.forEach(c => { if (c.phone) pwdMap[c.phone] = c.pwdPlain || ''; });

      const result = keys.map(k => ({
        _id:         k._id,
        key:         k.key,
        label:       k.label,
        enabled:     k.enabled,
        boundPhone:  k.boundPhone,
        isDefault:   k.isDefault,
        createdAt:   k.createdAt,
        pwd:         k.boundPhone ? (pwdMap[k.boundPhone] || '') : '',
        sessions:    statsMap[k.key]?.sessions    || 0,
        totalProfit: statsMap[k.key]?.totalProfit || 0,
        lastSeen:    statsMap[k.key]?.lastSeen    || null,
      }));

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* POST /admin/keys/generate — auto-generate a new key */
  app.post('/admin/keys/generate', requireAdmin, async (req, res) => {
    const label = (req.body?.label || 'User').trim();
    let key, attempts = 0;

    /* Generate until unique */
    while (attempts < 10) {
      const candidate = generateKey();
      const exists = await AccessKey.findOne({ key: candidate });
      if (!exists) { key = candidate; break; }
      attempts++;
    }

    if (!key) return res.status(500).json({ error: 'Could not generate unique key' });

    try {
      const doc = await AccessKey.create({ key, label, enabled: true, isDefault: false });
      console.log(`[KEYS] Generated new key: ${key.slice(0, 5)}… label="${label}"`);
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* PUT /admin/keys/:id/toggle — enable / disable */
  app.put('/admin/keys/:id/toggle', requireAdmin, async (req, res) => {
    try {
      const doc = await AccessKey.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Key not found' });
      if (doc.isDefault) return res.status(403).json({ error: 'Default key cannot be toggled' });
      doc.enabled = !doc.enabled;
      await doc.save();
      /* Disabling a key → stop its bound account's engine right away. */
      if (!doc.enabled && doc.boundPhone) revoke(doc.boundPhone);
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* DELETE /admin/keys/:id */
  app.delete('/admin/keys/:id', requireAdmin, async (req, res) => {
    try {
      const doc = await AccessKey.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Key not found' });
      if (doc.isDefault) return res.status(403).json({ error: 'Default key cannot be deleted' });
      const revokedPhone = doc.boundPhone;
      await AccessKey.deleteOne({ _id: req.params.id });
      /* Deleting a key → stop its bound account's engine right away. */
      if (revokedPhone) revoke(revokedPhone);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* GET /admin/keys/:id/sessions — session history for one key */
  app.get('/admin/keys/:id/sessions', requireAdmin, async (req, res) => {
    try {
      const doc = await AccessKey.findById(req.params.id).lean();
      if (!doc) return res.status(404).json({ error: 'Key not found' });
      const sessions = await KeySession.find({ key: doc.key })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      res.json(sessions);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* GET /admin/sessions — all sessions across all keys */
  app.get('/admin/sessions', requireAdmin, async (req, res) => {
    try {
      const sessions = await KeySession.find()
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
      res.json(sessions);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[KEYS] Key management routes mounted');
}

module.exports = { mount, seedDefaultKey };
