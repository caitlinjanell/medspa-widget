const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'medspa.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrate existing tables to add new columns safely
const migrate = (sql) => { try { db.exec(sql); } catch {} };
migrate('ALTER TABLE providers ADD COLUMN stripe_customer_id TEXT');
migrate('ALTER TABLE providers ADD COLUMN stripe_subscription_id TEXT');
migrate('ALTER TABLE providers ADD COLUMN subscription_status TEXT DEFAULT "trialing"');
migrate('ALTER TABLE providers ADD COLUMN trial_ends_at TEXT');

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    clinic_name TEXT NOT NULL,
    plan TEXT DEFAULT 'trial',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'trialing',
    trial_ends_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS widgets (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT 'Primary Widget',
    config TEXT NOT NULL DEFAULT '{}',
    routing_type TEXT DEFAULT 'none',
    routing_config TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    widget_code TEXT NOT NULL,
    fname TEXT, lname TEXT, email TEXT, phone TEXT,
    areas TEXT, concerns TEXT, history TEXT, budget TEXT,
    analysis TEXT, modalities TEXT, package TEXT,
    has_photos INTEGER DEFAULT 0, skin_quality TEXT,
    captured_at TEXT NOT NULL
  );
`);

function newId() { return crypto.randomUUID(); }

function defaultConfig(clinicName) {
  return {
    clinicName,
    logoUrl: '',
    accent: '#b49dd4',
    accentLight: '#EEEDFE',
    accentDark: '#3C3489',
    accentMid: '#7c5ca8',
    bookingUrl: '',
    poweredBy: 'Aesthetic Intelligence™',
    areas: ['Forehead', "Crow's feet", 'Lips', 'Cheeks', 'Jawline', 'Skin texture'],
    concerns: ['Fine lines / wrinkles', 'Volume loss', 'Asymmetry', 'Dullness / sun damage', 'Sagging skin'],
    history: ['New to aesthetics', 'Had toxins before', 'Had dermal fillers', 'Had lasers / peels'],
    budget: ['Under $500', '$500 – $1,200', '$1,200 – $2,500', 'Premium / full restoration'],
    treatments: [],
  };
}

function parseWidget(w) {
  if (!w) return null;
  return { ...w, config: JSON.parse(w.config || '{}'), routingConfig: JSON.parse(w.routing_config || '{}') };
}

function parseLead(l) {
  if (!l) return null;
  return {
    ...l,
    areas: JSON.parse(l.areas || '[]'),
    concerns: JSON.parse(l.concerns || '[]'),
    modalities: JSON.parse(l.modalities || '[]'),
    hasPhotos: !!l.has_photos,
    skinQuality: l.skin_quality,
    capturedAt: l.captured_at,
  };
}

module.exports = {
  // ── Providers ──
  createProvider(email, passwordHash, clinicName) {
    const id = newId();
    const now = new Date().toISOString();
    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO providers (id, email, password_hash, clinic_name, plan, subscription_status, trial_ends_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, email.toLowerCase().trim(), passwordHash, clinicName, 'trial', 'trialing', trialEnd, now);
    // auto-create first widget
    const wid = newId();
    const code = newId();
    db.prepare('INSERT INTO widgets (id, provider_id, code, name, config, created_at) VALUES (?,?,?,?,?,?)')
      .run(wid, id, code, 'Primary Widget', JSON.stringify(defaultConfig(clinicName)), now);
    return { id, email, clinicName };
  },

  getProviderByEmail(email) {
    return db.prepare('SELECT * FROM providers WHERE email = ?').get(email.toLowerCase().trim());
  },

  getProviderById(id) {
    return db.prepare('SELECT id, email, clinic_name, plan, stripe_customer_id, stripe_subscription_id, subscription_status, trial_ends_at, created_at FROM providers WHERE id = ?').get(id);
  },

  getProviderByStripeCustomer(customerId) {
    return db.prepare('SELECT * FROM providers WHERE stripe_customer_id = ?').get(customerId);
  },

  updateProviderBilling(id, { stripeCustomerId, stripeSubscriptionId, subscriptionStatus, plan }) {
    const fields = []; const vals = [];
    if (stripeCustomerId      !== undefined) { fields.push('stripe_customer_id = ?');      vals.push(stripeCustomerId); }
    if (stripeSubscriptionId  !== undefined) { fields.push('stripe_subscription_id = ?');  vals.push(stripeSubscriptionId); }
    if (subscriptionStatus    !== undefined) { fields.push('subscription_status = ?');      vals.push(subscriptionStatus); }
    if (plan                  !== undefined) { fields.push('plan = ?');                     vals.push(plan); }
    if (!fields.length) return;
    vals.push(id);
    db.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  },

  // ── Widgets ──
  getWidgetsByProvider(providerId) {
    return db.prepare('SELECT * FROM widgets WHERE provider_id = ? ORDER BY created_at ASC').all(providerId).map(parseWidget);
  },

  getWidgetByCode(code) {
    return parseWidget(db.prepare('SELECT * FROM widgets WHERE code = ?').get(code));
  },

  getWidgetById(id) {
    return parseWidget(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id));
  },

  createWidget(providerId, clinicName, name) {
    const id = newId();
    const code = newId();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO widgets (id, provider_id, code, name, config, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, providerId, code, name || 'New Widget', JSON.stringify(defaultConfig(clinicName)), now);
    return parseWidget(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id));
  },

  updateWidget(id, providerId, updates) {
    const fields = [];
    const vals = [];
    if (updates.name !== undefined)          { fields.push('name = ?');           vals.push(updates.name); }
    if (updates.config !== undefined)        { fields.push('config = ?');          vals.push(JSON.stringify(updates.config)); }
    if (updates.routingType !== undefined)   { fields.push('routing_type = ?');    vals.push(updates.routingType); }
    if (updates.routingConfig !== undefined) { fields.push('routing_config = ?');  vals.push(JSON.stringify(updates.routingConfig)); }
    if (!fields.length) return this.getWidgetById(id);
    vals.push(id, providerId);
    db.prepare(`UPDATE widgets SET ${fields.join(', ')} WHERE id = ? AND provider_id = ?`).run(...vals);
    return this.getWidgetById(id);
  },

  deleteWidget(id, providerId) {
    db.prepare('DELETE FROM widgets WHERE id = ? AND provider_id = ?').run(id, providerId);
  },

  // ── Leads ──
  saveLead(lead) {
    const id = newId();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO leads
      (id,provider_id,widget_code,fname,lname,email,phone,areas,concerns,history,budget,analysis,modalities,package,has_photos,skin_quality,captured_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, lead.providerId, lead.widgetCode,
        lead.fname||'', lead.lname||'', lead.email||'', lead.phone||'',
        JSON.stringify(lead.areas||[]), JSON.stringify(lead.concerns||[]),
        lead.history||'', lead.budget||'', lead.analysis||'',
        JSON.stringify(lead.modalities||[]), lead.package||'',
        lead.hasPhotos ? 1 : 0, lead.skinQuality||'', now);
    return parseLead(db.prepare('SELECT * FROM leads WHERE id = ?').get(id));
  },

  getLeadsByProvider(providerId) {
    return db.prepare('SELECT * FROM leads WHERE provider_id = ? ORDER BY captured_at DESC').all(providerId).map(parseLead);
  },

  getLeadsByWidget(widgetCode) {
    return db.prepare('SELECT * FROM leads WHERE widget_code = ? ORDER BY captured_at DESC').all(widgetCode).map(parseLead);
  },
};
