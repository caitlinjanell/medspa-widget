require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const db = require('./db');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
if (!apiKey) console.error('ERROR: ANTHROPIC_API_KEY is not set');
else console.log('Anthropic key loaded, length:', apiKey.length, 'prefix:', apiKey.slice(0, 10));
const claude = new Anthropic({ apiKey });
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

app.use(cors());

app.get('/api/health', async (req, res) => {
  const status = { server: 'ok', database: 'unknown', anthropic: !!process.env.ANTHROPIC_API_KEY, textbelt: !!process.env.TEXTBELT_KEY };
  try { await require('./db').getProviderByEmail('health-check-test@test.com'); status.database = 'ok'; }
  catch (e) { status.database = e.message; }
  res.json(status);
});

app.get('/api/test-sms/:phone', async (req, res) => {
  try {
    const result = await sendSms(req.params.phone, 'Meet Goldie SMS test — it works!');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe webhook (raw body MUST come before express.json) ──
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  const PLAN_PRICES = {
    [process.env.STRIPE_PRICE_STARTER]: 'starter',
    [process.env.STRIPE_PRICE_PRO]:     'pro',
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = sub.items.data[0]?.price?.id;
        const plan = PLAN_PRICES[priceId] || 'starter';
        db.updateProviderBilling(session.metadata.providerId, {
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          subscriptionStatus: 'active',
          plan,
        });
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const provider = await db.getProviderByStripeCustomer(sub.customer);
        if (!provider) break;
        const priceId = sub.items.data[0]?.price?.id;
        const plan = PLAN_PRICES[priceId] || provider.plan;
        db.updateProviderBilling(provider.id, {
          subscriptionStatus: sub.status,
          stripeSubscriptionId: sub.id,
          plan,
        });
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const provider = await db.getProviderByStripeCustomer(sub.customer);
        if (provider) db.updateProviderBilling(provider.id, { subscriptionStatus: 'canceled', plan: 'free' });
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const provider = await db.getProviderByStripeCustomer(invoice.customer);
        if (provider) db.updateProviderBilling(provider.id, { subscriptionStatus: 'past_due' });
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

async function sendSms(to, message) {
  const key = process.env.TEXTBELT_KEY || 'textbelt';
  const resp = await fetch('https://textbelt.com/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: to, message, key }),
  });
  const result = await resp.json();
  if (!result.success) console.warn('TextBelt error:', result.error);
  return result;
}

// ── Lead routing ──
async function routeLead(lead, widget) {
  const type = widget.routing_type;
  const config = typeof widget.routingConfig === 'object' ? widget.routingConfig : {};
  const smsMsg = `New lead at ${widget.config?.clinicName || 'your clinic'}: Check your Meet Goldie dashboard`;
  const smsSentTo = new Set();

  if (type === 'email' && config.email) {
    const areas = (lead.areas || []).join(', ');
    const mods = (lead.modalities || []).join(', ');
    await sendEmail({
      to: config.email,
      subject: `New consultation lead: ${lead.fname} ${lead.lname}`,
      html: `
        <h2 style="font-family:sans-serif;color:#7A5520">New Lead — ${widget.config?.clinicName || 'Your Clinic'}</h2>
        <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;width:100%;max-width:500px">
          <tr><td style="padding:6px 0;color:#888;width:140px">Name</td><td style="padding:6px 0;font-weight:600">${lead.fname} ${lead.lname}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Email</td><td style="padding:6px 0">${lead.email}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Phone</td><td style="padding:6px 0">${lead.phone || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Budget</td><td style="padding:6px 0">${lead.budget}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Areas</td><td style="padding:6px 0">${areas}</td></tr>
          <tr><td style="padding:6px 0;color:#888">AI Recommendations</td><td style="padding:6px 0">${mods}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Package</td><td style="padding:6px 0">${lead.package}</td></tr>
        </table>
        <p style="font-family:sans-serif;font-size:12px;color:#aaa;margin-top:24px">Sent by Meet Goldie</p>`,
    });
  }

  if (type === 'sms' && config.phone) {
    await sendSms(config.phone, smsMsg);
    smsSentTo.add(config.phone);
  }

  if (type === 'webhook' && config.url) {
    await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...lead, widgetName: widget.name, clinic: widget.config?.clinicName }),
    }).catch(() => {});
  }

  // Always-on SMS alert — skip if already sent to this number via routing
  if (config.notificationPhone && !smsSentTo.has(config.notificationPhone)) {
    await sendSms(config.notificationPhone, smsMsg);
  }

  if (type === 'chatbot' && lead.email) {
    const mods = (lead.modalities || []).join(', ');
    await sendEmail({
      to: lead.email,
      subject: `Your personalized treatment plan from ${widget.config?.clinicName || 'us'}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#7A5520">Hi ${lead.fname},</h2>
          <p style="color:#555;line-height:1.6">Thank you for completing your pre-consultation. Here's a summary of your personalized treatment plan.</p>
          <div style="background:#FEF6DC;border-radius:12px;padding:16px 20px;margin:20px 0">
            <p style="color:#7A5520;font-size:13px;line-height:1.7">${lead.analysis}</p>
          </div>
          <p style="color:#555"><strong>Recommended treatments:</strong> ${mods}</p>
          <p style="color:#555"><strong>Investment package:</strong> ${lead.package}</p>
          <p style="color:#555;margin-top:24px">We look forward to seeing you in person. <a href="${widget.config?.bookingUrl || '#'}" style="color:#A07830;font-weight:600">Book your consultation →</a></p>
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
const NO_CACHE = { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' } };
app.get('/demo',      (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/admin',     (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html'), NO_CACHE));
app.get('/signup',    (req, res) => res.sendFile(path.join(__dirname, '../public/signup.html'), NO_CACHE));
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname, '../public/login.html'), NO_CACHE));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html'), NO_CACHE));
app.get('/logout',    (req, res) => res.sendFile(path.join(__dirname, '../public/logout.html')));

app.use(express.static(path.join(__dirname, '../public')));

// ══════════════════════════════════════
//  Auth routes
// ══════════════════════════════════════
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, clinicName } = req.body;
    if (!email || !password || !clinicName) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (await db.getProviderByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });
    const hash = await bcrypt.hash(password, 12);
    const provider = await db.createProvider(email, hash, clinicName);
    const token = jwt.sign({ id: provider.id, email: provider.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, provider: { id: provider.id, email: provider.email, clinicName: provider.clinicName } });
  } catch (err) {
    const msg = err?.message || err?.code || String(err) || 'Unknown signup error';
    console.error('Signup error:', msg, err?.code, err?.detail);
    res.status(500).json({ error: msg });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const provider = await db.getProviderByEmail(email);
    if (!provider) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, provider.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: provider.id, email: provider.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, provider: { id: provider.id, email: provider.email, clinicName: provider.clinic_name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const provider = await db.getProviderById(req.provider.id);
  if (!provider) return res.status(404).json({ error: 'Not found' });
  let trialDaysLeft = 0;
  if (provider.subscription_status === 'trialing' && provider.trial_ends_at) {
    trialDaysLeft = Math.max(0, Math.ceil((new Date(provider.trial_ends_at) - Date.now()) / 86400000));
  }
  res.json({
    id: provider.id,
    email: provider.email,
    clinicName: provider.clinic_name,
    plan: provider.plan,
    subscriptionStatus: provider.subscription_status,
    trialDaysLeft,
    hasStripe: !!provider.stripe_customer_id,
  });
});

// ══════════════════════════════════════
//  Stripe — checkout & billing portal
// ══════════════════════════════════════
app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  const { plan } = req.body; // 'starter' or 'pro'
  const priceId = plan === 'pro' ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_STARTER;
  if (!priceId) return res.status(400).json({ error: `STRIPE_PRICE_${plan.toUpperCase()} not set in environment` });

  const provider = await db.getProviderById(req.provider.id);
  const origin = req.headers.origin || process.env.APP_URL || 'http://localhost:3000';

  // Reuse existing Stripe customer if available
  let customerId = provider.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: provider.email, name: provider.clinic_name });
    customerId = customer.id;
    db.updateProviderBilling(provider.id, { stripeCustomerId: customerId });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/dashboard?upgraded=1`,
    cancel_url:  `${origin}/dashboard?canceled=1`,
    metadata: { providerId: provider.id },
    subscription_data: { trial_period_days: 0 },
    allow_promotion_codes: true,
  });

  res.json({ url: session.url });
});

app.post('/api/stripe/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  const provider = await db.getProviderById(req.provider.id);
  if (!provider.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });
  const origin = req.headers.origin || process.env.APP_URL || 'http://localhost:3000';
  const session = await stripe.billingPortal.sessions.create({
    customer: provider.stripe_customer_id,
    return_url: `${origin}/dashboard`,
  });
  res.json({ url: session.url });
});

// ══════════════════════════════════════
//  Provider — widgets
// ══════════════════════════════════════
app.get('/api/provider/widgets', requireAuth, async (req, res) => {
  res.json(await db.getWidgetsByProvider(req.provider.id));
});

app.post('/api/provider/widgets', requireAuth, async (req, res) => {
  const provider = await db.getProviderById(req.provider.id);
  const widget = await db.createWidget(req.provider.id, provider.clinic_name, req.body.name);
  res.json(widget);
});

app.put('/api/provider/widgets/:id', requireAuth, async (req, res) => {
  const { name, config, routingType, routingConfig } = req.body;
  const widget = await db.updateWidget(req.params.id, req.provider.id, { name, config, routingType, routingConfig });
  if (!widget) return res.status(404).json({ error: 'Widget not found' });
  res.json(widget);
});

app.delete('/api/provider/widgets/:id', requireAuth, async (req, res) => {
  await db.deleteWidget(req.params.id, req.provider.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════
//  Provider — leads
// ══════════════════════════════════════
app.get('/api/provider/leads', requireAuth, async (req, res) => {
  res.json(await db.getLeadsByProvider(req.provider.id));
});

// ══════════════════════════════════════
//  Public — widget config (loaded by widget JS)
// ══════════════════════════════════════
app.get('/api/widget-config/:code', async (req, res) => {
  const widget = await db.getWidgetByCode(req.params.code);
  if (!widget) return res.status(404).json({ error: 'Widget not found' });
  res.json(widget.config);
});

// ══════════════════════════════════════
//  AI analyze (used by widget)
// ══════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  try {
    const { messages, maxTokens = 1000 } = req.body;
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages,
    });
    res.json(response);
  } catch (err) {
    console.error('Anthropic API error:', err.message, err.status, err.error);
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
      widget = await db.getWidgetByCode(body.widgetCode);
      if (widget) providerId = widget.provider_id;
    }

    // Fall back to demo mode if no widget code
    if (!providerId) {
      return res.json({ ok: true, demo: true });
    }

    const lead = await db.saveLead({ ...body, providerId, widgetCode: body.widgetCode, photos: body.photos || {} });

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
      model: 'claude-sonnet-4-6',
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
//  Testimonials
// ══════════════════════════════════════
app.get('/api/testimonials', async (req, res) => {
  res.json(await db.getApprovedTestimonials());
});

app.post('/api/provider/testimonial', requireAuth, async (req, res) => {
  try {
    const { authorName, authorRole, content } = req.body;
    if (!authorName || !content) return res.status(400).json({ error: 'Name and content required' });
    if (content.length > 500) return res.status(400).json({ error: 'Testimonial must be under 500 characters' });
    const provider = await db.getProviderById(req.provider.id);
    const t = await db.submitTestimonial(req.provider.id, {
      clinicName: provider.clinic_name,
      authorName,
      authorRole: authorRole || '',
      content,
    });
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/provider/testimonial', requireAuth, async (req, res) => {
  res.json(await db.getProviderTestimonial(req.provider.id));
});

// Admin testimonial management
app.get('/api/admin/testimonials', async (req, res) => {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.query.password !== pw) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await db.getAllTestimonials());
});

app.post('/api/admin/testimonials/:id/approve', async (req, res) => {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.query.password !== pw) return res.status(401).json({ error: 'Unauthorized' });
  await db.approveTestimonial(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/testimonials/:id', async (req, res) => {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.query.password !== pw) return res.status(401).json({ error: 'Unauthorized' });
  await db.deleteTestimonial(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════
//  Legacy super-admin (kept for compatibility)
// ══════════════════════════════════════
app.get('/api/admin/leads', async (req, res) => {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.query.password !== pw) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await db.getAllLeads());
});

app.get('/api/admin/providers', async (req, res) => {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.query.password !== pw) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await db.getAllProviders());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Widget:    http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  Admin:     http://localhost:${PORT}/admin\n`);
});
