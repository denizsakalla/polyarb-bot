# PolyARB Bot v4 — Cloud Deploy Guide

Deploy this in 5 minutes for free. Your cloud server runs outside Bulgaria,
fetches Polymarket data, and streams it back to your browser.

---

## Option 1: Render.com (Recommended — Free)

### Step 1 — Push to GitHub
```bash
# Create a new repo on github.com, then:
git init
git add .
git commit -m "PolyARB cloud proxy"
git remote add origin https://github.com/YOUR_USERNAME/polyarb-bot.git
git push -u origin main
```

### Step 2 — Deploy on Render
1. Go to **https://render.com** and sign up (free)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo
4. Set these values:
   - **Name**: `polyarb-bot`
   - **Runtime**: `Node`
   - **Build command**: *(leave empty)*
   - **Start command**: `node server.js`
   - **Instance type**: `Free`
5. Click **"Create Web Service"**

Render gives you a URL like: `https://polyarb-bot.onrender.com`

### Step 3 — Open the bot
Go to `https://polyarb-bot.onrender.com` in your browser.

**Note**: Free Render instances sleep after 15 minutes of inactivity.
First load after sleep takes ~30 seconds. Upgrade to Starter ($7/mo) for
always-on hosting.

---

## Option 2: Railway.app (Free $5 credit/month)

1. Go to **https://railway.app** and sign up
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your repo
4. Railway auto-detects Node.js and deploys
5. Click **"Generate Domain"** in settings

---

## Option 3: Glitch.com (Free, always on)

1. Go to **https://glitch.com** and sign up
2. Click **"New Project"** → **"Import from GitHub"**
3. Paste your repo URL
4. Glitch gives you `https://your-project.glitch.me`

---

## How it works

```
Your browser (Bulgaria)
        ↓  WebSocket / HTTP
Cloud Server (EU/US, unblocked)
        ↓  Proxied connection
Polymarket APIs (gamma + clob + ws)
        ↓
Real live market data
```

The cloud server:
- Proxies `GET /api/gamma/*` → `gamma-api.polymarket.com`
- Proxies `POST /api/clob/*` → `clob.polymarket.com`  
- Tunnels `ws://YOUR_SERVER/ws/*` → `wss://ws-subscriptions-clob.polymarket.com`

Your browser only ever talks to YOUR server. Polymarket sees a US/EU IP.

---

## File structure

```
polyarb-cloud/
├── server.js          ← proxy + WebSocket tunnel + static server
├── package.json       ← no dependencies needed
├── README.md
└── public/
    └── index.html     ← PolyARB Bot v4 UI
```

---

## Environment variables (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port (Render sets this automatically) |
