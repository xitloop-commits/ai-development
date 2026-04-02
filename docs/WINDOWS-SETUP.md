# ATS — Windows Setup Guide

This guide walks you through setting up the Automatic Trading System on Windows using VS Code.

---

## Prerequisites

| Tool | Required | Check Command | Download |
|------|----------|---------------|----------|
| Node.js (v18+) | Yes | `node --version` | [nodejs.org](https://nodejs.org/) |
| Python (3.10+) | Yes | `python --version` | [python.org](https://www.python.org/downloads/) |
| MongoDB | Yes | `mongosh --version` | See [Database Setup](#2-database-setup) below |
| Git | Yes | `git --version` | [git-scm.com](https://git-scm.com/) |
| VS Code | Recommended | — | [code.visualstudio.com](https://code.visualstudio.com/) |

---

## Quick Start (Automated)

Open a terminal in VS Code (`Ctrl + ~`) and run:

```cmd
setup.bat
```

This will install all dependencies, create your `.env` file, and guide you through the rest.

Then start the server:

```cmd
dev.bat
```

---

## Manual Setup (Step by Step)

### 1. Install pnpm

`pnpm` is the package manager used by this project. Install it globally:

```cmd
npm install -g pnpm
```

**Troubleshooting:** If you get a permission error, open Command Prompt as Administrator and try again.

**Verify:** `pnpm --version` should print a version number.

### 2. Database Setup

The project uses **MongoDB** for broker configs, settings, and trade data.

**Option A — MongoDB Atlas (Recommended, Free)**

1. Go to [mongodb.com/atlas](https://www.mongodb.com/atlas) and create a free account
2. Create a free M0 cluster
3. Click **Connect** → **Connect your application**
4. Copy the connection string (looks like `mongodb+srv://user:pass@cluster.mongodb.net/ats`)
5. Paste it as `MONGODB_URI` in your `.env` file

**Option B — Local MongoDB**

1. Download [MongoDB Community Server](https://www.mongodb.com/try/download/community)
2. Install with default settings (it runs as a Windows service)
3. Your connection string will be: `mongodb://localhost:27017/ats`

### 3. Install Dependencies

```cmd
REM Install Node.js packages
pnpm install

REM Install Python packages
python -m pip install -r python_modules\requirements.txt
```

**Common issues:**

| Problem | Solution |
|---------|----------|
| `pnpm: command not found` | Run `npm install -g pnpm` first |
| `pip: command not found` | Use `python -m pip install ...` instead |
| `python: command not found` | Use `python3` or check Python is in your PATH |
| Permission errors with pip | Add `--user` flag: `python -m pip install --user -r python_modules\requirements.txt` |

### 4. Configure Environment

```cmd
REM Create your .env file from the template
copy .env.example .env
```

Open `.env` in VS Code and fill in the required values:

```env
# REQUIRED — Set your MongoDB connection string
MONGODB_URI=mongodb://localhost:27017/ats

# These are set automatically, leave as-is for local dev
NODE_ENV=development
PORT=3000
BROKER_URL=http://localhost:3000
DASHBOARD_URL=http://localhost:3000
LIVE_TRADING=false
```

The other variables (`VITE_APP_ID`, `JWT_SECRET`, `OAUTH_SERVER_URL`, etc.) are auto-configured when deployed on the hosted platform. For local development, they can be left empty.

### 5. Start the Server

```cmd
pnpm dev
```

You should see output like:

```
[MongoDB] Connected successfully to ats
[BrokerService] Initialized — active broker: mock
Server running on port 3000
```

Open your browser to **http://localhost:3000**

### 6. Run Python Modules (Optional)

In a **separate** VS Code terminal (`Ctrl + Shift + ~`):

```cmd
cd python_modules
python option_chain_fetcher.py
```

The Python modules will automatically load your `.env` file from the project root.

---

## Running Tests

```cmd
REM TypeScript type check (no database needed)
pnpm check

REM Unit tests — MockAdapter (no database needed)
pnpm vitest run server/broker/adapters/mock/mockAdapter.test.ts

REM All tests (requires MongoDB running)
pnpm test
```

---

## Project Commands Reference

| Command | Description |
|---------|-------------|
| `setup.bat` | One-time setup (installs everything) |
| `dev.bat` | Start the development server |
| `pnpm dev` | Start dev server (same as dev.bat) |
| `pnpm check` | TypeScript type check |
| `pnpm test` | Run all tests |
| `pnpm build` | Build for production |
| `pnpm start` | Start production server |

---

## Folder Structure

```
ai-development/
├── .env.example          ← Template for environment variables
├── .env                  ← Your local config (git-ignored)
├── setup.bat             ← Windows setup script
├── dev.bat               ← Windows dev server launcher
├── package.json          ← Node.js dependencies & scripts
├── client/src/           ← React frontend
├── server/               ← Express + tRPC backend
│   ├── broker/           ← Broker Service (Mock + Dhan adapters)
│   ├── _core/            ← Server bootstrap, auth, env
│   └── mongo.ts          ← MongoDB connection
├── python_modules/       ← AI pipeline (Python)
│   ├── env_loader.py     ← Shared .env loader
│   ├── requirements.txt  ← Python dependencies
│   ├── option_chain_fetcher.py
│   ├── option_chain_analyzer.py
│   ├── ai_decision_engine.py
│   ├── execution_module.py
│   └── dashboard_data_pusher.py
├── shared/               ← Shared TypeScript types
├── drizzle/              ← Database schema & migrations
└── docs/                 ← Specs, mockups, architecture
```

---

## Troubleshooting

**"NODE_ENV is not recognized as a command"**
This has been fixed. The `dev` script no longer uses inline `NODE_ENV=`. It reads from your `.env` file instead.

**"Cannot find module" errors after pnpm install**
```cmd
rmdir /s /q node_modules
del pnpm-lock.yaml
pnpm install
```

**MongoDB connection errors**
- Check MongoDB is running: `mongosh` should connect
- Verify `MONGODB_URI` in `.env` is correct
- For Atlas: ensure your IP is whitelisted in Network Access

**Python modules can't connect to server**
- Make sure the server is running first (`pnpm dev`)
- Check `BROKER_URL` and `DASHBOARD_URL` in `.env` match the server port

**Port 3000 already in use**
- The server auto-finds the next available port
- Or change `PORT` in `.env`
