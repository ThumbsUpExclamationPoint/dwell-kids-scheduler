/**
 * One-time introspection helpers — run these from the Apps Script
 * editor (function dropdown → ▶ Run) to discover the Service Type,
 * Team, and Position IDs you need to paste into the CONFIG block at
 * the top of Code.gs.
 *
 * None of these are called by the web app at runtime. They exist
 * solely so Matt (or future Obi instances debugging the app) can
 * quickly see what's in the PCO account without leaving Apps Script.
 */

// =====================================================================
// Authorization + connectivity check
// =====================================================================

/**
 * Run this first. It hits the PCO API once with the stored credentials
 * to make sure they're correct, and triggers Apps Script's permission
 * dialog so all needed scopes (UrlFetchApp, Properties) are granted.
 */
function pcoAuthorize() {
  const props = PropertiesService.getScriptProperties();
  const appId  = props.getProperty('PCO_APP_ID');
  const secret = props.getProperty('PCO_SECRET');
  if (!appId || !secret) {
    throw new Error(
      'PCO credentials missing. Open Project Settings (gear ⚙ in left sidebar) → Script Properties → add PCO_APP_ID and PCO_SECRET.'
    );
  }
  const ping = pcoGet('/service_types?per_page=1');
  const total = (ping.meta && ping.meta.total_count) || (ping.data || []).length;
  console.log('PCO API reached successfully.');
  console.log('Service Types in this account: ' + total);
  console.log('Next: run listServiceTypes() to see them all.');
}

// =====================================================================
// Service Types
// =====================================================================

/**
 * Print every Service Type in the account. Find the IDs for the two
 * Dwell Kids service types and paste them into SERVICE_TYPES in
 * Code.gs.
 */
function listServiceTypes() {
  const res = pcoGet('/service_types?per_page=100');
  console.log('Found ' + (res.data || []).length + ' service types:');
  (res.data || []).forEach(st => {
    const parent = st.relationships && st.relationships.parent && st.relationships.parent.data;
    const parentNote = parent ? '  parent=' + parent.id : '  parent=null';
    console.log(
      '  ' + (st.attributes.name || '(unnamed)') +
      '  id=' + st.id +
      parentNote
    );
  });
  console.log('\nPaste the two kids Service Type IDs into SERVICE_TYPES in Code.gs:');
  console.log('  toddlers:   \'<id>\',');
  console.log('  elementary: \'<id>\',');
}

// =====================================================================
// Teams + Positions
// =====================================================================

/**
 * For each kids Service Type configured in Code.gs (after step 4b),
 * print all its Teams and the Positions within each Team. Find the
 * "Toddlers Builders" / "Elementary Builders" team IDs and confirm
 * the Position names.
 *
 * If you haven't filled in SERVICE_TYPES yet, this will tell you to.
 */
function listTeamsAndPositions() {
  const placeholders = Object.keys(SERVICE_TYPES).filter(k =>
    String(SERVICE_TYPES[k]).startsWith('REPLACE')
  );
  if (placeholders.length > 0) {
    throw new Error(
      'Fill in SERVICE_TYPES first (run listServiceTypes() and copy the IDs into Code.gs).'
    );
  }

  Object.keys(SERVICE_TYPES).forEach(team => {
    const stId = SERVICE_TYPES[team];
    console.log('\n=== ' + team.toUpperCase() + ' (Service Type ' + stId + ') ===');
    const teamsRes = pcoGet('/service_types/' + stId + '/teams?per_page=100');
    (teamsRes.data || []).forEach(t => {
      console.log('  Team: ' + t.attributes.name + '  id=' + t.id);
      const posRes = pcoGet('/teams/' + t.id + '/team_positions?per_page=100');
      (posRes.data || []).forEach(p => {
        console.log('    - Position: ' + p.attributes.name + '  id=' + p.id);
      });
    });
  });

  console.log('\nPaste the Builders team IDs into TEAMS in Code.gs.');
  console.log('Confirm POSITIONS exactly matches the position names above (case-sensitive).');
}

// =====================================================================
// Roster
// =====================================================================

/**
 * Print the people on each kids Builders team. These are exactly the
 * people who will appear in the public "I'm…" dropdown. Use this to
 * confirm the rosters look right before going live.
 */
function listRosters() {
  const placeholders = Object.keys(TEAMS).filter(k =>
    String(TEAMS[k]).startsWith('REPLACE')
  );
  if (placeholders.length > 0) {
    throw new Error('Fill in TEAMS first (run listTeamsAndPositions()).');
  }

  Object.keys(TEAMS).forEach(team => {
    const teamId = TEAMS[team];
    console.log('\n=== ' + team.toUpperCase() + ' roster (team ' + teamId + ') ===');
    const res = pcoGet('/teams/' + teamId + '/people?per_page=100');
    const people = (res.data || []).map(p =>
      ((p.attributes.first_name || '') + ' ' + (p.attributes.last_name || '')).trim()
    ).sort();
    people.forEach(name => console.log('  - ' + name));
    console.log('Total: ' + people.length);
  });
}

// =====================================================================
// Smoke test: claim + immediately delete a real PlanPerson
// =====================================================================

/**
 * End-to-end test of the claim path. Picks the first available
 * Toddlers plan + first roster member + 'Leader' position, creates a
 * PlanPerson, then deletes it. If this passes without error, the
 * production claim flow will work for real claims.
 *
 * Safe to re-run — the assignment is deleted immediately. If something
 * fails partway through, the assignment may persist in PCO; check the
 * Toddlers plan for a stray entry from "smoke test" and remove if
 * needed (the log prints the PlanPerson ID created).
 */
function smokeTestClaim() {
  const team = 'toddlers';
  const stId = SERVICE_TYPES[team];
  const teamId = TEAMS[team];

  if (String(stId).startsWith('REPLACE') || String(teamId).startsWith('REPLACE')) {
    throw new Error('Fill in SERVICE_TYPES and TEAMS first.');
  }

  // 1. Find the first available plan
  const plansRes = pcoGet(
    '/service_types/' + stId + '/plans?filter=future&order=sort_date&per_page=5'
  );
  const plan = (plansRes.data || [])[0];
  if (!plan) throw new Error('No future plans found for ' + team + ' — create one in PCO first.');
  console.log('Using plan: id=' + plan.id + '  sort_date=' + plan.attributes.sort_date);

  // 2. Find the first roster member
  const peopleRes = pcoGet('/teams/' + teamId + '/people?per_page=5');
  const person = (peopleRes.data || [])[0];
  if (!person) throw new Error('No people found on team ' + teamId + ' — add at least one builder in PCO.');
  const personName = ((person.attributes.first_name || '') + ' ' + (person.attributes.last_name || '')).trim();
  console.log('Using person: id=' + person.id + '  ' + personName);

  // 3. Create the PlanPerson
  const position = (POSITIONS[team] || ['Leader'])[0];
  const body = {
    data: {
      type: 'PlanPerson',
      attributes: {
        team_position_name: position,
        status: 'C',
      },
      relationships: {
        person: { data: { type: 'Person', id: String(person.id) } },
        team:   { data: { type: 'Team',   id: String(teamId)    } },
      },
    },
  };
  const created = pcoPost(
    '/service_types/' + stId + '/plans/' + plan.id + '/team_members',
    body
  );
  const ppId = created && created.data && created.data.id;
  if (!ppId) {
    throw new Error('Create succeeded but no PlanPerson ID returned: ' + JSON.stringify(created).substring(0, 300));
  }
  console.log('Created PlanPerson id=' + ppId + '  ' + personName + ' as ' + position);

  // 4. Delete it
  pcoDelete(
    '/service_types/' + stId + '/plans/' + plan.id + '/team_members/' + ppId
  );
  console.log('Deleted PlanPerson ' + ppId);
  console.log('\nsmoke test passed — claim flow is wired up correctly.');
}
