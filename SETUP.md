# Health log — getting it online

Three free accounts, about an hour, no coding tools on your computer. Do the steps in order; each one ends with something you can see working. Button labels on these sites change now and then, so if a name is slightly different, look for the nearest equivalent.

What each service does:

- **GitHub** holds the code files (this folder).
- **Netlify** turns those files into a live website and rebuilds it whenever the files change.
- **Supabase** is the database and the email sign-in.

Keep a note somewhere of: your Netlify site address, your Supabase project URL, and your Supabase anon key. You'll copy each of them once.

---

## Step 1 — Put the code on GitHub (10 min)

Works from a computer or an iPad. Every file sits at the top level of the folder, no sub-folders, so a plain file picker is all you need.

1. Unzip `health-log.zip`. On a computer, double-click it. On an iPad, tap it in the **Files** app and it extracts to a folder called `health-log` next to it.
2. Go to **github.com** and create a free account with a personal email.
3. Top-right **+** → **New repository**.
   - Repository name: `health-log`
   - Public or Private both work with Netlify. The code contains no secrets.
   - Do **not** tick "Add a README".
   - Click **Create repository**.
4. On the empty repository page, tap the link **uploading an existing file**.
5. Tap **choose your files**. In the picker, open the `health-log` folder and select **all 12 files** (on iPad: tap **Select** at the top, tap each file or **Select All**, then **Open**). On a computer you can also drag them onto the page.
6. Scroll down, leave the commit message as is, tap **Commit changes**.
7. The repository page should now list all 12 files:
   `App.jsx  Auth.jsx  config.js  index.html  main.jsx  netlify.toml  package.json  SETUP.md  storage.js  supabase.js  supabase.sql  vite.config.js`
   If any are missing, **Add file → Upload files** and add the stragglers.

**Done when:** all 12 files are listed on the repository page.

---

## Step 2 — Turn it into a website with Netlify (10 min)

1. Go to **netlify.com** → **Sign up** → choose **Sign up with GitHub** and approve.
2. On the dashboard: **Add new site** (or **Add new project**) → **Import an existing project** → **GitHub**.
3. Netlify asks which repositories it may see. Pick **Only select repositories** → choose `health-log` → **Install**.
4. Click `health-log` in the list. The build settings fill in by themselves from `netlify.toml` (build command `npm run build`, publish directory `dist`). Don't change anything. Click **Deploy**.
5. Wait one to two minutes while it builds. When the status says **Published**, click the site address at the top (something like `https://silly-name-123456.netlify.app`).
6. Optional but worth it: **Site configuration → Site details → Change site name** and pick something you'll remember, like `tims-log`. Your address becomes `https://tims-log.netlify.app`.

**Done when:** opening your site address shows a page titled *Health log* with a red message saying it is not connected to a database yet. That message is expected; steps 3 and 4 fix it.

---

## Step 3 — Create the database (10 min)

1. Go to **supabase.com** → **Start your project** → sign up (GitHub sign-in is easiest).
2. **New project**.
   - Name: `health-log`
   - Database password: let it generate one and save it in your password manager. You won't type it again, but keep it.
   - Region: pick the one closest to you (US East for New York).
   - Click **Create new project** and wait a minute or two while it sets up.
3. In the left sidebar click **SQL Editor** → **New query**.
4. Open `supabase.sql` and copy **all** of it. Easiest from GitHub: open the file in your repository, tap the **copy** icon (two overlapping squares, top-right of the file). Paste it into the query box, click **Run**.
   - You should see "Success. No rows returned." That created the table and the rule that each person can only see their own data.
5. Turn on email sign-in: sidebar **Authentication** → **Sign In / Providers** (or **Providers**). **Email** should already be enabled. Open it and make sure **Enable Email provider** is on. Save if you changed anything.
6. Tell Supabase where your site lives: **Authentication → URL Configuration**.
   - **Site URL:** your Netlify address from step 2, e.g. `https://tims-log.netlify.app`
   - **Redirect URLs:** click **Add URL** and enter your Netlify address followed by `/**`, e.g. `https://tims-log.netlify.app/**`
   - Save.

**Done when:** the SQL ran without error and the URL Configuration shows your Netlify address.

---

## Step 4 — Connect the website to the database (5 min)

1. In Supabase, sidebar **Project Settings** (gear icon) → **API** (may be under **Data API** or **API Keys**).
2. Copy two things:
   - **Project URL** — looks like `https://abcdefghijklmnop.supabase.co`
   - **anon public** key — a very long string that starts with `eyJ`. (Not the `service_role` key. Never paste that one anywhere.)
3. Back on GitHub, open your `health-log` repository → tap `config.js`.
4. Click the **pencil icon** (Edit this file), top-right of the file view.
5. Replace `PASTE_YOUR_PROJECT_URL_HERE` with the Project URL and `PASTE_YOUR_ANON_KEY_HERE` with the anon key. Keep the quote marks around each. The two lines should end up looking like:

   ```js
   export const SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3Mi...";
   ```

6. Click **Commit changes** (top-right) → **Commit changes** again in the box that appears.
7. Netlify notices the change and rebuilds automatically. Go to your Netlify dashboard → **Deploys** and wait for the new one to say **Published** (one to two minutes).

**Done when:** your site address now shows an email box instead of the red message.

---

## Step 5 — Sign in and check it saves (5 min)

1. Open your site. Enter your email, click **Send sign-in link**.
2. Check your inbox (and spam) for an email from Supabase. Click the link. It opens your site, signed in. The header shows your email and a *sign out* link.
   - If nothing arrives within a few minutes: Supabase's built-in email sender allows only a handful of emails per hour on the free plan. Wait an hour and try once more. Once you're signed in, you stay signed in on that device for weeks, so this is a one-time hassle per device.
3. Go to the **Data** tab. There should be **no** red "Not saving" banner. If there is, the codes in `config.js` are wrong or the SQL didn't run; redo step 3.4 or 4.
4. Go to **Log**, type a sleep score for yesterday, tab out. Close the browser tab completely. Reopen your site. The score should still be there.
5. On your phone: open the site in Safari (iPhone) or Chrome (Android), sign in the same way (the email link needs to be opened on the phone), then **Share → Add to Home Screen**. It opens like an app from then on.

**Done when:** an entry made on one device shows up on another.

---

## Everyday

- Open the app from your home screen or bookmark. Log yesterday. That's it.
- Every few weeks: **Data → Download everything (JSON)** for a backup outside Supabase.
- If you had data in the Claude version, **Data → Restore from backup** loads its JSON export.

## Changing the app later

Ask Claude for the change, attach the current `App.jsx` from GitHub (open the file → **Raw** → save the page, or copy the text). Claude gives you back a new `App.jsx`. On GitHub open `App.jsx`, pencil icon, select all, paste, **Commit changes**. Netlify rebuilds in a minute or two. Your data is untouched because it lives in Supabase, not in the code.

## If something breaks

- **Site shows a blank page after a change:** Netlify → **Deploys** → click the failed deploy to see the error, or click the previous successful deploy → **Publish deploy** to roll back instantly.
- **"Not saving" banner:** wrong codes in `config.js`, or the table doesn't exist. Redo steps 3.4 and 4.
- **Sign-in link says "invalid" or lands on a blank page:** Supabase → Authentication → URL Configuration must contain your exact Netlify address (with `https://`, no trailing slash) as Site URL and `…/**` in Redirect URLs.
- **Emails never arrive:** hourly limit on Supabase's default sender. Wait, retry. If you want it gone for good, Supabase lets you plug in a free Resend account under Authentication → SMTP settings; ask Claude to walk you through it.

## What's next

Once you've used it for a couple of weeks, the Strava connection is a separate round: a Strava developer app, a small function on Netlify that Strava calls when you upload a run, and a **Connect Strava** button in the app. Everything built here stays as is.
