# Vehicle Comparison & Assessment Tool

A single-page vehicle comparison tool for Toyota RAV4 and Honda CR-V (2018–2023), deployed on Cloudflare Pages + Workers.

**Features:**
- Compare up to 6 vehicles side-by-side with 30+ features across 7 categories
- Single vehicle lookup showing all years for a trim
- VIN Check: decode any VIN via NHTSA, check recalls and complaints, price assessment, buyer's checklist
- Carfax PDF analysis via Claude Sonnet AI (requires access PIN)

---

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier)
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

## First-Time Setup

```bash
cd vehicle-tool
npm install
npx wrangler login   # opens browser to authenticate with Cloudflare
```

---

## Deploy the Worker (Backend)

```bash
cd worker

# Create KV namespace for rate limiting (already done — ID is in wrangler.toml)
# If you need to recreate: npx wrangler kv:namespace create RATE_LIMIT

# Set secrets (run each command, paste value when prompted)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ACCESS_PIN

# Deploy
npx wrangler deploy
```

Note the Worker URL printed at the end (e.g. `https://vehicle-tool-api.YOURNAME.workers.dev`).

---

## Update the Frontend

In `public/index.html`, find and update:

```javascript
const API_BASE = 'https://vehicle-tool-api.YOURNAME.workers.dev';
```

Replace `YOURNAME` with your actual Cloudflare account subdomain.

---

## Deploy to Cloudflare Pages

```bash
cd ..   # back to vehicle-tool/
npx wrangler pages deploy public/ --project-name vehicle-tool
```

Note the Pages URL printed at the end (e.g. `https://vehicle-tool.pages.dev`).

---

## Lock Down CORS

After getting the Pages URL, update `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "https://vehicle-tool.pages.dev"   # ← your actual URL
```

Then redeploy the Worker:

```bash
cd worker
npx wrangler deploy
```

---

## Share With Family

Send your family the Pages URL and the access PIN you set. The PIN is stored in their browser after first entry — they only need to enter it once per device.

---

## Secrets Reference

| Secret | How to set | Purpose |
|--------|-----------|---------|
| `ANTHROPIC_API_KEY` | `wrangler secret put ANTHROPIC_API_KEY` | Claude Sonnet for Carfax PDF analysis |
| `ACCESS_PIN` | `wrangler secret put ACCESS_PIN` | Protects the Worker endpoint |

Rate limit: 20 Carfax analyses per IP per day (Cloudflare KV, resets after 24 hours).

---

## Local Development

```bash
# Run Worker locally (uses simulated KV)
cd worker
npx wrangler dev

# Open the frontend directly in browser
open public/index.html
```

For local Carfax testing, add a `.dev.vars` file in `worker/` (gitignored):
```
ANTHROPIC_API_KEY=your-key-here
ACCESS_PIN=testpin123
```

---

## Updating the Tool

To redeploy after changes:

```bash
# Worker changes:
cd worker && npx wrangler deploy

# Frontend changes:
cd ..
npx wrangler pages deploy public/ --project-name vehicle-tool
```
