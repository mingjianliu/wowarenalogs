/* eslint-disable no-console */
import fs from 'fs-extra';
import path from 'path';

const DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/healer-profile/profiles';
const OUT = path.join(DIR, 'profiles.html');

async function main() {
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.json'));
  const profiles = [];
  for (const f of files) {
    const p = await fs.readJson(path.join(DIR, f));
    // Drop the dead defensiveOverlapRatio metric (rare same-target panic-overlap, ~0 for everyone).
    if (p.metrics) delete p.metrics.defensiveOverlapRatio;
    profiles.push(p);
  }
  profiles.sort((a, b) => b.games - a.games);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Healer Playing Profiles</title>
<style>
  :root { --bg:#0f1115; --card:#1a1d24; --line:#2a2f3a; --txt:#e6e8ee; --mut:#8b93a7;
          --good:#3fb950; --mid:#d29922; --bad:#f85149; --accent:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:28px 24px 8px; }
  h1 { margin:0; font-size:22px; }
  .sub { color:var(--mut); margin-top:6px; max-width:760px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(400px,1fr)); gap:16px; padding:16px 24px 40px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 18px 14px; }
  .chd { display:flex; justify-content:space-between; align-items:baseline; }
  .chd h2 { margin:0; font-size:17px; }
  .games { color:var(--mut); font-size:12px; }
  .hook { background:#12253f; border:1px solid #1f3d63; color:#cfe3ff; border-radius:8px; padding:8px 10px; margin:10px 0 14px; font-size:13px; }
  .sect { color:var(--mut); font-size:11px; letter-spacing:.08em; text-transform:uppercase; margin:14px 0 8px; }
  .m { margin-bottom:12px; }
  .mtop { display:flex; justify-content:space-between; align-items:baseline; }
  .mlabel { font-weight:600; }
  .badge { font-size:11px; padding:2px 7px; border-radius:20px; font-weight:600; }
  .bar { position:relative; height:8px; background:#242833; border-radius:6px; margin:6px 0 4px; overflow:hidden; }
  .fill { position:absolute; left:0; top:0; bottom:0; border-radius:6px; }
  .cohmark { position:absolute; top:-3px; bottom:-3px; width:2px; background:var(--mut); }
  .mvals { color:var(--mut); font-size:12px; }
  .driver { color:#6f7789; font-size:11px; font-style:italic; margin-top:2px; }
  .desc .mlabel { font-weight:500; color:#b7bdcc; }
  .fm { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #21252e; }
  .fm:last-child { border-bottom:none; }
  .fmv { font-weight:600; }
  .note { color:var(--mut); font-size:12px; padding:0 24px 28px; max-width:820px; }
</style></head><body>
<header>
  <h1>Healer Playing Profiles</h1>
  <div class="sub">Per-spec tendencies across all your games, ranked vs a 2300+ pro cohort. Bars show your
  <b>percentile</b> (fill) with the cohort median marked. <b>Prescriptive</b> metrics are what to coach on;
  <b>descriptive</b> are context only. Failure modes are mined from your own games (no pro prompts exist to
  cohort-compare those).</div>
</header>
<div class="grid" id="grid"></div>
<div class="note" id="note"></div>
<script>
const PROFILES = ${JSON.stringify(profiles)};
const col = p => p>=66?'var(--good)':p>=33?'var(--mid)':'var(--bad)';
const fmtN = (x,u)=> (x==null||isNaN(x))?'n/a':(Math.abs(x)>=100?Math.round(x):(+x).toFixed(2))+(u||'');
function metricRow(m, key){
  const you = m.you? m.you.median : m.pooled;
  const p = m.percentile;
  const pctFill = isNaN(p)?0:p;
  // cohort median marker position: map cohort median into the same 0-100 axis by comparing to you-range is hard;
  // simplest: show percentile fill + numeric you-vs-cohort below.
  const badge = isNaN(p)?'':'<span class="badge" style="background:'+col(p)+'22;color:'+col(p)+'">'+p+'th pctile</span>';
  const cohStr = (m.cohort && !isNaN(m.cohort.median))? ('cohort '+fmtN(m.cohort.median,m.unit)) : '';
  const youStr = m.pooled!=null ? (Math.round(m.pooled*100)+'% pooled ('+m.totAvoid+'/'+m.totIncoming+')') : ('you '+fmtN(you,m.unit));
  return '<div class="m"><div class="mtop"><span class="mlabel">'+m.label+'</span>'+badge+'</div>'
    + '<div class="bar"><div class="fill" style="width:'+pctFill+'%;background:'+col(isNaN(p)?50:p)+'"></div><div class="cohmark" style="left:'+(isNaN(p)?50:50)+'%"></div></div>'
    + '<div class="mvals">'+youStr+(cohStr?('  ·  '+cohStr):'')+'</div>'
    + '<div class="driver">'+m.driver+'</div></div>';
}
function fm(label, val, sev){ return '<div class="fm"><span>'+label+'</span><span class="fmv" style="color:'+sev+'">'+val+'</span></div>'; }
function sevPct(x){ return x>=0.5?'var(--bad)':x>=0.25?'var(--mid)':'var(--good)'; }
const grid = document.getElementById('grid');
for(const P of PROFILES){
  const keys = Object.keys(P.metrics).filter(k=>k!=='defensiveOverlapRatio');
  const presc = keys.filter(k=>P.metrics[k].crisisActionable).map(k=>metricRow(P.metrics[k],k)).join('');
  const desc = keys.filter(k=>!P.metrics[k].crisisActionable).map(k=>metricRow(P.metrics[k],k)).join('');
  const F = P.failureModes||{};
  const deaths = F.deaths||0;
  const dhRate = deaths>0? F.diedHoldingTool/deaths : 0;
  const idleRate = P.games? F.idleGames/P.games : 0;
  const mpRate = P.games? F.missedPurgeGames/P.games : 0;
  let hook='';
  // rebuild hook from OI/CC percentile
  const oi=P.metrics.offensiveIndex, cc=P.metrics.ccDensity;
  if(oi && oi.percentile<40) hook='⚑ Weave more damage — Offensive Index at the '+oi.percentile+'th percentile ('+fmtN(oi.you.median,'')+' vs cohort '+fmtN(oi.cohort.median,'')+').';
  else hook='✓ You match or beat the cohort on the prescriptive metrics.';
  const card = '<div class="card"><div class="chd"><h2>'+P.spec+'</h2><span class="games">'+P.games+' games</span></div>'
    + '<div class="hook">'+hook+'</div>'
    + '<div class="sect">Prescriptive — coach on these</div>'+presc
    + '<div class="sect desc">Descriptive — context only</div><div class="desc">'+desc+'</div>'
    + '<div class="sect">Recurring failure modes (your games)</div>'
    + fm('Died holding a defensive/trinket', deaths>0? Math.round(dhRate*100)+'% ('+F.diedHoldingTool+'/'+deaths+' deaths)':'n/a', sevPct(dhRate))
    + fm('Missed offensive purge', Math.round(mpRate*100)+'% of games', sevPct(mpRate))
    + fm('Idle gaps under pressure', Math.round(idleRate*100)+'% of games', sevPct(idleRate))
    + fm('Over-commit (cheaper tool up)', (F.overCommitPerGame||0).toFixed(2)+' flags/game', sevPct(Math.min(1,(F.overCommitPerGame||0)/2)))
    + '</div>';
  grid.insertAdjacentHTML('beforeend', card);
}
document.getElementById('note').textContent = 'Percentile = where your median sits in the pro cohort distribution (100 = best). CC Avoidance is pooled across games. Failure-mode rates are your own tendencies — the pro cohort has metrics but no prompt-level data, so those four rows cannot be pro-compared.';
</script></body></html>`;

  await fs.writeFile(OUT, html, 'utf8');
  console.log(`Wrote ${OUT} (${profiles.length} specs, ${(html.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
