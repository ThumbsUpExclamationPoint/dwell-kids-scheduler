/**
 * Dwell Kids Scheduler — backend
 *
 * Apps Script web app that powers the public scheduler page on
 * GitHub Pages. Talks to Planning Center Online (PCO) Services API
 * over Basic Auth using a Personal Access Token stored in
 * PropertiesService (server-side, never in the repo).
 *
 * Runs as Matt's Google account.
 *
 * Routes:
 *   GET  ?action=ping
 *   GET  ?action=board&team=toddlers|elementary
 *   POST action=claim
 *
 * See DEPLOY.md in the repo root for one-time setup.
 */

// =====================================================================
// Configuration — fill in IDs after running listServiceTypes() and
// listTeamsAndPositions() from Introspect.gs (see DEPLOY.md step 4).
// =====================================================================

/**
 * Service Type IDs in PCO. A Service Type is the top-level container
 * that holds Plans (one per Sunday) and Teams. Toddlers and Elementary
 * may be separate Service Types or sub-services of one parent — either
 * works as long as you put the correct IDs here.
 */
const SERVICE_TYPES = {
  toddlers:   '1732375',
  elementary: '1457667',
};

/**
 * Role config for each logical group (toddlers / elementary).
 *
 * Every role is one row mapping a friendly *display* name (what the
 * public page shows) to the underlying PCO Team ID + Position name
 * (what we POST to the PCO API). This indirection lets us:
 *
 *   - Show clean labels to volunteers ("Leader", "Culture Captain",
 *     "Connections") regardless of the verbose names PCO uses.
 *   - Span multiple PCO teams within one logical group — Elementary's
 *     Connections role lives on a *different* PCO team ("Dwell Kids
 *     Connections", id 5903663) than its Leader and Culture Captain
 *     ("Dwell Kids - Elementary", id 5903645). The scheduler hides
 *     that complexity from the volunteer.
 *
 * The order of rows here is the order shown in each Sunday card on
 * the public page.
 */
const ROLES = {
  toddlers: [
    { display: 'Leader',          team_id: '7124770', position: 'Teacher' },
    { display: 'Culture Captain', team_id: '7124770', position: 'Culture Captain' },
  ],
  elementary: [
    { display: 'Leader',          team_id: '5903645', position: 'Dwell Kids Elementary Leader' },
    { display: 'Culture Captain', team_id: '5903645', position: 'Dwell Kids - Culture Captains' },
    { display: 'Connections',     team_id: '5903663', position: 'Dwell Kids Greeter/Registration' },
  ],
};

/**
 * How many upcoming Sundays to show on the public page. We compute
 * the next N calendar Sundays from today. If a Plan exists in PCO for
 * that Sunday, the cell is bookable; if not, it shows greyed-out.
 */
const HORIZON_SUNDAYS = 8;

/**
 * PCO API base URL — the Services product.
 */
const PCO_BASE = 'https://api.planningcenteronline.com/services/v2';

// =====================================================================
// HTTP handlers
// =====================================================================

/**
 * GET routes.
 *   ?action=ping                      → health check (no PCO call)
 *   ?action=board&team=toddlers|...   → roster + 8 Sundays + assignments
 */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'ping')      return jsonResponse({ ok: true, msg: 'kids scheduler alive' });
    if (p.action === 'board')     return jsonResponse(handleBoard(p.team));
    if (p.action === 'dashboard') return jsonResponse(handleDashboard());
    if (p.action === 'extendNow') { requireDigestToken(p); return jsonResponse(extendPlans()); }
    if (p.action === 'runDigest') { requireDigestToken(p); return jsonResponse(tuesdayDigest()); }
    return textResponse('Dwell Kids Scheduler — alive.\nTry ?action=board&team=toddlers');
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * POST routes.
 *   action=claim → create a PlanPerson assignment in PCO
 *
 * The static page POSTs as multipart/form-data with mode "no-cors" so
 * it doesn't need CORS headers (Apps Script doesn't return them). The
 * page can't read the response body in no-cors mode, so it confirms
 * by re-fetching the board and checking the cell flipped.
 */
function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'claim') return jsonResponse(handleClaim(p));
    return jsonResponse({ ok: false, error: 'unknown action: ' + (p.action || '(none)') });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: String(err && err.message || err) });
  }
}

// =====================================================================
// Board: roster + sundays + assignments
// =====================================================================

/**
 * Build the board state for a team.
 *
 * Returns:
 *   {
 *     ok: true,
 *     team: 'toddlers',
 *     roster: [{ id, name }, ...],
 *     sundays: [
 *       {
 *         date: 'YYYY-MM-DD',
 *         plan_id: '12345' | null,
 *         slots: {
 *           'Leader':         { filled_by: { id, short_name } | null },
 *           'Culture Captain': { filled_by: ... }
 *         }
 *       },
 *       ...
 *     ]
 *   }
 */
function handleBoard(team) {
  if (!team || !SERVICE_TYPES[team]) {
    return { ok: false, error: 'unknown team: ' + team };
  }
  const stId  = SERVICE_TYPES[team];
  const roles = ROLES[team] || [];

  // 1. Roster — union of every PCO team referenced by this group's
  //    roles, deduped by Person ID. Most groups only touch one PCO
  //    team, but Elementary spans two (the main builders team plus
  //    the separate "Dwell Kids Connections" team for Greeters).
  const teamIds = uniq(roles.map(r => r.team_id));
  const peopleById = {};
  teamIds.forEach(tid => {
    const res = pcoGet('/teams/' + tid + '/people?per_page=100');
    (res.data || []).forEach(p => {
      const name = ((p.attributes.first_name || '') + ' ' + (p.attributes.last_name || '')).trim();
      if (name && !peopleById[p.id]) peopleById[p.id] = { id: p.id, name: name };
    });
  });
  const roster = Object.keys(peopleById).map(k => peopleById[k]);

  // 2. Upcoming plans — PCO's "future" filter returns plans with
  //    sort_date >= today, ordered chronologically.
  const plansRaw = pcoGet(
    '/service_types/' + stId + '/plans?filter=future&order=sort_date&per_page=' + (HORIZON_SUNDAYS + 4)
  );
  const plansBySunday = {};
  (plansRaw.data || []).forEach(plan => {
    const sortDate = plan.attributes.sort_date;
    if (!sortDate) return;
    const day = sortDate.substring(0, 10);  // 'YYYY-MM-DD' from ISO
    if (!plansBySunday[day]) plansBySunday[day] = plan.id;
  });

  // 3. Build the next N Sundays (today forward) as the canonical axis
  const sundayDates = computeUpcomingSundays(HORIZON_SUNDAYS);

  // 4. For each Sunday with a plan, fetch its team_members and figure
  //    out which slots are filled. Match each PlanPerson against our
  //    role list by (team_id + PCO position name) → display name.
  const sundays = sundayDates.map(date => {
    const planId = plansBySunday[date] || null;
    const slots = {};
    roles.forEach(r => { slots[r.display] = { filled_by: null }; });

    if (planId) {
      const tmRaw = pcoGet(
        '/service_types/' + stId + '/plans/' + planId + '/team_members?include=person&per_page=100'
      );
      const includedPeople = {};
      (tmRaw.included || []).forEach(inc => {
        if (inc.type === 'Person') includedPeople[inc.id] = inc.attributes;
      });

      (tmRaw.data || []).forEach(pp => {
        const teamRel = pp.relationships && pp.relationships.team && pp.relationships.team.data;
        const personRel = pp.relationships && pp.relationships.person && pp.relationships.person.data;
        if (!teamRel || !personRel) return;
        const pcoPosition = pp.attributes && pp.attributes.team_position_name;
        const status = (pp.attributes && pp.attributes.status) || '';
        if (!pcoPosition || status === 'D') return;

        // Find the role row whose (team_id, position) matches this
        // assignment. Anything outside the configured roles is not
        // ours and we skip it.
        const role = roles.find(r => r.team_id === teamRel.id && r.position === pcoPosition);
        if (!role) return;
        if (slots[role.display].filled_by) return; // first one wins

        const person = includedPeople[personRel.id];
        if (!person) return;
        slots[role.display].filled_by = {
          id: personRel.id,
          short_name: shortName(person.first_name, person.last_name),
        };
      });
    }

    return { date: date, plan_id: planId, slots: slots };
  });

  return { ok: true, team: team, roster: roster, sundays: sundays };
}

/**
 * Look up a role row by its display name within a group. Returns null
 * if the group/display pair is unknown (caller surfaces the error).
 */
function findRole(group, displayName) {
  const list = ROLES[group] || [];
  return list.find(r => r.display === displayName) || null;
}

/**
 * Dedupe a string array preserving order.
 */
function uniq(arr) {
  const seen = {};
  const out = [];
  arr.forEach(v => { if (!seen[v]) { seen[v] = true; out.push(v); } });
  return out;
}

// =====================================================================
// Claim: create a PlanPerson in PCO
// =====================================================================

/**
 * Atomically claim a slot. Body fields (form-encoded):
 *   action     : 'claim'
 *   team       : 'toddlers' | 'elementary'
 *   plan_id    : PCO Plan ID
 *   position   : 'Leader' | 'Culture Captain' | 'Connections'
 *   person_id  : PCO Person ID
 *
 * We hold a script-wide lock around the claim so two builders clicking
 * the same cell in the same second can't both win — the second one
 * sees the up-to-date state and is rejected with a clean error.
 */
function handleClaim(p) {
  const team       = p.team;
  const planId     = p.plan_id;
  const position   = p.position;   // display name from the public page
  const personId   = p.person_id;

  if (!team || !SERVICE_TYPES[team])  return { ok: false, error: 'unknown team' };
  if (!planId)                        return { ok: false, error: 'missing plan_id' };
  if (!position)                      return { ok: false, error: 'missing position' };
  if (!personId)                      return { ok: false, error: 'missing person_id' };

  const role = findRole(team, position);
  if (!role) return { ok: false, error: 'unknown role for team: ' + position };

  const stId = SERVICE_TYPES[team];

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'server busy, try again' };

  try {
    // Re-check inside the lock: is the slot actually open right now?
    // Catches the race where two browsers GET the same open cell and
    // both POST.
    const tmRaw = pcoGet(
      '/service_types/' + stId + '/plans/' + planId + '/team_members?per_page=100'
    );
    const alreadyFilled = (tmRaw.data || []).some(pp => {
      const teamRel = pp.relationships && pp.relationships.team && pp.relationships.team.data;
      if (!teamRel || teamRel.id !== role.team_id) return false;
      const status = (pp.attributes && pp.attributes.status) || '';
      if (status === 'D') return false;
      return pp.attributes && pp.attributes.team_position_name === role.position;
    });
    if (alreadyFilled) {
      return { ok: false, error: 'that slot was just claimed' };
    }

    // Create the PlanPerson record. PCO's JSON:API shape:
    //
    //   POST /service_types/{ST_ID}/plans/{plan_id}/team_members
    //   {
    //     "data": {
    //       "type": "PlanPerson",
    //       "attributes": {
    //         "team_position_name": "<PCO position name>",
    //         "status": "C"            // C=Confirmed (auto-confirm)
    //       },
    //       "relationships": {
    //         "person": { "data": { "type": "Person", "id": "..." } },
    //         "team":   { "data": { "type": "Team",   "id": "..." } }
    //       }
    //     }
    //   }
    const body = {
      data: {
        type: 'PlanPerson',
        attributes: {
          team_position_name: role.position,
          status: 'C',  // Confirmed — auto-confirm per spec
        },
        relationships: {
          person: { data: { type: 'Person', id: String(personId) } },
          team:   { data: { type: 'Team',   id: String(role.team_id) } },
        },
      },
    };
    const created = pcoPost(
      '/service_types/' + stId + '/plans/' + planId + '/team_members',
      body
    );

    return {
      ok: true,
      plan_person_id: created && created.data && created.data.id,
    };
  } finally {
    lock.releaseLock();
  }
}

// =====================================================================
// PCO API helpers
// =====================================================================

/**
 * Read the PCO credentials from PropertiesService. Throws a clear
 * error if they're not set (caller will surface it to the page or to
 * the Execution log).
 */
function pcoCredentials() {
  const props = PropertiesService.getScriptProperties();
  const appId  = props.getProperty('PCO_APP_ID');
  const secret = props.getProperty('PCO_SECRET');
  if (!appId || !secret) {
    throw new Error('PCO credentials missing — set PCO_APP_ID and PCO_SECRET in Project Settings → Script Properties.');
  }
  return { appId: appId, secret: secret };
}

/**
 * GET wrapper. Adds Basic Auth, parses JSON, retries once on 429.
 */
function pcoGet(path) {
  return pcoFetch('GET', path, null);
}

/**
 * POST wrapper. JSON body, Basic Auth, JSON response.
 */
function pcoPost(path, body) {
  return pcoFetch('POST', path, body);
}

/**
 * DELETE wrapper. Used by the introspection smoke test.
 */
function pcoDelete(path) {
  return pcoFetch('DELETE', path, null);
}

/**
 * Core HTTP wrapper for PCO API calls.
 *
 * - Adds Basic Auth from PropertiesService.
 * - Sends JSON for POST/PATCH bodies.
 * - Retries once on 429 (rate limit) after waiting per the
 *   Retry-After header (PCO returns it).
 * - Throws on non-2xx with a descriptive message including the
 *   PCO error body for debugging.
 */
function pcoFetch(method, path, body) {
  const cred = pcoCredentials();
  const url = path.startsWith('http') ? path : (PCO_BASE + path);

  const opts = {
    method: method.toLowerCase(),
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(cred.appId + ':' + cred.secret),
      Accept: 'application/json',
    },
    muteHttpExceptions: true,
    followRedirects: true,
  };
  if (body !== null && body !== undefined) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body);
  }

  let res = UrlFetchApp.fetch(url, opts);
  let code = res.getResponseCode();

  // Rate-limit retry. PCO's Retry-After header is in seconds.
  if (code === 429) {
    const retryAfter = parseInt(res.getHeaders()['Retry-After'] || '5', 10);
    Utilities.sleep((retryAfter + 1) * 1000);
    res = UrlFetchApp.fetch(url, opts);
    code = res.getResponseCode();
  }

  // 204 No Content (used by DELETE) has no body.
  if (code === 204) return { ok: true };

  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('PCO ' + method + ' ' + path + ' → ' + code + ' ' + text.substring(0, 500));
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('PCO returned non-JSON for ' + path + ': ' + text.substring(0, 200));
  }
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Compute the next N calendar Sundays in PT, today forward (inclusive
 * if today is Sunday). Returns an array of 'YYYY-MM-DD' strings.
 */
function computeUpcomingSundays(n) {
  const tz = 'America/Los_Angeles';
  const out = [];
  const d = new Date();
  // Roll forward to the next Sunday (or stay if today is Sunday)
  const dayOfWeek = parseInt(Utilities.formatDate(d, tz, 'u'), 10) % 7;
  // Apps Script's formatDate 'u' is 1..7 with Mon=1, Sun=7. Convert
  // to Sun=0..Sat=6.
  const daysUntilSunday = dayOfWeek === 0 ? 0 : (7 - dayOfWeek);
  d.setDate(d.getDate() + daysUntilSunday);

  for (let i = 0; i < n; i++) {
    out.push(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
    d.setDate(d.getDate() + 7);
  }
  return out;
}

/**
 * Render a person's display name for the public page. Uses first name
 * + last initial to keep it familiar without exposing the full last
 * name on a public URL.
 */
function shortName(first, last) {
  const f = (first || '').trim();
  const l = (last || '').trim();
  if (!f && !l) return 'Someone';
  if (!l) return f;
  return f + ' ' + l.charAt(0) + '.';
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function textResponse(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}

// =====================================================================
// Dashboard
// =====================================================================
//
// The dashboard reuses handleBoard() for each team and stitches the
// results together. This guarantees the dashboard and the scheduler
// page can never disagree about who's filled — they read from the same
// PCO state through the same code path.
//
// Returns:
//   {
//     ok: true,
//     generated_at: 'YYYY-MM-DDTHH:mm:ssZ',
//     teams: {
//       toddlers:   { roster, sundays },     // shape from handleBoard
//       elementary: { roster, sundays },
//     },
//   }
// =====================================================================

function handleDashboard() {
  const out = { ok: true, generated_at: new Date().toISOString(), teams: {} };
  Object.keys(SERVICE_TYPES).forEach(key => {
    const b = handleBoard(key);
    if (b && b.ok) {
      out.teams[key] = { roster: b.roster, sundays: b.sundays };
    } else {
      out.teams[key] = { error: (b && b.error) || 'unknown', roster: [], sundays: [] };
    }
  });
  return out;
}

// =====================================================================
// Plan Extender
// =====================================================================
//
// Ensures a PCO Plan exists for each of the next N Sundays for each
// Service Type. For any Sunday that's missing, creates a new Plan
// cloned from the most recent existing Plan in that Service Type.
//
// "Clone" here means:
//   - Inherit `title` and `series_title` from the template.
//   - Copy over `needed_positions` (headcount per team_position) so
//     PCO's "needs" view shows the right counts on the new plan.
//   - Do NOT copy plan_people (volunteer assignments) — each new
//     Sunday starts empty so volunteers can self-schedule via the
//     scheduler page.
//   - Do NOT copy plan_times — Apps Script can't reliably set times
//     across timezones in one shot; PCO's defaults will apply.
//
// Idempotent: re-running won't create duplicates. Safe to invoke from
// the Tuesday job, from the Apps Script editor, or from a manual URL
// trigger.
// =====================================================================

const EXTENDER_HORIZON_SUNDAYS = 8;

function extendPlans() {
  const summary = { ok: true, ran_at: new Date().toISOString(), created: [], skipped: [], errors: [] };

  const targetSundays = computeUpcomingSundays(EXTENDER_HORIZON_SUNDAYS);

  Object.keys(SERVICE_TYPES).forEach(teamKey => {
    const stId = SERVICE_TYPES[teamKey];
    try {
      // 1. Map of existing future plans by sort_date ('YYYY-MM-DD').
      const futureRes = pcoGet(
        '/service_types/' + stId + '/plans?filter=future&order=sort_date&per_page=' + (EXTENDER_HORIZON_SUNDAYS + 4)
      );
      const existingDates = {};
      (futureRes.data || []).forEach(p => {
        const sd = p.attributes && p.attributes.sort_date;
        if (sd) existingDates[sd.substring(0, 10)] = p.id;
      });

      // 2. Template plan = most recent past plan in this service type.
      //    Falls back to the earliest future plan if no past plan exists
      //    (cold-start case — fresh service type).
      const template = getTemplatePlan(stId);
      const templatePositions = template
        ? getNeededPositions(stId, template.id)
        : [];

      // 3. For each target Sunday: create if missing.
      targetSundays.forEach(date => {
        if (existingDates[date]) {
          summary.skipped.push({ team: teamKey, date: date, plan_id: existingDates[date] });
          return;
        }
        try {
          const created = createPlanForDate(stId, date, template);
          if (templatePositions.length > 0) {
            copyNeededPositions(stId, created.id, templatePositions);
          }
          summary.created.push({
            team: teamKey,
            date: date,
            plan_id: created.id,
            positions_copied: templatePositions.length,
          });
        } catch (err) {
          summary.errors.push({
            team: teamKey,
            date: date,
            error: String(err && err.message || err),
          });
        }
      });
    } catch (err) {
      summary.errors.push({ team: teamKey, error: String(err && err.message || err) });
    }
  });

  if (summary.errors.length > 0) summary.ok = false;
  return summary;
}

/**
 * Find a Plan to use as the cloning template for a given Service Type.
 * Prefers the most recent past plan; falls back to the earliest future
 * plan if there's no history yet.
 */
function getTemplatePlan(stId) {
  // Most recent past plan, descending so first row is freshest.
  const past = pcoGet(
    '/service_types/' + stId + '/plans?filter=past&order=-sort_date&per_page=3'
  );
  if (past.data && past.data.length > 0) {
    return past.data[0];
  }
  const future = pcoGet(
    '/service_types/' + stId + '/plans?filter=future&order=sort_date&per_page=1'
  );
  if (future.data && future.data.length > 0) {
    return future.data[0];
  }
  return null;
}

/**
 * Get the needed_positions for a plan as raw PCO records. Caller will
 * re-POST these against a new plan with copyNeededPositions().
 */
function getNeededPositions(stId, planId) {
  const res = pcoGet(
    '/service_types/' + stId + '/plans/' + planId + '/needed_positions?per_page=100'
  );
  return res.data || [];
}

/**
 * Create a new Plan inside the given Service Type for a given Sunday.
 *
 * PCO API gotcha #1: `sort_date` and `dates` are read-only — passing
 * them on create returns 422 "Forbidden Attribute". PCO computes
 * sort_date from the plan's plan_times.
 *
 * PCO API gotcha #2 (v3 → v4 lesson): cloning the template plan's
 * plan_times with a date shift looks correct but is brittle — the
 * shift silently misfires on some service types (toddlers in our
 * case), leaving the new plan without a sort_date. A dateless plan
 * is invisible to `filter=future`, which causes the next extender
 * run to think the date is missing and create a duplicate.
 *
 * v4 approach: always set a fixed 10:00–11:30 PT Sunday service time
 * on creation. Predictable, no template-shape dependencies. Matt can
 * edit individual plan times in PCO if any date needs adjustment.
 *
 * Three writes per plan, with verification:
 *   1. POST /plans                — empty plan (title/series cloned)
 *   2. POST /plan_times           — Sunday 10:00 PT service time
 *   3. GET  /plans/{id} (verify)  — confirm sort_date is set
 * If step 3 finds no sort_date, the half-created plan is deleted so
 * PCO stays clean, and the function throws a descriptive error that
 * lands in the extender's `errors[]` list and the digest email.
 */
function createPlanForDate(stId, dateYmd, template) {
  // ----- Step 1: create the plan (no date attrs) -----
  const attrs = {};
  if (template && template.attributes) {
    if (template.attributes.title)        attrs.title        = template.attributes.title;
    if (template.attributes.series_title) attrs.series_title = template.attributes.series_title;
  }
  const res = pcoPost(
    '/service_types/' + stId + '/plans',
    { data: { type: 'Plan', attributes: attrs } }
  );
  if (!res || !res.data || !res.data.id) {
    throw new Error('PCO create-plan returned no id');
  }
  const newPlanId = res.data.id;

  // ----- Step 2: add a fixed Sunday 10:00-11:30 PT service time -----
  // -08:00 offset is winter-time; PCO normalizes to UTC server-side
  // and the rendered time in PCO's UI is based on the user's timezone.
  // PDT/PST drift is not our problem; the plan lands on the right
  // Sunday in PT either way.
  try {
    addPlanTime(
      stId,
      newPlanId,
      dateYmd + 'T10:00:00-08:00',
      dateYmd + 'T11:30:00-08:00',
      'service'
    );
  } catch (err) {
    // If we can't add a plan_time, the plan is useless to us — clean it up.
    safeDeletePlan(stId, newPlanId);
    throw new Error('plan_time add failed for ' + dateYmd + ' — created plan ' + newPlanId + ' was rolled back: ' + (err && err.message || err));
  }

  // ----- Step 3: verify PCO computed sort_date from our plan_time -----
  // A 500ms pause gives PCO a beat to propagate the plan_time into
  // sort_date. Empirically PCO is usually instant, but we saw a case
  // where toddlers plans showed up dateless without a brief wait.
  Utilities.sleep(500);
  const verify = pcoGet('/service_types/' + stId + '/plans/' + newPlanId);
  const sortDate = verify && verify.data && verify.data.attributes && verify.data.attributes.sort_date;
  if (!sortDate) {
    // Plan exists but has no date — would create duplicates next run.
    // Roll it back so PCO stays clean and the error surfaces clearly.
    safeDeletePlan(stId, newPlanId);
    throw new Error('plan ' + newPlanId + ' for ' + dateYmd + ' has no sort_date after plan_time create — rolled back; investigate in Apps Script Executions');
  }
  if (sortDate.substring(0, 10) !== dateYmd) {
    // Plan landed on a different day than expected (unusual — should
    // only happen if PCO's timezone interpretation differs from ours).
    // Don't roll back, just log; the plan is real, just on a slightly
    // off date.
    console.warn('createPlanForDate: plan ' + newPlanId + ' landed on ' + sortDate.substring(0, 10) + ' instead of target ' + dateYmd);
  }

  return { id: newPlanId, attributes: res.data.attributes };
}

/**
 * Best-effort delete of a plan. Used to clean up after a half-created
 * plan when we hit a downstream error. Swallows errors — we're already
 * in an error path and the caller's exception is the one that matters.
 */
function safeDeletePlan(stId, planId) {
  try {
    pcoDelete('/service_types/' + stId + '/plans/' + planId);
  } catch (err) {
    console.warn('safeDeletePlan: failed to delete plan ' + planId + ': ' + (err && err.message || err));
  }
}

/**
 * Create one plan_time on the given plan. starts_at is required;
 * ends_at is optional (PCO will compute a default if omitted).
 * time_type is one of: 'service' | 'rehearsal' | 'other'.
 */
function addPlanTime(stId, planId, startsAt, endsAt, timeType) {
  const attrs = {
    starts_at: startsAt,
    time_type: timeType || 'service',
  };
  if (endsAt) attrs.ends_at = endsAt;
  return pcoPost(
    '/service_types/' + stId + '/plans/' + planId + '/plan_times',
    { data: { type: 'PlanTime', attributes: attrs } }
  );
}

/**
 * Copy each needed_position from the template into the new plan. We
 * POST one at a time — PCO doesn't support bulk create here. Errors
 * on individual positions are swallowed (logged) so one bad position
 * doesn't block the rest; the plan itself is the important thing.
 */
function copyNeededPositions(stId, newPlanId, sourcePositions) {
  sourcePositions.forEach(np => {
    try {
      const teamRel = np.relationships && np.relationships.team && np.relationships.team.data;
      if (!teamRel) return;
      const body = {
        data: {
          type: 'NeededPosition',
          attributes: {
            quantity: (np.attributes && np.attributes.quantity) || 1,
            team_position_name: np.attributes && np.attributes.team_position_name,
          },
          relationships: {
            team: { data: { type: 'Team', id: teamRel.id } },
          },
        },
      };
      pcoPost(
        '/service_types/' + stId + '/plans/' + newPlanId + '/needed_positions',
        body
      );
    } catch (err) {
      console.warn('copyNeededPositions: skipped one — ' + (err && err.message || err));
    }
  });
}

// =====================================================================
// Tuesday Digest
// =====================================================================
//
// Runs the extender, fetches the resulting dashboard state, and emails
// a fill-status digest to Matt. The email shows every upcoming Sunday
// per team, every scheduler role per Sunday, and who (if anyone) is in
// each slot.
//
// Triggered by the Cowork scheduled task at Tuesday 12:00 PT via the
// runDigest URL (see DEPLOY.md). Also callable manually from the Apps
// Script editor by running this function with no arguments.
// =====================================================================

const DIGEST_RECIPIENT = 'matt@dwellpeninsula.com';

function tuesdayDigest() {
  const extendResult = extendPlans();
  const dashboard    = handleDashboard();
  const html = buildDigestHtml(dashboard, extendResult);

  const tz = 'America/Los_Angeles';
  const stamp = Utilities.formatDate(new Date(), tz, 'EEEE, MMM d');
  const subject = 'Dwell Kids fill status — ' + stamp;

  MailApp.sendEmail({
    to: DIGEST_RECIPIENT,
    subject: subject,
    htmlBody: html,
    name: 'Dwell Kids Scheduler',
  });

  return {
    ok: true,
    sent_to: DIGEST_RECIPIENT,
    extend: extendResult,
  };
}

/**
 * Build the HTML body for the digest email. Keep this inline-styled
 * (Gmail strips <style> tags) and avoid external resources so it
 * renders the same in any mail client.
 */
function buildDigestHtml(dashboard, extendResult) {
  const css = {
    body:   'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;color:#1f2937;max-width:680px;margin:0 auto;padding:16px;',
    h1:     'font-size:20px;font-weight:600;margin:0 0 4px;color:#111827;',
    sub:    'font-size:13px;color:#6b7280;margin:0 0 24px;',
    teamH:  'font-size:16px;font-weight:600;margin:24px 0 8px;color:#111827;border-bottom:2px solid #00cccc;padding-bottom:4px;',
    table:  'width:100%;border-collapse:collapse;font-size:13px;',
    th:     'text-align:left;padding:8px 10px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-weight:600;color:#374151;',
    td:     'padding:8px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top;',
    dateTd: 'padding:8px 10px;border-bottom:1px solid #f3f4f6;font-weight:500;color:#111827;white-space:nowrap;',
    filled: 'color:#15803d;',
    empty:  'color:#b91c1c;font-weight:500;',
    noplan: 'color:#9ca3af;font-style:italic;',
    foot:   'font-size:12px;color:#9ca3af;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px;',
    pill:   'display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;',
    pillOk: 'background:#dcfce7;color:#15803d;',
    pillNo: 'background:#fee2e2;color:#b91c1c;',
  };

  const teamLabels = { toddlers: 'Toddlers', elementary: 'Elementary' };

  let html = '<div style="' + css.body + '">';
  html += '<h1 style="' + css.h1 + '">Dwell Kids — fill status</h1>';
  html += '<p style="' + css.sub + '">Generated ' + new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT.</p>';

  // Extender summary banner
  const createdCount = (extendResult && extendResult.created || []).length;
  const errorCount   = (extendResult && extendResult.errors  || []).length;
  if (createdCount > 0 || errorCount > 0) {
    let banner = '<div style="background:#f0fdfd;border:1px solid #00cccc;border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:13px;">';
    if (createdCount > 0) banner += '<strong>+' + createdCount + ' new plan' + (createdCount === 1 ? '' : 's') + ' created</strong> by the extender.<br>';
    if (errorCount > 0)   banner += '<span style="color:#b91c1c"><strong>' + errorCount + ' error' + (errorCount === 1 ? '' : 's') + '</strong> while extending — check Apps Script logs.</span>';
    banner += '</div>';
    html += banner;
  }

  Object.keys(dashboard.teams || {}).forEach(teamKey => {
    const team = dashboard.teams[teamKey];
    const label = teamLabels[teamKey] || teamKey;
    html += '<h2 style="' + css.teamH + '">' + escapeForHtml(label) + '</h2>';

    if (team.error) {
      html += '<p style="' + css.empty + '">Couldn\'t load: ' + escapeForHtml(team.error) + '</p>';
      return;
    }

    const sundays = team.sundays || [];
    if (sundays.length === 0) {
      html += '<p style="' + css.noplan + '">No upcoming Sundays found.</p>';
      return;
    }

    // Discover role columns from the first Sunday (all rows have same keys)
    const roleNames = Object.keys(sundays[0].slots || {});

    html += '<table style="' + css.table + '">';
    html += '<thead><tr><th style="' + css.th + '">Sunday</th>';
    roleNames.forEach(rn => { html += '<th style="' + css.th + '">' + escapeForHtml(rn) + '</th>'; });
    html += '</tr></thead><tbody>';

    sundays.forEach(s => {
      html += '<tr>';
      html += '<td style="' + css.dateTd + '">' + formatDigestDate(s.date) + '</td>';
      roleNames.forEach(rn => {
        const slot = (s.slots || {})[rn] || {};
        let cell;
        if (!s.plan_id) {
          cell = '<span style="' + css.noplan + '">no plan</span>';
        } else if (slot.filled_by) {
          cell = '<span style="' + css.filled + '">' + escapeForHtml(slot.filled_by.short_name) + '</span>';
        } else {
          cell = '<span style="' + css.pill + ' ' + css.pillNo + '">unfilled</span>';
        }
        html += '<td style="' + css.td + '">' + cell + '</td>';
      });
      html += '</tr>';
    });

    html += '</tbody></table>';

    // Per-team fill summary
    const totalCells = sundays.reduce((acc, s) => acc + (s.plan_id ? roleNames.length : 0), 0);
    const filledCells = sundays.reduce((acc, s) => {
      if (!s.plan_id) return acc;
      return acc + roleNames.reduce((a, rn) => a + ((s.slots[rn] && s.slots[rn].filled_by) ? 1 : 0), 0);
    }, 0);
    if (totalCells > 0) {
      const pct = Math.round(100 * filledCells / totalCells);
      const pillClass = filledCells === totalCells ? css.pillOk : css.pillNo;
      html += '<p style="font-size:12px;color:#6b7280;margin:6px 0 0;">' +
              '<span style="' + css.pill + ' ' + pillClass + '">' + filledCells + ' / ' + totalCells + ' filled (' + pct + '%)</span>' +
              '</p>';
    }
  });

  html += '<p style="' + css.foot + '">';
  html += 'Dwell Kids Scheduler &middot; auto-sent every Tuesday at noon PT.<br>';
  html += 'To stop, disable the <em>dwell-kids-tuesday-digest</em> task in Cowork.';
  html += '</p></div>';
  return html;
}

/**
 * Format 'YYYY-MM-DD' as "Sun, May 17" for the digest table. Parses
 * components manually to avoid the UTC off-by-one trap that bites
 * server-side date string parsing.
 */
function formatDigestDate(ymd) {
  const parts = ymd.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return Utilities.formatDate(d, 'America/Los_Angeles', 'EEE, MMM d');
}

function escapeForHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =====================================================================
// Auth helper for write endpoints
// =====================================================================
//
// Anything that creates PCO plans or sends email lives behind a token
// stored in PropertiesService. The Cowork scheduled task carries the
// token in its URL. If the token is wrong or missing, the request 403s.
//
// Generate the token once with:
//   PropertiesService.getScriptProperties()
//     .setProperty('DIGEST_TOKEN', Utilities.getUuid().replace(/-/g, ''));
// and copy the value into the Cowork scheduled task. See DEPLOY.md.
// =====================================================================

function requireDigestToken(p) {
  const expected = PropertiesService.getScriptProperties().getProperty('DIGEST_TOKEN');
  if (!expected) {
    throw new Error('DIGEST_TOKEN not configured — set it in Script Properties.');
  }
  if (!p || p.token !== expected) {
    throw new Error('forbidden: bad or missing token');
  }
}

/**
 * One-time setup helper. Run this once from the Apps Script editor
 * after pasting in the new Code.gs to mint a random DIGEST_TOKEN and
 * store it in Script Properties. The token will print to the
 * Execution log — copy it into the Cowork scheduled task URL.
 *
 * Safe to re-run: regenerates the token and prints the new value.
 * Anyone using the old token (the Cowork task) will get `forbidden`
 * until you update them.
 */
function setupDigestToken() {
  const token = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('DIGEST_TOKEN', token);
  Logger.log('DIGEST_TOKEN = ' + token);
  Logger.log('Copy that value into the Cowork scheduled task URL.');
  return token;
}
