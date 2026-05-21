# Medspa Aesthetic Consultation Widget

AI-powered pre-consultation widget for medical aesthetics clinics. Collects treatment goals, analyzes uploaded photos with Claude's vision model, and returns a personalized treatment guide.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Add your API key
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 3. Run the dev server
npm run dev

# 4. Open in browser
open http://localhost:3000
```

## Project structure

```
medspa-widget/
├── public/
│   └── index.html      # The full widget UI (edit CLINIC config here)
├── server/
│   └── index.js        # Express proxy — keeps API key server-side
├── .env                # Your secrets (never commit this)
├── .env.example        # Template
└── package.json
```

## Clinic branding

Edit the `CLINIC` object near the top of `public/index.html`:

```js
const CLINIC = {
  name:        'Your Clinic Name',
  logoUrl:     '/logo.png',          // put logo in public/ folder
  accent:      '#b49dd4',            // primary brand color
  accentLight: '#EEEDFE',            // light tint
  accentDark:  '#3C3489',            // dark tint (text on light bg)
  accentMid:   '#7c5ca8',            // mid tone
  bookingUrl:  'https://your-booking-link.com',
  poweredBy:   'Your Brand Name',
  apiEndpoint: '/api/analyze',       // don't change this
};
```

## How it works

1. **Steps 1–3** — Client selects target areas, concerns, treatment history, and budget
2. **Step 4** — Client uploads up to 4 facial photos (front, left, right, smiling)
3. **Step 5** — Lead capture form (name, email, phone)
4. **Result** — Two AI calls:
   - Vision call: analyzes uploaded photos for surface skin observations
   - Recommendation call: generates personalized treatment modalities + investment framing
5. **CTA** — Books a consultation at your clinic URL

## API proxy

All Anthropic API calls go through `POST /api/analyze` on the Express server.
This keeps your API key off the client and lets you add rate limiting, logging,
or CRM integrations in `server/index.js` later.

## Ideas for next features

- [ ] Email the results PDF to the client automatically
- [ ] POST lead data to a CRM (HubSpot, GoHighLevel, etc.)
- [ ] Add a before/after photo comparison carousel on the result screen
- [ ] Multi-language support
- [ ] Admin dashboard showing lead volume and top concerns
- [ ] Embed as an `<iframe>` on any website
