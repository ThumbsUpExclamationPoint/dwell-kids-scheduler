# Deploy guide — Dwell Kids Scheduler

Total time: ~15 minutes once you have the PCO token in hand. Six steps:

1. Generate a PCO Personal Access Token (if you haven't already)
2. Create the Apps Script project, paste in `Code.gs` + `Introspect.gs`
3. Store the PCO token in Apps Script Properties (server-side, never in
   the repo)
4. Run the introspection helpers to discover your Service Type / Team /
   Position IDs and paste them into `Code.gs`
5. Deploy Apps Script as a web app, copy the URL into `index.html`
6. Push to GitHub and turn on Pages

You don't need a credit card, a domain, or any paid services.

---

## 1. Generate a PCO Personal Access Token

1. Go to **https://api.planningcenteronline.com/oauth/applications**
   while signed in as the PCO account that has admin access to Services
   for Dwell Church.
2. Scroll to the **Personal Access Tokens** section at the bottom.
3. Click **New Personal Access Token**.
4. Give it a description like `Dwell Kids Scheduler`.
5. Click **Submit**.
6. PCO will show you the **Application ID** and **Secret**. Copy both
   into a password manager — the Secret is only shown once.

---

## 2. Create the Apps Script project

1. Go to **https://script.google.com** while signed in as
   `matt@dwellpeninsula.com`.
2. Click **New project**. Rename it to **"Dwell Kids Scheduler"**.
3. Delete the placeholder `function myFunction()`.
4. Paste the contents of `apps-script/Code.gs` from this repo into the
   default `Code.gs` file.
5. Click the ➕ next to "Files" → **Script** → name it `Introspect`.
   Paste the contents of `apps-script/Introspect.gs` into it.
6. **Save** (⌘S / Ctrl+S).

---

## 3. Store the PCO token in Apps Script Properties

The PCO token must never be hard-coded in a file that gets committed
to GitHub. Instead, we store it in Apps Script's `PropertiesService`,
which is server-side and only visible to the script's owner.

1. In the Apps Script editor, open the **Project Settings** gear (⚙)
   in the left sidebar.
2. Scroll to **Script Properties**.
3. Click **Add script property** twice and add these two rows:

   | Property | Value |
   |----------|-------|
   | `PCO_APP_ID` | (your Application ID from step 1) |
   | `PCO_SECRET` | (your Secret from step 1) |

4. Click **Save script properties**.

That's it — the token is now reachable from `Code.gs` via
`PropertiesService.getScriptProperties().getProperty('PCO_APP_ID')` but
will never appear in any file you commit.

---

## 4. Discover your PCO IDs (introspection)

Before the scheduler can work, it needs to know:

- The **Service Type ID** for each kids team (Toddlers, Elementary)
- The **Team ID** for each kids team (the volunteer team)
- The exact **Position names** within each team (Leader, Culture
  Captain, Connections)

These are different in every PCO account. The `Introspect.gs` file has
helpers that print them all to the log so you can copy/paste them.

### 4a. Authorize first

1. In the function dropdown above the editor, select **`pcoAuthorize`**.
2. Click **▶ Run**.
3. A dialog appears: "Authorization required". Click **Review permissions**.
4. Pick `matt@dwellpeninsula.com`.
5. You'll see "Google hasn't verified this app." Click **Advanced** →
   **Go to Dwell Kids Scheduler (unsafe)**. (It's safe — it's our own
   code. Google just hasn't gone through formal verification, which is
   for public-facing apps.)
6. Approve the requested permissions (network access for the PCO API).
7. Check the **Execution log**. You should see "PCO API reached
   successfully" and a count of Service Types in your account. If you
   see an auth error, double-check the `PCO_APP_ID` / `PCO_SECRET`
   properties from step 3.

### 4b. Find the Service Type IDs

1. Function dropdown → `listServiceTypes` → **▶ Run**.
2. Look at the Execution log. You'll see something like:
   ```
   Service Type: Sunday Service           id=12345  parent=null
   Service Type: Dwell Kids - Toddlers    id=67890  parent=null
   Service Type: Dwell Kids - Elementary  id=24680  parent=null
   ```
3. Copy the IDs for the two kids Service Types and paste them into the
   `SERVICE_TYPES` map at the top of `Code.gs`:
   ```js
   const SERVICE_TYPES = {
     toddlers:   '67890',
     elementary: '24680',
   };
   ```

### 4c. Find the Team IDs and Position names

1. Function dropdown → `listTeamsAndPositions` → **▶ Run**.
2. The log will show every Team under each Service Type, plus the
   positions within each Team:
   ```
   [Dwell Kids - Toddlers] Team: Toddlers Builders  id=4444
     - Position: Leader
     - Position: Culture Captain
   [Dwell Kids - Elementary] Team: Elementary Builders  id=5555
     - Position: Leader
     - Position: Culture Captain
     - Position: Connections
   ```
3. Paste the Team IDs into the `TEAMS` map in `Code.gs`:
   ```js
   const TEAMS = {
     toddlers:   '4444',
     elementary: '5555',
   };
   ```
4. Confirm the Position names in the `POSITIONS` map match what the
   log printed (case-sensitive — "Culture Captain" vs "Culture
   captain" matters):
   ```js
   const POSITIONS = {
     toddlers:   ['Leader', 'Culture Captain'],
     elementary: ['Leader', 'Culture Captain', 'Connections'],
   };
   ```
5. **Save**.

### 4d. Sanity-check the roster

1. Function dropdown → `listRosters` → **▶ Run**.
2. Confirm each kids team has the people you expect on it. The dropdown
   in the public scheduler will show exactly these people. If anyone is
   missing, add them in PCO (Services → People → Teams) and re-run.

### 4e. Smoke test (optional, recommended)

1. Function dropdown → `smokeTestClaim` → **▶ Run**.
2. This creates a test assignment for the first available Toddlers
   plan, then immediately deletes it. The log will say
   `smoke test passed` or print the exact error if something is wrong.
   If this passes, the claim flow is wired up correctly end-to-end.

---

## 5. Deploy as a web app

1. Top-right of Apps Script editor: **Deploy** → **New deployment**.
2. Click the gear ⚙ next to "Select type" → **Web app**.
3. Fill in:
   - **Description**: `v1`
   - **Execute as**: **Me (matt@dwellpeninsula.com)**
   - **Who has access**: **Anyone** (this is what lets the public
     scheduler page POST without each volunteer logging into Google)
4. Click **Deploy**.
5. Copy the **Web app URL**. It looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`
6. Open `index.html`. Find the `CONFIG` block near the bottom of the
   `<script>` section. Replace `REPLACE_ME_AFTER_DEPLOYING_APPS_SCRIPT`
   with the URL you just copied:
   ```js
   const CONFIG = {
     APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycb.../exec",
   };
   ```
7. **Save** `index.html`.

---

## 6. Push to GitHub and enable Pages

1. Create a new GitHub repo named `dwell-kids-scheduler` (under your
   personal account or the Dwell org). Make it **public** — GitHub
   Pages requires that on the free tier.
2. From the project folder:
   ```bash
   cd "Dwell Kids Scheduler"
   git init
   git add .
   git commit -m "Initial deploy"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/dwell-kids-scheduler.git
   git push -u origin main
   ```
3. On GitHub: **Settings** → **Pages**.
4. **Source**: Deploy from a branch. **Branch**: `main`, folder
   `/ (root)`. Click **Save**.
5. Wait ~30 seconds. Pages will publish at:
   `https://YOUR_USERNAME.github.io/dwell-kids-scheduler/`

That's the URL to share with Toddlers and Elementary builders.

---

## 7. Smoke-test before going live

Run through this end-to-end before the URL touches a real volunteer:

1. Open the published URL in your browser.
2. Click **Toddlers**. The grid should load within a couple of seconds.
   You should see 8 Sundays. Sundays where you've already created a
   PCO Plan show clickable cells; Sundays without a Plan show as
   greyed-out "Schedule not yet published".
3. Pick yourself from the **I'm…** dropdown.
4. Click any open Toddlers Leader cell.
5. The cell should switch to "You — confirmed" within ~2 seconds.
6. Open PCO → Services → Dwell Kids - Toddlers → that Sunday's plan.
   You should appear as Leader with status **C** (Confirmed). PCO will
   also send its standard "you've been scheduled" notification email
   (you can disable that in PCO if you want — Services → People → Team
   member settings).
7. Refresh the scheduler page. Your assignment should still be there.
8. Click yourself again on a different role to double-check.
9. Repeat for **Elementary** to confirm the Connections position works.

If anything fails, the **Execution log** in the Apps Script editor
(View → Executions) shows what the backend saw. Most issues are either
auth (re-check the `PCO_APP_ID` / `PCO_SECRET` properties) or wrong
IDs (re-run `listServiceTypes` and `listTeamsAndPositions`).

---

## Operational notes

**If a builder reports the page is broken.** First place to look:
Apps Script → **Executions** in the left sidebar. Each `doGet` and
`doPost` shows there with timing and any errors.

**If a builder needs to release a slot.** v1 doesn't expose a release
button. Open PCO → the plan → click the X next to their assignment.
The cell will show as open again on the next page refresh.

**If a builder isn't in the dropdown.** They aren't on that team in
PCO. Add them in Services → People → Teams → (kids team) → Add
person.

**If you change `Code.gs` after deploy.** Apps Script needs a redeploy
of the same web app version: Deploy → Manage deployments → ✏️ Edit →
Version: New version → Deploy. The web app URL stays the same.

**If you rotate the PCO token.** Re-do step 3 with the new App ID +
Secret. No code change needed.

---

## 8. Dashboard, plan extender, and Tuesday digest (added 2026-05-12)

Three new pieces ship alongside the scheduler:

- **Dashboard** (`dashboard.html`) — read-only view of every upcoming
  Sunday and which scheduler roles are filled, for both teams. Public
  URL is the GitHub Pages site + `/dashboard.html`.
- **Plan extender** (`extendPlans()` in `Code.gs`) — ensures a PCO Plan
  exists for each of the next 8 Sundays. Missing Sundays get a new
  Plan cloned from the most recent existing plan (title, series, and
  needed_positions copied; no people copied).
- **Tuesday digest** (`tuesdayDigest()` in `Code.gs`) — runs the
  extender, then emails `matt@dwellpeninsula.com` a fill-status table.

### 8a. Generate the write-endpoint token

The extender and digest are gated behind a token so a random visitor
can't trigger PCO writes or spam your inbox. To set it once:

1. In the Apps Script editor, paste this into a new ad-hoc function
   (or run from the Apps Script console) and click ▶ Run:
   ```js
   function setupDigestToken() {
     const token = Utilities.getUuid().replace(/-/g, '');
     PropertiesService.getScriptProperties().setProperty('DIGEST_TOKEN', token);
     Logger.log('DIGEST_TOKEN = ' + token);
   }
   ```
2. Copy the value from the Execution log. You'll paste it into the
   Cowork scheduled task in step 8c.
3. (You can also view/regenerate it later via Project Settings →
   Script Properties.)

### 8b. Redeploy the web app

After pasting the updated `Code.gs`:

1. **Deploy** → **Manage deployments** → ✏️ on the existing deployment.
2. **Version**: New version. **Description**: `v2 — dashboard + extender`.
3. **Deploy**.

The web app URL stays the same. You don't need to update `index.html`
or `dashboard.html`.

Smoke-test the new endpoints in your browser:
- `<URL>?action=dashboard` → should return JSON with `toddlers` and
  `elementary` keys.
- `<URL>?action=extendNow&token=<your DIGEST_TOKEN>` → should return
  JSON with `created`, `skipped`, and `errors` arrays. Re-run it
  immediately — `created` should be empty the second time (idempotent).
- `<URL>?action=runDigest&token=<your DIGEST_TOKEN>` → should return
  `{ ok: true, sent_to: "matt@dwellpeninsula.com" }` and you should
  receive the email within ~30 seconds.

### 8c. Wire up the Tuesday noon scheduled task in Cowork

A Cowork scheduled task fires at noon PT every Tuesday and calls the
`runDigest` endpoint via `web_fetch`. The task `dwell-kids-tuesday-digest`
is created by Obi when the dashboard is first set up; if you need to
update the URL or token later:

1. Open Cowork → Scheduled tasks.
2. Find `dwell-kids-tuesday-digest`.
3. Edit the prompt — the URL with token is embedded inline.

You can also click **Run now** on that task to trigger the digest
on demand (useful for testing or for catching a missed Tuesday).

### 8d. Push dashboard.html to GitHub Pages

After updating the repo locally:

```bash
cd "Dwell Kids Scheduler"
git add dashboard.html DEPLOY.md README.md apps-script/Code.gs
git commit -m "Add dashboard, plan extender, Tuesday digest"
git push
```

Pages will republish within ~30 seconds. The dashboard is then live at:
`https://YOUR_USERNAME.github.io/dwell-kids-scheduler/dashboard.html`

### 8e. Operational notes for the new pieces

**If the digest email doesn't arrive Tuesday.** Check Apps Script →
**Executions** for the `tuesdayDigest` run. If it didn't fire, check
the Cowork task's run history. Most common cause: the token in the
Cowork task URL doesn't match `DIGEST_TOKEN` in Script Properties
(you'll see a `forbidden` error in Executions).

**If the extender creates a duplicate plan.** Shouldn't happen
(idempotency check is by `sort_date.substring(0,10)`), but if PCO
returns a stale list and a duplicate sneaks through, delete the extra
in PCO → Services → (service type) → click the plan → ⋮ → Delete.

**If you want to change the 8-week horizon.** Edit
`EXTENDER_HORIZON_SUNDAYS` near the top of the extender section in
`Code.gs`, save, and redeploy. The dashboard and scheduler both
follow `HORIZON_SUNDAYS` (the scheduler's own constant) — adjust both
if you want them to match.

**If you want to add a third kids service type.** Add an entry to
`SERVICE_TYPES` and a matching `ROLES` row, then redeploy. The
dashboard, extender, and digest will pick it up automatically — no
other changes needed.
