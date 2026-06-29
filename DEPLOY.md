# Deploying HojayTrack — Exact Steps

Backend: PythonAnywhere (genuinely free, no credit card required).
Frontend: Vercel (free for personal projects).

---

## Step 1 — Push to GitHub

Open a terminal in this folder and run, one line at a time:

```
git init
git add .
git commit -m "Ready for deployment"
```

Then go to https://github.com/new, create a repo (any name, e.g. `hojaytrack`),
and run the commands GitHub shows you, which look like:

```
git remote add origin https://github.com/YOUR_USERNAME/hojaytrack.git
git branch -M main
git push -u origin main
```

---

## Step 2 — Deploy the backend (PythonAnywhere)

1. Go to https://www.pythonanywhere.com → click **Pricing & signup** →
   choose the **Beginner** (free) account. No card needed.
2. Once logged in, go to the **Consoles** tab → **Bash** (starts a new
   terminal in your browser)
3. Clone your repo:
   ```
   git clone https://github.com/YOUR_USERNAME/hojaytrack.git
   ```
4. Create a virtual environment and install your dependencies:
   ```
   mkvirtualenv --python=/usr/bin/python3.10 hojaytrack-env
   cd hojaytrack
   pip install -r requirements.txt
   ```
   (If `mkvirtualenv` says command not found, just close and reopen the
   console — free accounts sometimes need one console restart after
   first signup.)
5. Go to the **Web** tab → **Add a new web app** → when asked, choose
   **Manual configuration** (not the Flask quickstart) → pick the same
   Python version as your virtualenv.
6. On the Web tab configuration page, fill in:
   - **Source code:** `/home/YOUR_USERNAME/hojaytrack`
   - **Working directory:** `/home/YOUR_USERNAME/hojaytrack`
   - **Virtualenv:** `/home/YOUR_USERNAME/.virtualenvs/hojaytrack-env`
7. Click the **WSGI configuration file** link (still on the Web tab) and
   replace its entire contents with:
   ```python
   import sys
   path = '/home/YOUR_USERNAME/hojaytrack'
   if path not in sys.path:
       sys.path.insert(0, path)

   from app import app as application
   ```
   (replace `YOUR_USERNAME` with your actual PythonAnywhere username,
   shown in the path at the top of the page)
8. Back on the Web tab, scroll to **Environment variables** and add:
   - `HOJAYTRACK_SECRET_KEY` → any long random string you make up
   - `FRONTEND_ORIGIN` → leave blank for now, come back after Step 3
9. Click the big green **Reload** button at the top of the Web tab
10. Your backend is now live at: `https://YOUR_USERNAME.pythonanywhere.com`
    — copy this, you need it for Step 3

---

## Step 3 — Deploy the frontend (Vercel)

1. Go to https://vercel.com → sign up/log in (no card needed for personal
   projects)
2. Click **Add New** → **Project** → import the same GitHub repo
3. Vercel auto-detects Next.js — don't change settings yet
4. Before clicking Deploy, expand **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `FLASK_BASE` | your PythonAnywhere URL from Step 2, e.g. `https://YOUR_USERNAME.pythonanywhere.com` |

5. Click **Deploy**
6. You'll get a URL like `https://hojaytrack.vercel.app` — this is the
   link for your phone

---

## Step 4 — Connect them

1. Go back to **PythonAnywhere** → **Web** tab → **Environment variables**
2. Set `FRONTEND_ORIGIN` to your real Vercel URL from Step 3:
   ```
   https://hojaytrack.vercel.app
   ```
3. Click **Reload** on the Web tab again

---

## Step 5 — Test on your phone

Turn off WiFi on your phone (so you're genuinely on mobile data), open:

```
https://hojaytrack.vercel.app
```

Log in with one of the seeded accounts and try clocking in/out.

---

## Known limitations of this free setup

- **PythonAnywhere's free tier restricts outbound internet access** to an
  allow-list of domains. This only matters if your backend ever needs to
  call *other* external APIs — it does not affect your phone talking to
  it, which works normally.
- **Every 3 months, log into PythonAnywhere and click "Run until 3 months
  from today"** on the Web tab, or your free site pauses (it's not
  deleted — just paused until you click that button again).
- **Data resets if you re-clone or wipe the project folder.** The SQLite
  file lives in your PythonAnywhere file storage — back it up
  occasionally if the data starts to matter to you (Files tab → download
  `hojaytrack.db`).
- **If something doesn't connect:** double check Step 4's
  `FRONTEND_ORIGIN` exactly matches your Vercel URL (no trailing slash),
  and Step 3's `FLASK_BASE` exactly matches your PythonAnywhere URL.
  After ANY change to environment variables on PythonAnywhere, you must
  click **Reload** on the Web tab for it to take effect.

