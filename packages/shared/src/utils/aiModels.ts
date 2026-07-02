/**
 * Claude models selectable for AI match analysis.
 *
 * Single source of truth for the Settings dropdown and for server-side
 * validation in /api/analyze and /api/compare — never pass a client-supplied
 * model string to Anthropic without resolving it through this list.
 */
export interface AIModelOption {
  id: string;
  label: string;
  /** Shown in the Settings dropdown; input/output price per million tokens. */
  pricingHint: string;
  /**
   * Sonnet 5, Opus 4.7/4.8, and Fable 5 reject sampling parameters
   * (`temperature` returns a 400); older models still accept them.
   */
  supportsTemperature: boolean;
}

export const DEFAULT_AI_MODEL = 'claude-sonnet-4-6';

export const AI_MODEL_OPTIONS: AIModelOption[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', pricingHint: '$3/$15 per MTok', supportsTemperature: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', pricingHint: '$3/$15 per MTok', supportsTemperature: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', pricingHint: '$1/$5 per MTok', supportsTemperature: true },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', pricingHint: '$5/$25 per MTok', supportsTemperature: true },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', pricingHint: '$5/$25 per MTok', supportsTemperature: false },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', pricingHint: '$5/$25 per MTok', supportsTemperature: false },
  { id: 'claude-fable-5', label: 'Claude Fable 5', pricingHint: '$10/$50 per MTok', supportsTemperature: false },
];

/**
 * Resolve an untrusted model id to a known option, falling back to the
 * default. Returns the option so callers can read `supportsTemperature`.
 */
export function resolveAIModel(requested: unknown): AIModelOption {
  const match = typeof requested === 'string' ? AI_MODEL_OPTIONS.find((m) => m.id === requested) : undefined;
  return match ?? (AI_MODEL_OPTIONS.find((m) => m.id === DEFAULT_AI_MODEL) as AIModelOption);
}
