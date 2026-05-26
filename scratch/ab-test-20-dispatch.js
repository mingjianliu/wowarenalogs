const fs = require('fs');

const mode = process.argv[2];
const subagents = [];

for (let i = 1; i <= 20; i++) {
  subagents.push({
    TypeName: 'self',
    Role: `Scorer ${mode} ${i}`,
    Prompt: `You are an expert evaluator. Your task is to score a prompt according to a rubric.

Read the prompt file: /Users/mingjianliu/code/wowarenalogs/scratch/ab-test-20/${mode}/${i}.txt

After reading it, output ONLY a JSON object to the file /Users/mingjianliu/code/wowarenalogs/scratch/ab-test-20/scores/${mode}/${i}.json using the write_to_file tool. Do not write anything else.

Format:
{
  "prompt": {
    "sufficiency": [1-5],
    "noise": [1-5],
    "labelBias": [1-5],
    "inferenceScaffolding": [1-5],
    "notes": "One sentence explaining the key prompt quality issue."
  }
}

Rubric:
Prompt quality (1-5, 5=excellent):
- sufficiency: Contains enough data?
- noise: Verbose/redundant? [RES] rdy: repeated, passive proc spam, duplicate events, or excessive [STATE] lines. Heavy -> 1-2, Some -> 3, Clean -> 4-5.
- labelBias: Severity labels on minor events, loaded language? Biased -> 1-2, Neutral -> 4-5.
- inferenceScaffolding: Events ordered/labeled to connect cause->effect? Death line near damage/CC. Out of order/lacking context -> 1-2, Well-scaffolded -> 4-5.`
  });
}

console.log(JSON.stringify(subagents, null, 2));
