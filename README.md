# WhatsApp Gateway — Baileys Edition

A production-ready WhatsApp gateway using **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)** — pure WebSocket, no Chromium, no Puppeteer. Works on any Node.js hosting including Hostinger cPanel shared hosting.

## Requirements

- Node.js 18 or higher
- npm 9 or higher
- No Redis, no Chrome, no browser needed

---

## Local Development

```bash
# 1. Clone the repo
git clone https://github.com/your-username/whatsapp-gateway.git
cd whatsapp-gateway

# 2. Install dependencies
npm install

# 3. Create your .env file
cp .env.example .env
# Edit .env with your actual values

# 4. Start in dev mode (auto-restart on file changes)
npm run dev
```

Open `http://localhost:3000` and scan the QR code.

---

## Production Deployment on Hostinger (Git Import)

### Step 1 — Push your repo to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/whatsapp-gateway.git
git push -u origin main
```

### Step 2 — Import repo on Hostinger

1. Login to Hostinger hPanel
2. Go to **Websites → your domain → Git**
3. Click **Import from GitHub**
4. Authorize GitHub and select `whatsapp-gateway` repo
5. Set branch to `main`, deployment path to your Node app folder
6. Click **Deploy**

### Step 3 — Create `.env` on the server

Hostinger does **not** deploy your `.env` (it is in `.gitignore`).
You must create it manually via SSH:

```bash
cd /home/u517274722/domains/whatsapp.intouchsoftwaresolution.in/public_nodejs

# Create .env from the example
cp .env.example .env

# Edit with your real values
nano .env
```

Fill in:
```env
NODE_ENV=production
CRM_URL=https://crm.intouchsoftware.co.in
GATEWAY_SECRET=aayush-patidar
GATEWAY_URL=https://whatsapp.intouchsoftwaresolution.in
PORT=3000
GATEWAY_UI_USER=admin@intouchconnect.com
GATEWAY_UI_PASSWORD=YourPassword
GATEWAY_SESSION_SECRET=generate-a-long-random-string-here
```

### Step 4 — Install dependencies on server

```bash
npm install --omit=dev
```

### Step 5 — Start with PM2

```bash
# Start using the ecosystem config
pm2 start ecosystem.config.cjs

# Save so it restarts on server reboot
pm2 save
pm2 startup   # follow the command it prints

# Watch logs
pm2 logs whatsapp-gateway --lines 50
```

### Step 6 — Scan QR code

1. Open `https://whatsapp.intouchsoftwaresolution.in`
2. Login with your UI credentials
3. QR code appears — scan with WhatsApp on your phone
4. Dashboard shows **✓ Connected**

---

## Redeploy after code changes

When you push new code to GitHub:

```bash
# On Hostinger SSH (or use Hostinger's Git auto-deploy webhook)
cd /home/u517274722/domains/whatsapp.intouchsoftwaresolution.in/public_nodejs
git pull origin main
npm install --omit=dev
pm2 restart whatsapp-gateway
```

---

## Project Structure

```
whatsapp-gateway/
├── src/
│   ├── index.js          # Main server (Baileys + Express)
│   ├── logger.js         # Winston logger
│   ├── queue.js          # Queue instance
│   ├── simple-queue.js   # File-based job queue (no Redis)
│   ├── auth_info/        # Baileys session credentials (git-ignored)
│   └── public/           # Browser dashboard UI
│       ├── index.html    # Login page
│       ├── ui.html       # Dashboard page
│       ├── app.css       # Styles
│       ├── app.js        # Dashboard JS
│       └── login.js      # Login JS
├── logs/                 # Log files (git-ignored)
├── temp_uploads/         # Temp media files (git-ignored)
├── queue.json            # Job queue persistence (git-ignored)
├── .env                  # Secrets (git-ignored — create manually)
├── .env.example          # Safe template (committed to git)
├── ecosystem.config.cjs  # PM2 process config
├── nodemon.json          # Dev watcher config
└── package.json
```

---

## API Endpoints

These are called by the Laravel CRM — all require `X-Gateway-Secret` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Get connection status + QR |
| POST | `/send` | Queue a text message |
| POST | `/send-media` | Queue a media/document message |
| GET | `/queue/stats` | Queue stats (waiting/active/done/failed) |
| POST | `/logout` | Disconnect and reset session |

---

## Troubleshooting

**QR not showing after login**
- Check PM2 logs: `pm2 logs whatsapp-gateway --lines 30`
- Ensure `NODE_ENV=production` is in `.env`
- Ensure `GATEWAY_SESSION_SECRET` is set in `.env`

**Session disconnects immediately**
- Baileys auto-reconnects with exponential backoff — check logs for reason
- If reason is `loggedOut` — scan QR again from the dashboard

**CRM not receiving messages**
- Verify `CRM_URL` in `.env` has no trailing slash
- Test: `curl -X POST $CRM_URL/api/gateway/webhook -H "X-Gateway-Secret: $GATEWAY_SECRET" -d '{"event":"test"}'`

**`npm install` fails on Hostinger**
- Make sure Node.js version is 18+: `node -v`
- Try: `npm install --legacy-peer-deps`
