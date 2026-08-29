// Rebuilds data.json from the official FPL API. Run daily by the GitHub Action.
// v2: our own expected-points model (expected minutes + xG/xA + fixtures) and the family team.
const TEAM_ID = 33616; // his FPL team

const get = async u => (await fetch(u, {headers:{'User-Agent':'fpl-maths-lab'}})).json();

// --- the mini model ---------------------------------------------------------
const ATT = {2:1.25, 3:1.0, 4:0.8, 5:0.62};
const CS  = {2:0.42, 3:0.30, 4:0.20, 5:0.12};
const GOAL_PTS = {1:10, 2:6, 3:5, 4:4};
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
const XG_PRIOR = {1:0, 2:0.05, 3:0.18, 4:0.38};
const XA_PRIOR = {1:0.01, 2:0.06, 3:0.15, 4:0.10};
function makeModel(gamesByTeam){
  return function ep(p, diff){
    const n = Math.max(1, gamesByTeam[p.team] || 1);
    const avail = p.chance_of_playing_next_round == null ? 1 : p.chance_of_playing_next_round/100;
    const xMins = clamp(p.minutes / n, 0, 94) * avail;
    if (xMins < 5) return {ep:0.3, xMins:Math.round(xMins)};
    const p60   = clamp((xMins-30)/45, 0, 1);
    const pPlay = clamp(xMins/40, 0, 1);
    const appear = 1*pPlay + 1*p60;
    const shrunk = (v, prior) => Math.min(prior>0.2?1.1:0.7, (v + prior*3) / (p.minutes + 270) * 90);
    const xG90 = shrunk(parseFloat(p.expected_goals||0),   XG_PRIOR[p.element_type]);
    const xA90 = shrunk(parseFloat(p.expected_assists||0), XA_PRIOR[p.element_type]);
    const share = xMins/90 * (ATT[diff]||1);
    const goals   = xG90 * share * GOAL_PTS[p.element_type];
    const assists = xA90 * share * 3;
    const csP = (CS[diff]||0.25) * p60;
    const cs = p.element_type<=2 ? 4*csP : p.element_type===3 ? 1*csP : 0;
    const saves = p.element_type===1 ? (p.saves/n)/3 : 0;
    const bonus = Math.min(1.5, p.bonus/n * 0.8);
    const model = appear + goals + assists + cs + saves + bonus;
    const fpl = parseFloat(p.ep_next)||0;
    const w = clamp(n/8, 0.3, 0.75);
    return {ep: Math.round((w*model + (1-w)*fpl)*10)/10, xMins: Math.round(xMins)};
  };
}
// ---------------------------------------------------------------------------

(async () => {
  const bs = await get('https://fantasy.premierleague.com/api/bootstrap-static/');
  const allFx = await get('https://fantasy.premierleague.com/api/fixtures/');
  const ev = bs.events.find(e => e.is_next) || bs.events.find(e => e.is_current) || bs.events[bs.events.length-1];
  const teams = {}; bs.teams.forEach(t => teams[t.id] = [t.name, t.short_name]);

  const byTeam = {}, gamesByTeam = {};
  bs.teams.forEach(t => { byTeam[t.id] = []; gamesByTeam[t.id] = 0; });
  for (const f of allFx) {
    if (f.finished) { gamesByTeam[f.team_h]++; gamesByTeam[f.team_a]++; continue; }
    if (!f.event || f.started) continue;
    if (byTeam[f.team_h].length < 5) byTeam[f.team_h].push([f.team_a, 1, f.team_h_difficulty, f.event]);
    if (byTeam[f.team_a].length < 5) byTeam[f.team_a].push([f.team_h, 0, f.team_a_difficulty, f.event]);
  }

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

  const model = makeModel(gamesByTeam);
  const mustHave = new Set((myTeam?.picks || []).map(p => p[0]));

  const pool = bs.elements.filter(p =>
    ((p.status === 'a' && parseFloat(p.selected_by_percent) >= 0.8) || mustHave.has(p.id)));

  const players = pool.map(p => {
    const fixtures = byTeam[p.team] || [];
    const d1 = fixtures[0]?.[2] ?? 3;
    const {ep, xMins} = model(p, d1);
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
