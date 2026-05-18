# Health Tracker

Track your weight (stone & lbs) and HbA1c over time, with trend projections and persistent cloud storage.

---

## Setup Guide

### Step 1 — Create the Supabase database

1. Go to [supabase.com](https://supabase.com) and open your project (or create a new one)
2. Go to **SQL Editor** and run the following:

```sql
-- Weight entries table
create table weight_entries (
  id uuid default gen_random_uuid() primary key,
  date text not null,
  st numeric not null,
  lbs numeric not null,
  kg numeric not null,
  created_at timestamptz default now()
);

-- HbA1c entries table
create table hba1c_entries (
  id uuid default gen_random_uuid() primary key,
  date text not null,
  score numeric not null,
  created_at timestamptz default now()
);

-- Allow public read/write (no auth needed for personal use)
alter table weight_entries enable row level security;
alter table hba1c_entries enable row level security;

create policy "Public access" on weight_entries for all using (true) with check (true);
create policy "Public access" on hba1c_entries for all using (true) with check (true);
```

3. Go to **Project Settings → API** and copy:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **anon public** key

---

### Step 2 — Add the project to GitHub

1. Go to [github.com](https://github.com) and create a new **public** repository called `health-tracker`
2. On your computer, open a terminal in this project folder and run:

```bash
npm install
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/health-tracker.git
git push -u origin main
```

---

### Step 3 — Deploy on Netlify

1. Go to [netlify.com](https://netlify.com) and click **Add new site → Import from GitHub**
2. Select your `health-tracker` repository
3. Netlify will auto-detect the build settings (Vite). Confirm:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
4. Before deploying, go to **Site settings → Environment variables** and add:
   - `VITE_SUPABASE_URL` → your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` → your Supabase anon key
5. Click **Deploy site**

---

### Step 4 — Add to your iPhone home screen

1. Open your Netlify URL in **Safari** on your iPhone
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Tap **Add**

It will appear on your home screen like an app. Your data syncs via Supabase so it's the same on every device.

---

## Local development

```bash
# Copy the env file and fill in your Supabase details
cp .env.example .env.local

# Install and run
npm install
npm run dev
```
