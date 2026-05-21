require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATA_DIR = path.join(__dirname, '../data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]', 'utf8');

function readLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
  catch { return []; }
}

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Routing: / → landing page unless ?code= param present
app.get('/', (req, res) => {
  if (req.query.code) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    res.sendFile(path.join(__dirname, '../public/landing.html'));
  }
});
app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));

app.use(express.static(path.join(__dirname, '../public')));

app.post('/api/analyze', async (req, res) => {
  try {
    const { messages, maxTokens = 1000 } = req.body;
    const response = await client.messages.create({
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

app.post('/api/leads', (req, res) => {
  try {
    const lead = req.body;
    if (!lead.email || !lead.fname) return res.status(400).json({ error: 'Missing required fields' });
    const leads = readLeads();
    leads.unshift({ id: Date.now().toString(), capturedAt: new Date().toISOString(), ...lead });
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error('Lead save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads', (req, res) => {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.query.password !== pw) return res.status(401).json({ error: 'Unauthorized' });
  res.json(readLeads());
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body;
    const response = await client.messages.create({
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Widget: http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin\n`);
});
