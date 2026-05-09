# Dwell Kids Scheduler

A static GitHub Pages site that lets Dwell Kids volunteers ("Builders")
self-schedule for upcoming Sundays. Bookings are written straight back
into Planning Center Online (PCO) so PCO stays the system of record —
nobody on staff has to copy data between systems.

## Architecture

```
            ┌──────────────────────────────────────────┐
            │        Public scheduler page              │
            │        (index.html on GitHub Pages)       │
            └─────────────────────┬────────────────────┘
                                  │ GET ?action=board&team=...
                                  │ POST action=claim
                                  ▼
            ┌──────────────────────────────────────────┐
            │        Apps Script web app (Code.gs)      │
            │        runs as matt@dwellpeninsula.com    │
            │        holds the PCO PAT in Properties    │
            └─────────────────────┬────────────────────┘
                                  │ Basic Auth (App ID + Secret)
                                  ▼
            ┌──────────────────────────────────────────┐
            │      Planning Center Online — Services    │
            │      api.planningcenteronline.com/v2      │
            └──────────────────────────────────────────┘
```

The static page never touches the PCO token. The Apps Script middleware
is the only thing that holds the credential, which means the token
never leaks to the public repo or to anyone who views page source.

## Two teams, five role-slots per Sunday

| Team | Positions | People per Sunday |
|------|-----------|-------------------|
| Toddlers | Leader, Culture Captain | 1 each |
| Elementary | Leader, Culture Captain, Connections | 1 each |

Builders only see Sundays they could actually pick — i.e. Sundays where
the corresponding *Plan* (the per-Sunday record in PCO that holds the
team list) already exists. Sundays without a Plan show as greyed-out
"Schedule not yet published" so builders know it's coming and you know
which dates are waiting on you.

## Repo layout

```
dwell-kids-scheduler/
├── index.html                  # public scheduler page (no login, no gate)
├── assets/
│   └── dwell-icon.png          # brand icon, lifted from the Interview Hub
├── apps-script/
│   ├── Code.gs                 # PCO middleware (production)
│   └── Introspect.gs           # one-time helpers to discover PCO IDs
├── DEPLOY.md                   # step-by-step setup (~15 min)
└── README.md                   # this file
```

## How a claim works

1. Builder lands on the page and picks their team.
2. The page calls Apps Script's `/exec?action=board&team=...`
   endpoint, which in turn calls PCO and returns:
   - the roster (people on that team in PCO — only they appear in the
     "I'm…" dropdown)
   - the next 8 Sundays + each Sunday's plan ID (or null if Plan missing)
   - current assignments per role slot
3. Builder picks themselves from the dropdown and clicks an open cell.
4. The page POSTs `action=claim` with the team, plan ID, position
   ("Leader" / "Culture Captain" / "Connections"), and PCO person ID.
5. Apps Script grabs a script-wide lock, re-checks that the slot is
   still open (race-condition guard), POSTs a `PlanPerson` record to
   PCO with status `"C"` (confirmed), releases the lock, and returns
   success.
6. The page re-fetches the board to confirm and shows the new state.

## Where state lives

| What | Where |
|------|-------|
| Service Type / Team / Position IDs | `CONFIG` block in `apps-script/Code.gs` |
| PCO Application ID + Secret | Apps Script `PropertiesService` (server-side, never in the repo) |
| Roster (who can be assigned) | PCO Team Members for each team — fetched live |
| Plans (the Sundays) | PCO Service Types — fetched live |
| Assignments | PCO Plan People — written live |

Nothing about volunteer scheduling lives in our own database. PCO is
the source of truth.

## Security posture

- The PCO Personal Access Token never reaches the static page. It lives
  in Apps Script `PropertiesService`, accessible only to Matt.
- The page is public — anyone with the URL can hit the API. The roster
  dropdown only shows people already on the team in PCO, so nobody can
  schedule themselves into a team they're not approved for. They could
  schedule someone else from the approved list (impersonation), but the
  blast radius is just "wrong person on a Sunday" — recoverable, and
  PCO's email notifications will surface it fast.
- Both the request and the response carry minimal personal data
  (first names + last initials for filled slots; full name only when a
  builder identifies themselves). No phone numbers or emails are
  exposed via the page.

## Phase 2 ideas (later)

- Self-serve "release my slot" — currently builders have to ask Matt or
  Jenny to swap out. The API supports DELETE on PlanPerson; the UI just
  doesn't expose it yet.
- Auto-create Plans from a template when a builder books a Sunday that
  doesn't have a Plan yet (option C from the original spec call).
- Email notifications to the builder when they claim a slot ("Confirmed
  for Sunday June 14 — Toddlers Leader").
- Quarterly availability painting (builders pre-mark Sundays they can't
  do, and the page hides those cells for them).

The static-page + Apps Script + PCO architecture handles all of these
without a redesign.

## See also

- [DEPLOY.md](DEPLOY.md) — step-by-step setup, ~15 min total.
