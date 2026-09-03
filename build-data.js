// Rebuilds data.json from the official FPL API. Run daily by the GitHub Action.
// v3: xMins model with per-player priors from LAST SEASON (element-summary history), SOS-adjusted,
// penalty & DEFCON aware, appearance pts banked, plus the family team.
const TEAM_ID = 33616; // his FPL team

const get = async u => (await fetch(u, {headers:{'User-Agent':'fpl-maths-lab'}})).json();

// --- the mini model ---------------------------------------------------------
// Attack multiplier by fixture difficulty (easy games boost goals/assists)
const ATT = {2:1.25, 3:1.0, 4:0.8, 5:0.62};
// Clean-sheet probability by fixture difficulty
const CS  = {2:0.42, 3:0.30, 4:0.20, 5:0.12};
const GOAL_PTS = {1:10, 2:6, 3:5, 4:4};
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));

// per-90 priors by position (typical rates) — fallbacks for players with no PL history
const XG_PRIOR = {1:0, 2:0.05, 3:0.18, 4:0.38};
const XA_PRIOR = {1:0.01, 2:0.06, 3:0.15, 4:0.10};
const DC_PRIOR = {1:0, 2:6.5, 3:5, 4:2.5};      // typical defensive actions per 90
const DC_THRESH = {2:10, 3:12, 4:12};           // DEFCON: actions needed for 2 pts
const PRIOR_MINS = 600;   // how much "last season evidence" counts, in pseudo-minutes
function makeModel(gamesByTeam, sosByTeam, priors){
  return function ep(p, diff){
    const n = Math.max(1, gamesByTeam[p.team] || 1);
    const sos = sosByTeam[p.team] || 1;              // how easy their past fixtures were (1 = average)
    const pr = priors[p.id];
    // expected minutes: this season's average, FILLED UP by last season's minutes-per-game when the
    // current sample is thin (aggressive recency: history counts as 1 game and never drags a
    // current starter down — being benched last year shouldn't punish this year's first choice)
    const avail = p.chance_of_playing_next_round == null ? 1 : p.chance_of_playing_next_round/100;
    const prevPerGame = pr ? pr.mins/38 : 0;
    const thisAvg = p.minutes / n;
    const blended = (p.minutes + prevPerGame) / (n + (pr?1:0));
    const xMins = clamp(Math.max(thisAvg, blended), 0, 94) * avail;
    if (xMins < 5) return {ep:0.3, xMins:Math.round(xMins)};
    const p60   = clamp((xMins-30)/45, 0, 1);          // chance of playing 60+
    const pPlay = clamp(xMins/40, 0, 1);               // chance of playing at all
    const appear = 1*pPlay + 1*p60;                    // 1pt for playing, 2pts if 60+
    // personal priors: last season's own rates (lightly regressed), else positional averages
    const wPrev = pr ? Math.min(1, pr.mins/900) : 0;          // trust last season only with a real sample
    const per90prev = v => (pr && pr.mins>0) ? v/pr.mins*90 : 0;
    const priorG  = wPrev*0.85*per90prev(pr?pr.g:0)  + (1-wPrev)*XG_PRIOR[p.element_type];
    const priorA  = wPrev*0.85*per90prev(pr?pr.a:0)  + (1-wPrev)*XA_PRIOR[p.element_type];
    const priorDC = wPrev*0.9 *per90prev(pr?pr.dc:0) + (1-wPrev)*DC_PRIOR[p.element_type];
    // this season's rates (SOS-adjusted), shrunk toward the personal prior; recent games weigh most
    const shrunk = (v, prior, cap) => Math.min(Math.max(cap, prior*1.3), (v + prior*(PRIOR_MINS/90)) / (p.minutes + PRIOR_MINS) * 90);
    let xG90 = shrunk((parseFloat(p.expected_goals||0))/sos,   priorG, p.element_type===4?1.15:0.8);
    // first-choice penalty takers carry hidden goal threat; fades as real xG accumulates
    if (p.penalties_order === 1) xG90 += 0.22 * PRIOR_MINS/(p.minutes+PRIOR_MINS);
    const xA90 = shrunk((parseFloat(p.expected_assists||0))/sos, priorA, 0.7);
    const share = xMins/90 * (ATT[diff]||1);
    const goals   = xG90 * share * GOAL_PTS[p.element_type];
    const assists = xA90 * share * 3;
    // defending: clean sheets (needs 60+ mins), GK saves
    const csP = (CS[diff]||0.25) * p60;
    const cs = p.element_type<=2 ? 4*csP : p.element_type===3 ? 1*csP : 0;
    const saves = p.element_type===1 ? (p.saves/n)/3 : 0;
    const bonus = Math.min(1.5, p.bonus/n * 0.8);
    // DEFCON: 2 pts for hitting the defensive-actions threshold (10 DEF / 12 MID,FWD)
    let defcon = 0;
    const T = DC_THRESH[p.element_type];
    if (T){
      const dc90 = ((+p.defensive_contribution||0) + priorDC*(PRIOR_MINS/90)) / (p.minutes + PRIOR_MINS) * 90;
      const pHit = clamp((dc90 - 0.55*T) / (0.9*T), 0, 0.85);
      defcon = 2 * pHit * p60;
    }
    // appearance points are near-guaranteed for a regular starter — only blend the surplus
    const surplus = goals + assists + cs + saves + bonus + defcon;
    const fplSurplus = Math.max(0, (parseFloat(p.ep_next)||0) - appear);
    const w = clamp(n/8, 0.4, 0.75);                   // trust our model more as games accumulate
    const ep = appear + w*surplus + (1-w)*fplSurplus;
    return {ep: Math.round(ep*10)/10, xMins: Math.round(xMins)};
  };
}
// ---------------------------------------------------------------------------

(async () => {
  const bs = await get('https://fantasy.premierleague.com/api/bootstrap-static/');
  const allFx = await get('https://fantasy.premierleague.com/api/fixtures/');
  let hist = {}; try { hist = await get(`https://fantasy.premierleague.com/api/entry/${TEAM_ID}/history/`); } catch(e) {}
  const ev = bs.events.find(e => e.is_next) || bs.events.find(e => e.is_current) || bs.events[bs.events.length-1];
  const teams = {}; bs.teams.forEach(t => teams[t.id] = [t.name, t.short_name]);

  const byTeam = {}, gamesByTeam = {}, sosSum = {};
  bs.teams.forEach(t => { byTeam[t.id] = []; gamesByTeam[t.id] = 0; sosSum[t.id] = 0; });
  for (const f of allFx) {
    if (f.finished) {
      gamesByTeam[f.team_h]++; gamesByTeam[f.team_a]++;
      sosSum[f.team_h] += ATT[f.team_h_difficulty]||1;
      sosSum[f.team_a] += ATT[f.team_a_difficulty]||1;
      continue;
    }
    if (!f.event || f.started) continue;
    if (byTeam[f.team_h].length < 5) byTeam[f.team_h].push([f.team_a, 1, f.team_h_difficulty, f.event]);
    if (byTeam[f.team_a].length < 5) byTeam[f.team_a].push([f.team_h, 0, f.team_a_difficulty, f.event]);
  }

  // his team: try the upcoming GW's picks, fall back to the last finished GW
  let myTeam = null;
  for (const g of [ev.id, ev.id-1]) {
    if (g < 1) break;
    try {
      const picks = await get(`https://fantasy.premierleague.com/api/entry/${TEAM_ID}/event/${g}/picks/`);
      if (picks && picks.picks) {
        myTeam = { gw: g, bank: (picks.entry_history?.bank ?? 0)/10, value: (picks.entry_history?.value ?? 0)/10,
                   totalPts: picks.entry_history?.total_points ?? 0,
                   picks: picks.picks.map(p => [p.element, p.position, p.is_captain?1:0, p.is_vice_captain?1:0]) };
        break;
      }
    } catch (e) { /* not published yet */ }
  }

  if (myTeam) myTeam.chips = (hist.chips || []).map(c => [c.name, c.event]);

  const sosByTeam = {};
  bs.teams.forEach(t => { sosByTeam[t.id] = gamesByTeam[t.id]>0 ? sosSum[t.id]/gamesByTeam[t.id] : 1; });

  const mustHave = new Set((myTeam?.picks || []).map(p => p[0]));

  const pool = bs.elements.filter(p =>
    ((p.status === 'a' && parseFloat(p.selected_by_percent) >= 0.8) || mustHave.has(p.id)));

  // last-season priors: one history call per pool player, in polite chunks
  const priors = {};
  for (let i = 0; i < pool.length; i += 20) {
    await Promise.all(pool.slice(i, i+20).map(async p => {
      try {
        const s = await get(`https://fantasy.premierleague.com/api/element-summary/${p.id}/`);
        const past = s.history_past || [];
        const l = past[past.length-1];
        if (l && l.minutes > 0) priors[p.id] = { mins:l.minutes, g:+l.expected_goals||0, a:+l.expected_assists||0, dc:+l.defensive_contribution||0 };
      } catch (e) { /* new to the league — positional prior */ }
    }));
  }

  const model = makeModel(gamesByTeam, sosByTeam, priors);

  const players = pool.map(p => {
    const fixtures = byTeam[p.team] || [];
    const d1 = fixtures[0]?.[2] ?? 3;
    const {ep, xMins} = model(p, d1);
    // 3-week points: run the model for each of the next three fixtures
    const p3 = fixtures.slice(0,3).reduce((s,f) => s + model(p, f[2]).ep, 0);
    return [p.web_name, p.team, p.element_type, p.now_cost/10,
            parseFloat(p.selected_by_percent), ep, p.total_points,
            xMins, Math.round(p3*10)/10, p.id];
  })
  .sort((a, b) => b[4] - a[4])
  .filter((row, i) => i < 150 || mustHave.has(row[9]));

  const data = { updated: new Date().toISOString().slice(0,10),
                 gw: { id: ev.id, name: ev.name, deadline: ev.deadline_time },
                 teams, players, fix: byTeam, myTeam };
  require('fs').writeFileSync('data.json', JSON.stringify(data));
  console.log('data.json written:', players.length, 'players,', data.gw.name, myTeam?('team loaded GW'+myTeam.gw):'no team');
})();
