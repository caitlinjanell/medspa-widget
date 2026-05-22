const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Add a PostgreSQL database in Railway.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway internal network doesn't use SSL; external proxies do
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('railway.internal')
    ? { rejectUnauthorized: false }
    : false,
});

// Prevent unhandled error events from crashing the process
pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS providers (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS widgets (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT 'Primary Widget',
    config TEXT NOT NULL DEFAULT '{}',
    routing_type TEXT DEFAULT 'none',
    routing_config TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    widget_code TEXT NOT NULL,
    fname TEXT, lname TEXT, email TEXT, phone TEXT,
    areas TEXT, concerns TEXT, history TEXT, budget TEXT,
    analysis TEXT, modalities TEXT, package TEXT,
    has_photos INTEGER DEFAULT 0, skin_quality TEXT,
    captured_at TEXT NOT NULL
  )`);
}

async function migrate() {
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS photos TEXT DEFAULT '{}'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS testimonials (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    clinic_name TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_role TEXT,
    content TEXT NOT NULL,
    approved INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
}

init()
  .then(() => migrate())
  .catch(err => console.error('DB init error:', err.message));

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
    poweredBy: 'Hey, Maeve!',
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
    photos: JSON.parse(l.photos || '{}'),
    hasPhotos: !!l.has_photos,
    skinQuality: l.skin_quality,
    capturedAt: l.captured_at,
  };
}

module.exports = {
  async createProvider(email, passwordHash, clinicName) {
    const id = newId();
    const now = new Date().toISOString();
    const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      'INSERT INTO providers (id, email, password_hash, clinic_name, plan, subscription_status, trial_ends_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, email.toLowerCase().trim(), passwordHash, clinicName, 'trial', 'trialing', trialEnd, now]
    );
    const wid = newId();
    const code = newId();
    await pool.query(
      'INSERT INTO widgets (id, provider_id, code, name, config, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [wid, id, code, 'Primary Widget', JSON.stringify(defaultConfig(clinicName)), now]
    );
    return { id, email, clinicName };
  },

  async getProviderByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM providers WHERE email = $1', [email.toLowerCase().trim()]);
    return rows[0] || null;
  },

  async getProviderById(id) {
    const { rows } = await pool.query(
      'SELECT id, email, clinic_name, plan, stripe_customer_id, stripe_subscription_id, subscription_status, trial_ends_at, created_at FROM providers WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async getProviderByStripeCustomer(customerId) {
    const { rows } = await pool.query('SELECT * FROM providers WHERE stripe_customer_id = $1', [customerId]);
    return rows[0] || null;
  },

  async updateProviderBilling(id, { stripeCustomerId, stripeSubscriptionId, subscriptionStatus, plan }) {
    const fields = []; const vals = [];
    let i = 1;
    if (stripeCustomerId      !== undefined) { fields.push(`stripe_customer_id = $${i++}`);     vals.push(stripeCustomerId); }
    if (stripeSubscriptionId  !== undefined) { fields.push(`stripe_subscription_id = $${i++}`); vals.push(stripeSubscriptionId); }
    if (subscriptionStatus    !== undefined) { fields.push(`subscription_status = $${i++}`);    vals.push(subscriptionStatus); }
    if (plan                  !== undefined) { fields.push(`plan = $${i++}`);                   vals.push(plan); }
    if (!fields.length) return;
    vals.push(id);
    await pool.query(`UPDATE providers SET ${fields.join(', ')} WHERE id = $${i}`, vals);
  },

  async getWidgetsByProvider(providerId) {
    const { rows } = await pool.query('SELECT * FROM widgets WHERE provider_id = $1 ORDER BY created_at ASC', [providerId]);
    return rows.map(parseWidget);
  },

  async getWidgetByCode(code) {
    const { rows } = await pool.query('SELECT * FROM widgets WHERE code = $1', [code]);
    return parseWidget(rows[0] || null);
  },

  async getWidgetById(id) {
    const { rows } = await pool.query('SELECT * FROM widgets WHERE id = $1', [id]);
    return parseWidget(rows[0] || null);
  },

  async createWidget(providerId, clinicName, name) {
    const id = newId();
    const code = newId();
    const now = new Date().toISOString();
    await pool.query(
      'INSERT INTO widgets (id, provider_id, code, name, config, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, providerId, code, name || 'New Widget', JSON.stringify(defaultConfig(clinicName)), now]
    );
    const { rows } = await pool.query('SELECT * FROM widgets WHERE id = $1', [id]);
    return parseWidget(rows[0]);
  },

  async updateWidget(id, providerId, updates) {
    const fields = []; const vals = [];
    let i = 1;
    if (updates.name !== undefined)          { fields.push(`name = $${i++}`);           vals.push(updates.name); }
    if (updates.config !== undefined)        { fields.push(`config = $${i++}`);          vals.push(JSON.stringify(updates.config)); }
    if (updates.routingType !== undefined)   { fields.push(`routing_type = $${i++}`);    vals.push(updates.routingType); }
    if (updates.routingConfig !== undefined) { fields.push(`routing_config = $${i++}`);  vals.push(JSON.stringify(updates.routingConfig)); }
    if (!fields.length) return this.getWidgetById(id);
    vals.push(id, providerId);
    await pool.query(`UPDATE widgets SET ${fields.join(', ')} WHERE id = $${i} AND provider_id = $${i + 1}`, vals);
    return this.getWidgetById(id);
  },

  async deleteWidget(id, providerId) {
    await pool.query('DELETE FROM widgets WHERE id = $1 AND provider_id = $2', [id, providerId]);
  },

  async saveLead(lead) {
    const id = newId();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO leads (id,provider_id,widget_code,fname,lname,email,phone,areas,concerns,history,budget,analysis,modalities,package,has_photos,skin_quality,photos,captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, lead.providerId, lead.widgetCode,
       lead.fname||'', lead.lname||'', lead.email||'', lead.phone||'',
       JSON.stringify(lead.areas||[]), JSON.stringify(lead.concerns||[]),
       lead.history||'', lead.budget||'', lead.analysis||'',
       JSON.stringify(lead.modalities||[]), lead.package||'',
       lead.hasPhotos ? 1 : 0, lead.skinQuality||'',
       JSON.stringify(lead.photos||{}), now]
    );
    const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
    return parseLead(rows[0]);
  },

  async getLeadsByProvider(providerId) {
    const { rows } = await pool.query('SELECT * FROM leads WHERE provider_id = $1 ORDER BY captured_at DESC', [providerId]);
    return rows.map(parseLead);
  },

  async submitTestimonial(providerId, { clinicName, authorName, authorRole, content }) {
    const id = newId();
    const now = new Date().toISOString();
    await pool.query(
      'INSERT INTO testimonials (id, provider_id, clinic_name, author_name, author_role, content, approved, created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7)',
      [id, providerId, clinicName, authorName, authorRole || '', content, now]
    );
    const { rows } = await pool.query('SELECT * FROM testimonials WHERE id = $1', [id]);
    return rows[0];
  },

  async getApprovedTestimonials() {
    const { rows } = await pool.query('SELECT * FROM testimonials WHERE approved = 1 ORDER BY created_at DESC');
    return rows;
  },

  async getAllTestimonials() {
    const { rows } = await pool.query('SELECT t.*, p.email as provider_email FROM testimonials t JOIN providers p ON t.provider_id = p.id ORDER BY t.created_at DESC');
    return rows;
  },

  async approveTestimonial(id) {
    await pool.query('UPDATE testimonials SET approved = 1 WHERE id = $1', [id]);
  },

  async deleteTestimonial(id) {
    await pool.query('DELETE FROM testimonials WHERE id = $1', [id]);
  },

  async getProviderTestimonial(providerId) {
    const { rows } = await pool.query('SELECT * FROM testimonials WHERE provider_id = $1 ORDER BY created_at DESC LIMIT 1', [providerId]);
    return rows[0] || null;
  },

  async getAllProviders() {
    const { rows } = await pool.query(`
      SELECT p.id, p.email, p.clinic_name, p.plan, p.subscription_status, p.trial_ends_at, p.created_at,
             COUNT(l.id) AS lead_count
      FROM providers p
      LEFT JOIN leads l ON l.provider_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    return rows;
  },

  async getAllLeads() {
    const { rows } = await pool.query('SELECT l.*, p.clinic_name FROM leads l JOIN providers p ON l.provider_id = p.id ORDER BY l.captured_at DESC');
    return rows.map(parseLead);
  },

  async getLeadsByWidget(widgetCode) {
    const { rows } = await pool.query('SELECT * FROM leads WHERE widget_code = $1 ORDER BY captured_at DESC', [widgetCode]);
    return rows.map(parseLead);
  },
};
