const fs = require('fs');
const path = require('path');

const scoresDir = path.join(__dirname, '../packages/tools/local-batch/healer-eval/scores');
const scoreFiles = fs.readdirSync(scoresDir).filter(f => f.endsWith('.json'));

const issues = {
    hallucinations: {
        topic: "Hallucinations / Spec Misidentification",
        matches: [],
        details: []
    },
    noisyInformation: {
        topic: "Noisy Information / UI Spam",
        matches: [],
        details: []
    },
    missingContext: {
        topic: "Missing Context / Structure Suggestions",
        matches: [],
        details: []
    },
    individualBugs: []
};

for (const file of scoreFiles) {
    const content = fs.readFileSync(path.join(scoresDir, file), 'utf8');
    if (!content.trim()) continue;
    try {
        const data = JSON.parse(content);
        const matchInfo = `Match ${data.ordinal} (${data.spec})`;
        
        if (data.response) {
            const misleading = data.response.misleadingInfo || data.misleadingInfo;
            if (misleading && misleading !== "None." && misleading !== "None") {
                if (misleading.toLowerCase().includes("hallucinate") || misleading.toLowerCase().includes("spec") || misleading.toLowerCase().includes("class")) {
                    issues.hallucinations.matches.push(matchInfo);
                    issues.hallucinations.details.push(`- ${matchInfo}: ${misleading}`);
                } else if (!misleading.toLowerCase().includes("none") && !misleading.toLowerCase().includes("none identified") && !misleading.toLowerCase().includes("none found")) {
                    issues.individualBugs.push({ match: matchInfo, detail: misleading });
                }
            }

            const noisy = data.response.noisyInfo || data.noisyInfo;
            if (noisy && noisy !== "None." && noisy !== "None") {
                issues.noisyInformation.matches.push(matchInfo);
                issues.noisyInformation.details.push(`- ${matchInfo}: ${noisy}`);
            }

            const suggestions = data.response.promptStructureSuggestions || data.promptStructureSuggestions;
            if (suggestions && suggestions !== "None." && suggestions !== "None") {
                issues.missingContext.matches.push(matchInfo);
                issues.missingContext.details.push(`- ${matchInfo}: ${suggestions}`);
            }
        }
    } catch (e) {
        console.error(`Error parsing ${file}: ${e}`);
    }
}

let report = `# 100-Game Meta-Evaluation Report\n\n`;

report += `## 1. Merged Issues by Topic\n\n`;

if (issues.hallucinations.matches.length > 0) {
    report += `### Topic: ${issues.hallucinations.topic}\n`;
    report += `**Related Matches:** ${issues.hallucinations.matches.join(', ')}\n\n`;
    report += `**Details:**\n${issues.hallucinations.details.join('\n')}\n\n`;
}

if (issues.noisyInformation.matches.length > 0) {
    report += `### Topic: ${issues.noisyInformation.topic}\n`;
    report += `**Related Matches:** ${issues.noisyInformation.matches.join(', ')}\n\n`;
    report += `**Details:**\n${issues.noisyInformation.details.join('\n')}\n\n`;
}

if (issues.missingContext.matches.length > 0) {
    report += `### Topic: ${issues.missingContext.topic}\n`;
    report += `**Related Matches:** ${issues.missingContext.matches.join(', ')}\n\n`;
    report += `**Details:**\n${issues.missingContext.details.join('\n')}\n\n`;
}

report += `## 2. Individual Spec Bugs & Unmergeable Issues\n\n`;
if (issues.individualBugs.length > 0) {
    for (const bug of issues.individualBugs) {
        report += `### Issue in ${bug.match}\n`;
        report += `**Related Match:** ${bug.match}\n`;
        report += `**Detail:** ${bug.detail}\n\n`;
    }
} else {
    report += `*No unmergeable individual issues found.*\n\n`;
}

console.log(report);
