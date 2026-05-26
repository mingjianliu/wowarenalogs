const fs = require('fs');
const path = require('path');

const scoresDir = 'packages/tools/local-batch/healer-eval/scores';
const reportPath = 'packages/tools/local-batch/healer-eval/eval-report.md';

function run() {
  const files = fs.readdirSync(scoresDir).filter(f => f.endsWith('.json'));
  const scores = [];
  
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(scoresDir, f), 'utf8'));
    scores.push(data);
  }
  
  scores.sort((a, b) => a.ordinal - b.ordinal);
  
  const totalMatches = scores.length;
  if (totalMatches === 0) {
    console.log("No scores found!");
    return;
  }
  
  // Spec distribution
  const specCounts = {};
  for (const s of scores) {
    const spec = s.spec.replace(' ', '_');
    specCounts[spec] = (specCounts[spec] || 0) + 1;
  }
  const specDist = Object.entries(specCounts).map(([k, v]) => `${k}: ${v}`).join(', ');
  
  const dimensions = [
    { key: 'sufficiency', group: 'prompt' },
    { key: 'noise', group: 'prompt' },
    { key: 'labelBias', group: 'prompt' },
    { key: 'inferenceScaffolding', group: 'prompt' },
    { key: 'accuracy', group: 'response' },
    { key: 'outcomeAlignment', group: 'response' },
    { key: 'focusCalibration', group: 'response' }
  ];
  
  // Aggregates
  const stats = {};
  for (const dim of dimensions) {
    const vals = scores.map(s => s[dim.group][dim.key]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
    const flagged = vals.filter(v => v <= 2).length;
    stats[dim.key] = { min, max, avg, pctFlagged: ((flagged / vals.length) * 100).toFixed(1), flaggedCount: flagged };
  }
  
  // Markdown Generation
  const dateStr = new Date().toISOString().split('T')[0];
  let md = `# Healer Eval Report\n\n`;
  md += `**Run date:** ${dateStr}\n`;
  md += `**Mode:** fresh\n`;
  md += `**Matches evaluated:** ${totalMatches}\n`;
  md += `**Spec distribution:** ${specDist}\n\n`;
  md += `---\n\n`;
  
  md += `## Aggregate Scores\n\n`;
  md += `| Dimension | Min | Max | Avg | % ≤ 2 (flagged) |\n`;
  md += `| --- | --- | --- | --- | --- |\n`;
  for (const dim of dimensions) {
    const st = stats[dim.key];
    md += `| ${dim.key} | ${st.min} | ${st.max} | ${st.avg.toFixed(2)} | ${st.pctFlagged}% |\n`;
  }
  md += `\n---\n\n`;
  
  md += `## Flagged Matches (any dimension ≤ 2)\n\n`;
  for (const s of scores) {
    const flags = [];
    for (const dim of dimensions) {
      if (s[dim.group][dim.key] <= 2) {
        flags.push({
          dim: dim.key,
          score: s[dim.group][dim.key],
          note: s[dim.group].notes
        });
      }
    }
    if (flags.length > 0) {
      const nnn = String(s.ordinal).padStart(3, '0');
      const shortSpec = s.spec.replace(' ', '_');
      md += `### ${nnn} — ${shortSpec} ${s.result} (${s.matchId})\n`;
      for (const f of flags) {
        md += `- **${f.dim}**: ${f.score} — (${f.note})\n`;
      }
      md += `\n`;
    }
  }
  md += `---\n\n`;
  
  md += `## Cross-Spec Patterns\n\n`;
  for (const [spec, count] of Object.entries(specCounts)) {
    if (count >= 2) {
      md += `### ${spec}\n`;
      const specScores = scores.filter(s => s.spec.replace(' ', '_') === spec);
      for (const dim of dimensions) {
        const vals = specScores.map(s => s[dim.group][dim.key]);
        const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
        if (avg <= 2.5) {
          md += `- **${dim.key}**: **${avg.toFixed(2)}** (⚠️)\n`;
        } else {
          md += `- **${dim.key}**: ${avg.toFixed(2)}\n`;
        }
      }
      md += `\n`;
    }
  }
  md += `---\n\n`;
  
  md += `## Top 3 Issues\n\n`;
  const ranked = dimensions.map(dim => {
    const st = stats[dim.key];
    const score = st.flaggedCount * (5 - st.avg);
    return { dim: dim.key, score, st, group: dim.group };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
  
  for (let i=0; i<ranked.length; i++) {
    const r = ranked[i];
    // gather notes for this dim
    const notesList = scores.filter(s => s[r.group][r.dim] <= 2).map(s => s[r.group].notes);
    const uniqueNotes = Array.from(new Set(notesList)).slice(0, 3).join("; ");
    md += `${i+1}. **${r.dim}**: affects ${r.st.flaggedCount}/${totalMatches} matches. Avg score: ${r.st.avg.toFixed(2)}. Pattern: ${uniqueNotes || 'No specific pattern identified'}.\n`;
  }
  
  md += `\n---\n\n`;
  md += `## Recommendations\n\n`;
  for (const r of ranked) {
    if (r.dim === 'noise') {
      md += `- **${r.dim}**: Filter out excessive [STATE] updates, repetitive [RES] rdy messages, and passive proc spam in buildMatchPromptNew.\n`;
    } else if (r.dim === 'sufficiency') {
      md += `- **${r.dim}**: Ensure enemy CD timelines and damage spike contexts are explicitly included leading up to deaths.\n`;
    } else if (r.dim === 'inferenceScaffolding') {
      md += `- **${r.dim}**: Group related events more closely, ensuring death lines appear immediately after the causal burst/CC chain.\n`;
    } else if (r.dim === 'outcomeAlignment') {
      md += `- **${r.dim}**: Instruct the response generator to explicitly check the match result (Win/Loss) and connect misplays directly to the final outcome.\n`;
    } else {
      md += `- **${r.dim}**: Investigate this dimension based on the flagged match notes to refine the rubric or prompt construction.\n`;
    }
  }
  
  fs.writeFileSync(reportPath, md, 'utf8');
  console.log(`Eval complete. Report written to ${reportPath}`);
}

run();
