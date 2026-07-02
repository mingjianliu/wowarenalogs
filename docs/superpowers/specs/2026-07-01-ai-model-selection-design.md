# AI Model Selection Knob — Design

**Date:** 2026-07-01
**Status:** Approved (user selected: all 7 models, both endpoints)

## Problem

Both AI endpoints hardcoded `claude-sonnet-4-6`:

- `packages/web/pages/api/analyze.ts` (match analysis findings)
- `packages/web/pages/api/compare.ts` (healer comparison report)

Users had no way to trade cost vs quality (e.g. Haiku for cheap runs, Opus/Fable for depth).

## Design

### Shared model catalog — `packages/shared/src/utils/aiModels.ts`

Single source of truth for the Settings dropdown and server-side validation.
All 7 Messages-API models (as of 2026-06):

| id                            | label             | pricing | supportsTemperature |
| ----------------------------- | ----------------- | ------- | ------------------- |
| `claude-sonnet-4-6` (default) | Claude Sonnet 4.6 | $3/$15  | yes                 |
| `claude-sonnet-5`             | Claude Sonnet 5   | $3/$15  | no                  |
| `claude-haiku-4-5`            | Claude Haiku 4.5  | $1/$5   | yes                 |
| `claude-opus-4-6`             | Claude Opus 4.6   | $5/$25  | yes                 |
| `claude-opus-4-7`             | Claude Opus 4.7   | $5/$25  | no                  |
| `claude-opus-4-8`             | Claude Opus 4.8   | $5/$25  | no                  |
| `claude-fable-5`              | Claude Fable 5    | $10/$50 | no                  |

`resolveAIModel(unknown)` maps untrusted input to a known option, falling back
to the default — client-supplied model strings are never passed through raw.

### Storage (desktop)

`AppSettings.anthropicModel` in `settingsModule.ts` (settings.json), with
`getAnthropicModel`/`setAnthropicModel` module functions; preload regenerated
via `gen:app:preload`.

### UI

Dropdown in Settings → AI Analysis, under the API key field. Shows label +
pricing hint. Saves immediately via `setAnthropicModel` (isolated write, so an
unsaved API key edit is not persisted as a side effect). Both `saveSettings`
call sites include `anthropicModel` so full-object saves don't erase it.

### Request flow

`CombatAIAnalysis/index.tsx` reads the saved model and sends `model` in the
POST body to both `/api/analyze` and `/api/compare`. Endpoints resolve it via
`resolveAIModel`.

### Model-compatibility handling (server)

- **Temperature:** Sonnet 5 / Opus 4.7 / Opus 4.8 / Fable 5 reject sampling
  params with a 400 — `temperature: 0.3` is included only when
  `supportsTemperature` is true.
- **Refusal:** Fable 5 safety classifiers can return `stop_reason: "refusal"`
  with empty content. `analyze.ts` returns a clean 502; `compare.ts` degrades
  to no report (report was already optional there).
- **Empty content guard:** `content[0]` is optional-chained before `.type`.

## Testing

`packages/web/pages/api/__tests__/analyze.test.ts`: default/valid/unknown/
non-string model resolution, temperature inclusion and omission per model,
refusal → 502, empty content → 500, debug metadata reports selected model.
