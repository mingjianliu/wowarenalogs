import Anthropic from '@anthropic-ai/sdk';
import type { NextApiRequest, NextApiResponse } from 'next';

import { captureAnalysisRun, PromptId, shouldCapture } from '../../../shared/src/api/analysisCapture';
import {
  parseFindingsResponse,
  renderFindingsAsProse,
} from '../../../shared/src/components/CombatReport/CombatAIAnalysis/aiFindings';
import {
  FINDINGS_JSON_SYSTEM_PROMPT,
  NEW_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from '../../../shared/src/prompts/analyzeSystemPrompts';
import { resolveAIModel } from '../../../shared/src/utils/aiModels';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    matchContext,
    apiKey: bodyApiKey,
    systemPrompt: bodySystemPrompt,
    debug,
    useTimelinePrompt,
    findingsJson,
    matchId,
    model: bodyModel,
  } = req.body as {
    matchContext?: string;
    apiKey?: string;
    systemPrompt?: string;
    debug?: boolean;
    useTimelinePrompt?: boolean;
    findingsJson?: boolean;
    matchId?: string;
    model?: string;
  };
  const apiKey = bodyApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'No Anthropic API key configured. Add one in Settings.' });
  }
  if (!matchContext || typeof matchContext !== 'string') {
    return res.status(400).json({ error: 'Missing matchContext in request body' });
  }

  try {
    const client = new Anthropic({ apiKey });
    // User-selectable model (Settings → AI Analysis); unknown ids fall back to the default.
    const modelOption = resolveAIModel(bodyModel);
    const model = modelOption.id;
    const startMs = Date.now();

    // Prompt selection precedence (highest priority first):
    //   1. debug && bodySystemPrompt: explicit override for local dev/testing only.
    //      Gate prevents the route becoming a free LLM proxy for arbitrary prompts.
    //   2. findingsJson: structured JSON findings path used by the AI Analysis UI.
    //   3. useTimelinePrompt: use raw timeline path (NEW_SYSTEM_PROMPT).
    //   4. default: structured critical-moments path (SYSTEM_PROMPT, prose).
    const activeSystemPrompt =
      debug && bodySystemPrompt && typeof bodySystemPrompt === 'string' && bodySystemPrompt.length <= 32_000
        ? bodySystemPrompt
        : findingsJson
          ? FINDINGS_JSON_SYSTEM_PROMPT
          : useTimelinePrompt
            ? NEW_SYSTEM_PROMPT
            : SYSTEM_PROMPT;

    const message = await client.messages.create({
      model,
      max_tokens: 6144,
      // Sonnet 5 / Opus 4.7+ / Fable 5 reject sampling params with a 400.
      ...(modelOption.supportsTemperature ? { temperature: 0.3 } : {}),
      system: activeSystemPrompt,
      messages: [{ role: 'user', content: matchContext }],
    });

    const durationMs = Date.now() - startMs;
    // Fable 5 safety classifiers can decline with stop_reason "refusal" and an
    // empty content array — surface a clear error instead of crashing below.
    if (message.stop_reason === 'refusal') {
      return res.status(502).json({ error: 'AI declined to analyze this match. Try again or switch models.' });
    }
    const content = message.content[0];
    if (!content || content.type !== 'text') {
      return res.status(500).json({ error: 'Unexpected response type from AI' });
    }

    const responseBody: Record<string, unknown> = { analysis: content.text };

    // Structured path: parse the model's JSON into findings. On success, also
    // reconstruct the legacy prose so any consumer reading `analysis` is unaffected.
    // On failure, fall back to the raw text (the UI degrades to a plain card).
    let parseOk: boolean | undefined;
    let parseError: string | undefined;
    if (findingsJson) {
      try {
        const findings = parseFindingsResponse(content.text);
        responseBody.findings = findings;
        responseBody.analysis = renderFindingsAsProse(findings);
        parseOk = true;
      } catch (parseErr) {
        parseOk = false;
        parseError = parseErr instanceof Error ? parseErr.message : 'parse failed';
        responseBody.parseError = parseError;
        console.warn(`[analyze] findingsJson parse FAILED: ${parseError}`);
      }
      responseBody.parseOk = parseOk;
    }

    if (debug) {
      responseBody.debug = {
        model,
        systemPrompt: activeSystemPrompt,
        userMessage: matchContext,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        durationMs,
        parseOk,
        parseError,
        rawText: findingsJson ? content.text : undefined,
      };
    }

    // Capture production runs (input + output) for prompt optimization.
    // Guarded + time-bounded inside captureAnalysisRun; never breaks the response.
    if (shouldCapture({ nodeEnv: process.env.NODE_ENV, debug })) {
      const promptId: PromptId =
        activeSystemPrompt === FINDINGS_JSON_SYSTEM_PROMPT
          ? 'FINDINGS_JSON'
          : activeSystemPrompt === NEW_SYSTEM_PROMPT
            ? 'NEW'
            : activeSystemPrompt === SYSTEM_PROMPT
              ? 'SYSTEM'
              : 'custom';
      await captureAnalysisRun({
        matchId,
        model,
        promptId,
        activeSystemPrompt,
        flags: { findingsJson: Boolean(findingsJson), useTimelinePrompt: Boolean(useTimelinePrompt) },
        matchContext,
        analysisProse: typeof responseBody.analysis === 'string' ? responseBody.analysis : '',
        findings: (responseBody.findings as unknown) ?? null,
        parseOk,
        parseError,
        rawText: content.text,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        durationMs,
      });
    }
    return res.status(200).json(responseBody);
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: `AI analysis failed: ${errMessage}` });
  }
}
