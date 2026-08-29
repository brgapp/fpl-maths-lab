// Rebuilds data.json from the official FPL API. Run daily by the GitHub Action.
const get = async u => (await fetch(u, {headers:{'User-Agent':'fpl-maths-lab'}})).json();
(async () => {
  const bs = await get('https://fantasy.premierleague.com/api/bootstrap-static/');
  const fx = await get('https://fantasy.premierleague.com/api/fixtures/?future=1');
  const ev = bs.events.find(e => e.is_next) || bs.events.find(e => e.is_current) || bs.events[bs.events.length-1];
  const teams = {}; bs.teams.forEach(t => teams[t.id] = [t.name, t.short_name]);
  const players = bs.elements
    .filter(p => p.status === 'a' && parseFloat(p.selected_by_percent) >= 0.8)
    .map(p => [p.web_name, p.team, p.element_type, p.now_cost/10,
               parseFloat(p.selected_by_percent), parseFloat(p.ep_next) || 0, p.total_points])
    .sort((a, b) => b[4] - a[4]).slice(0, 150);
  const byTeam = {}; bs.teams.forEach(t => byTeam[t.id] = []);
  for (const f of fx) {
    if (!f.event) continue;
    if (byTeam[f.team_h].length < 5) byTeam[f.team_h].push([f.team_a, 1, f.team_h_difficulty, f.event]);
    if (byTeam[f.team_a].length < 5) byTeam[f.team_a].push([f.team_h, 0, f.team_a_difficulty, f.event]);
  }
  const data = { updated: new Date().toISOString().slice(0,10),
                 gw: { id: ev.id, name: ev.name, deadline: ev.deadline_time },
                 teams, players, fix: byTeam };
  require('fs').writeFileSync('data.json', JSON.stringify(data));
  console.log('data.json written:', players.length, 'players,', data.gw.name);
})();
