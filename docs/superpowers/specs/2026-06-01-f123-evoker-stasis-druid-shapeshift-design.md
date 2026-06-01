# Spec: F123 Evoker Stasis & Druid Shapeshift Injections

## Background & Goal
Improve LLM analysis of Preservation Evoker and Druid matches by adding context-aware state indicators to the timeline and prompt:
1. **Evoker Stasis:** Track when heals (Dream Breath, Reversion, etc.) are cast into Stasis and when they are released. Avoid timeline duplication by completely skipping individual stored casts, presenting only the consolidated release event.
2. **Druid Shapeshifts:** Track time spent in Cat and Bear forms to help the AI detect defensive posturing (Bear Form) or offensive pressure (Cat Form).

---

## 1. Utilities Setup

### `combatStates.ts`
We will add `packages/shared/src/utils/combatStates.ts` to implement the following core parsing utilities:
* `extractStasisEvents(unit, combat)`:
  * Looks for `SPELL_AURA_APPLIED` and `SPELL_AURA_REMOVED` for the Stasis buff (`370537`).
  * Gathers up to three valid healing casts (`Dream Breath`, `Spiritbloom`, `Reversion`, `Emerald Blossom`, `Verdant Embrace`, `Living Flame`) that occur within this window.
  * Emits an array of `IStasisEvent` objects carrying `{ startSeconds, releaseSeconds, spells: string[] }`.
* `extractShapeshiftIntervals(unit, combat)`:
  * Watches Druid form changes: Bear Form (`5487`, `9634`) and Cat Form (`768`).
  * Emits an array of `IFormInterval` objects carrying `{ form, startSeconds, endSeconds }`.

---

## 2. Match Timeline Modifications

### Evoker Stasis
* In `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`:
  * During owner cast processing, if the cast is within a Stasis window and is one of the spells buffered by Stasis, we unconditionally skip it (`continue`).
  * Add the `[YOU] [STASIS RELEASE]` event to the timeline:
    ```
    [Time]  [YOU] [STASIS RELEASE] → Spell1, Spell2, Spell3
    ```

### Druid Shapeshifts
* For Verbose mode, enter `[SHIFT]` events:
  ```
  [Time]  [YOU/TEAM/ENEMY] [SHIFT] [Player] entered [Form] Form
  ```
* For Summary mode (used by the LLM prompt), print a summary header under `## NOTABLE STATES` above the timeline:
  ```
  ## NOTABLE STATES
  - YOU spent Xs in Bear Form.
  - [Player] (Restoration Druid) spent Ys in Cat Form.
  ```

---

## 3. Verification Plan

* **Unit Tests:** Add `packages/shared/src/utils/__tests__/combatStates.test.ts` to assert that:
  * Form intervals are accurately computed, including form-hold to match end.
  * Stasis heals are correctly captured and non-healing/utility spells are filtered out.
  * Event ordering at the exact same timestamp is correctly handled.
* **Compilation & Linting:** Run `npm run typecheck` and `npm run lint` across workspaces.
