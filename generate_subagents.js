const fs = require('fs');
const data = JSON.parse(fs.readFileSync('packages/tools/local-batch/healer-eval/index.json', 'utf8'));

const batch = data.slice(0, 10);
const subagents = batch.map(entry => {
    const nnn = String(entry.ordinal).padStart(3, '0');
    const fileBase = entry.file.split('/')[1];
    return {
        TypeName: "self",
        Role: `Scorer ${nnn}`,
        Prompt: `You are an expert evaluator. Your task is to score a prompt and response according to a rubric, and write the result to a JSON file.

Match Info:
Ordinal: ${entry.ordinal}
MatchId: ${entry.matchId}
Spec: ${entry.spec}
Result: ${entry.result}
DurationSec: ${entry.durationSec}

Read the prompt file: /Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/prompts/${fileBase}
Read the response file: /Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/responses/${nnn}.txt

After reading them, output ONLY a JSON object to the file /Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/scores/${nnn}.json using the write_to_file tool. Do not write anything else.
Make sure the scores directory exists (create it if not).

Format:
{
  "ordinal": ${entry.ordinal},
  "matchId": "${entry.matchId}",
  "spec": "${entry.spec}",
  "result": "${entry.result}",
  "durationSec": ${entry.durationSec},
  "prompt": {
    "sufficiency": [1-5],
    "noise": [1-5],
    "labelBias": [1-5],
    "inferenceScaffolding": [1-5],
    "notes": "One sentence explaining the key prompt quality issue."
  },
  "response": {
    "accuracy": [1-5],
    "outcomeAlignment": [1-5],
    "focusCalibration": [1-5],
    "notes": "One sentence explaining the key response quality issue."
  }
}

Rubric:
Prompt quality (1-5, 5=excellent):
- sufficiency: Contains enough data? CC chain, dampening, enemy CD timeline, kill attempt windows. Missing -> 1-2, Partial -> 3, Complete -> 4-5.
- noise: Verbose/redundant? [RES] rdy: repeated, passive proc spam, duplicate events. Heavy -> 1-2, Some -> 3, Clean -> 4-5.
- labelBias: Severity labels on minor events, loaded language? Biased -> 1-2, Neutral -> 4-5.
- inferenceScaffolding: Events ordered/labeled to connect cause->effect? Death line near damage/CC. Out of order/lacking context -> 1-2, Well-scaffolded -> 4-5.

Response quality (1-5, 5=excellent):
- accuracy: References only events in prompt? Hallucinated -> 1-2, Accurate -> 4-5.
- outcomeAlignment: Explains factors contributing to win/loss? Identifies turning points? Ignores result -> 1-2, Addresses outcome -> 4-5.
- focusCalibration: Identifies highest-leverage moments vs minor ones. Equal weight to everything -> 1-2, Clear prioritization -> 4-5.
`
    };
});

fs.writeFileSync('subagents_payload.json', JSON.stringify({ Subagents: subagents }, null, 2));
console.log('Done');
