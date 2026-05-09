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
    if (p.action === 'ping')  return jsonResponse({ ok: true, msg: 'kids scheduler alive' });
    if (p.action === 'board') return jsonResponse(handleBoard(p.team));
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
