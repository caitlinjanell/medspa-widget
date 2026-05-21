require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('./db');

const app = express();
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ── Auth middleware ──
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.provider = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Email helper ──
async function sendEmail({ to, subject, html }) {
  if (!process.env.EMAIL_HOST) return; // silently skip if not configured
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  await transporter.sendMail({ from: process.env.EMAIL_FROM || process.env.EMAIL_USER, to, subject, html });
}

// ── Lead routing ──
async function routeLead(lead, widget) {
  const type = widget.routing_type;
  const config = typeof widget.routingConfig === 'object' ? widget.routingConfig : {};

  if (type === 'email' && config.email) {
    const areas = (lead.areas || []).join(', ');
    const mods = (lead.modalities || []).join(', ');
    await sendEmail({
      to: config.email,
      subject: `New consultation lead: ${lead.fname} ${lead.lname}`,
      html: `
        <h2 style="font-family:sans-serif;color:#3C3489">New Lead — ${widget.config?.clinicName || 'Your Clinic'}</h2>
        <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%;max-width:500px">
          <tr><td style="padding:6px 0;color:#888;width:140px">Name</td><td style="padding:6px 0;font-weight:600">${lead.fname} ${lead.lname}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Email</td><td style="padding:6px 0">${lead.email}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Phone</td><td style="padding:6px 0">${lead.phone || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Budget</td><td style="padding:6px 0">${lead.budget}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Areas</td><td style="padding:6px 0">${areas}</td></tr>
          <tr><td style="padding:6px 0;color:#888">AI Recommendations</td><td style="padding:6px 0">${mods}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Package</td><td style="padding:6px 0">${lead.package}</td></tr>
        </table>
        <p style="font-family:sans-serif;font-size:12px;color:#aaa;margin-top:24px">Sent by AestheticAI</p>`,
    });
  }

  if (type === 'sms' && config.phone) {
    // Twilio SMS
    if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN) {
      const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
      await twilio.messages.create({
        to: config.phone,
        from: process.env.TWILIO_FROM,
        body: `New lead: ${lead.fname} ${lead.lname} · ${lead.email} · Budget: ${lead.budget} · ${(lead.areas||[]).slice(0,2).join(', ')}`,
      });
    }
  }

  if (type === 'webhook' && config.url) {
    await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...lead, widgetName: widget.name, clinic: widget.config?.clinicName }),
    }).catch(() => {});
  }

  if (type === 'chatbot' && lead.email) {
    const mods = (lead.modalities || []).join(', ');
    await sendEmail({
      to: lead.email,
      subject: `Your personalized treatment plan from ${widget.config?.clinicName || 'us'}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#3C3489">Hi ${lead.fname},</h2>
          <p style="color:#555;line-height:1.6">Thank you for completing your pre-consultation. Here's a summary of your personalized treatment plan.</p>
          <div style="background:#EEEDFE;border-radius:12px;padding:16px 20px;margin:20px 0">
            <p style="color:#3C3489;font-size:13px;line-height:1.7">${lead.analysis}</p>
          </div>
          <p style="color:#555"><strong>Recommended treatments:</strong> ${mods}</p>
          <p style="color:#555"><strong>Investment package:</strong> ${lead.package}</p>
          <p style="color:#555;margin-top:24px">We look forward to seeing you in person. <a href="${widget.config?.bookingUrl || '#'}" style="color:#7c5ca8;font-weight:600">Book your consultation →</a></p>
          <p style="color:#aaa;font-size:12px;margin-top:32px">This is not medical advice. All recommendations are subject to in-person evaluation.</p>
        </div>`,
    });
  }
}

// ══════════════════════════════════════
//  Page routing
// ══════════════════════════════════════
app.get('/', (req, res) => {
  if (req.query.code) return res.sendFile(path.join(__dirname, '../public/index.html'));
  res.sendFile(path.join(__dirname, '../public/landing.html'));
});
app.get('/demo',      (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.get('/signup',    (req, res) => res.sendFile(path.join(__dirname, '../public/signup.html')));
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));

app.use(express.static(path.join(__dirname, '../public')));

// ══════════════════════════════════════
//  Auth routes
// ══════════════════════════════════════
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, clinicName } = req.body;
    if (!email || !password || !clinicName) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (db.getProviderByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });
    const hash = await bcrypt.hash(password, 12);
    const provider = db.createProvider(email, hash, clinicName);
    const token = jwt.sign({ id: provider.id, email: provider.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, provider: { id: provider.id, email: provider.email, clinicName: provider.clinicName } });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const provider = db.getProviderByEmail(email);
    if (!provider) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, provider.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: provider.id, email: provider.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, provider: { id: provider.id, email: provider.email, clinicName: provider.clinic_name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const provider = db.getProviderById(req.provider.id);
  if (!provider) return res.status(404).json({ error: 'Not found' });
  res.json({ id: provider.id, email: provider.email, clinicName: provider.clinic_name, plan: provider.plan });
});

// ══════════════════════════════════════
//  Provider — widgets
// ══════════════════════════════════════
app.get('/api/provider/widgets', requireAuth, (req, res) => {
  res.json(db.getWidgetsByProvider(req.provider.id));
});

app.post('/api/provider/widgets', requireAuth, (req, res) => {
  const provider = db.getProviderById(req.provider.id);
  const widget = db.createWidget(req.provider.id, provider.clinic_name, req.body.name);
  res.json(widget);
});

app.put('/api/provider/widgets/:id', requireAuth, (req, res) => {
  const { name, config, routingType, routingConfig } = req.body;
  const widget = db.updateWidget(req.params.id, req.provider.id, { name, config, routingType, routingConfig });
  if (!widget) return res.status(404).json({ error: 'Widget not found' });
  res.json(widget);
});

app.delete('/api/provider/widgets/:id', requireAuth, (req, res) => {
  db.deleteWidget(req.params.id, req.provider.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════
//  Provider — leads
// ══════════════════════════════════════
app.get('/api/provider/leads', requireAuth, (req, res) => {
  res.json(db.getLeadsByProvider(req.provider.id));
});

// ══════════════════════════════════════
//  Public — widget config (loaded by widget JS)
// ══════════════════════════════════════
app.get('/api/widget-config/:code', (req, res) => {
  const widget = db.getWidgetByCode(req.params.code);
  if (!widget) return res.status(404).json({ error: 'Widget not found' });
  res.json(widget.config); // only return public config, not routing secrets
});

// ══════════════════════════════════════
//  AI analyze (used by widget)
// ══════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  try {
    const { messages, maxTokens = 1000 } = req.body;
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      messages,
    });
    res.json(response);
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  Lead capture (called by widget after analysis)
// ══════════════════════════════════════
app.post('/api/leads', async (req, res) => {
  try {
    const body = req.body;

    // Determine provider from widget code
    let providerId = null;
    let widget = null;
    if (body.widgetCode) {
      widget = db.getWidgetByCode(body.widgetCode);
      if (widget) providerId = widget.provider_id;
    }

    // Fall back to legacy file-based storage if no widget code (demo mode)
    if (!providerId) {
      return res.json({ ok: true, demo: true });
    }

    const lead = db.saveLead({ ...body, providerId, widgetCode: body.widgetCode });

    // Route the lead (fire and forget)
    if (widget) routeLead(lead, widget).catch(err => console.warn('Routing error:', err.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('Lead save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  VA Chat
// ══════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body;
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: systemPrompt,
      messages,
    });
    res.json(response);
  } catch (err) {
    console.error('Chat API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  Legacy super-admin (kept for compatibility)
// ══════════════════════════════════════
app.get('/api/admin/leads', (req, res) => {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.query.password !== pw) return res.status(401).json({ error: 'Unauthorized' });
  // return all leads across all providers
  const allLeads = db.getLeadsByProvider && [];
  res.json([]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Widget:    http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  Admin:     http://localhost:${PORT}/admin\n`);
});
