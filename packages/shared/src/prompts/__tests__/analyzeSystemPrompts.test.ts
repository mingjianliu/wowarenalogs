import { FINDINGS_JSON_SYSTEM_PROMPT, NEW_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../analyzeSystemPrompts';

// Position data reaches the prompts as explicit annotations (CC range/LoS tags,
// HEALER EXPOSURE entries). The system prompts must (a) explain those annotations
// and (b) not claim positioning is categorically absent — that wording predates
// the annotations and contradicts the data now present.
describe('analyzeSystemPrompts — position annotation legend', () => {
  it('NEW_SYSTEM_PROMPT documents the CC distance/LoS annotation', () => {
    expect(NEW_SYSTEM_PROMPT).toContain('yd from caster');
    expect(NEW_SYSTEM_PROMPT).toContain('LoS blocked');
  });

  it('every prompt grounds positioning claims in explicit annotations', () => {
    for (const prompt of [SYSTEM_PROMPT, FINDINGS_JSON_SYSTEM_PROMPT, NEW_SYSTEM_PROMPT]) {
      expect(prompt).toContain('positioning claim');
    }
  });

  it('critical-moments prompts reference the HEALER EXPOSURE section as a position source', () => {
    expect(SYSTEM_PROMPT).toContain('HEALER EXPOSURE');
    expect(FINDINGS_JSON_SYSTEM_PROMPT).toContain('HEALER EXPOSURE');
  });

  it('FINDINGS_JSON no longer claims positioning is categorically absent', () => {
    expect(FINDINGS_JSON_SYSTEM_PROMPT).not.toContain('positioning are usually absent');
  });
});
