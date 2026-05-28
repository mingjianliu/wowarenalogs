# F100: Healer Utility CD Gap Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lay on Hands, Power Word: Barrier, and Weapons of Order appear in COOLDOWN USAGE (old path), PLAYER LOADOUT (new path), and `[OWNER CD]` timeline events so Claude can analyze when healers use these major utility CDs.

**Architecture:** `extractMajorCooldowns` in `cooldowns.ts` filters spells by requiring a `spellEffectData` entry with CD ≥ 30s. These three spells are tagged `Defensive` or `Offensive` in `classMetadata.ts` (making them eligible) but are absent from `spellEffects.json` (causing them to be dropped). Fixing the gap requires: (1) adding entries to `spellEffects.json` with correct CD/duration data so they work now, and (2) adding their IDs to `MANUAL_SPELL_IDS` in `generateSpellsData.ts` so future `update-wow-data` regenerations preserve them.

**Tech Stack:** TypeScript, `spellEffects.json` (generated data override), `generateSpellsData.ts` (generation config).

---

## Root Cause

`generateSpellsData.ts` fetches spell data from wago.tools for IDs in:

1. `taggedSpellIds` — from `spells.json` (CC/aura-tracked spells)
2. `awcSpellIds` — from `awcSpells.ts` (AWC tournament spells)
3. `MANUAL_SPELL_IDS` — hardcoded additions (e.g., Evoker class spells)

These three utility spells are tagged in `classMetadata.ts` but absent from all three sources → absent from `spellEffects.json` → `extractMajorCooldowns` drops them → invisible everywhere.

| Spell               | ID     | Class   | classMetadata tag   | In spellEffects.json |
| ------------------- | ------ | ------- | ------------------- | -------------------- |
| Lay on Hands        | 633    | Paladin | Defensive           | ❌ MISSING           |
| Power Word: Barrier | 62618  | Priest  | Defensive           | ❌ MISSING           |
| Weapons of Order    | 311054 | Monk    | Offensive+Defensive | ❌ MISSING           |

**Aura Mastery (31821) already works** — it IS in `spells.json` and `spellEffects.json`. F100's mention of it as an example was imprecise.

---

## File Map

| File                                         | Change                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/shared/src/data/spellEffects.json` | Add 3 entries: Lay on Hands, Power Word: Barrier, Weapons of Order      |
| `packages/tools/src/generateSpellsData.ts`   | Add 3 IDs to `MANUAL_SPELL_IDS` so future wago.tools syncs include them |

No changes to `cooldowns.ts`, `classMetadata.ts`, `timelineHelpers.ts`, or `printMatchPrompts.ts`.

---

## Task 1: Add missing entries to `spellEffects.json` and `generateSpellsData.ts`

**Files:**

- Modify: `packages/shared/src/data/spellEffects.json`
- Modify: `packages/tools/src/generateSpellsData.ts:229-249`

### Spell data reference (retail WoW values)

- **Lay on Hands** (633): 10-minute CD (600s), instant (0s duration), Holy Paladin only
- **Power Word: Barrier** (62618): 3-minute CD (180s), 10s duration, Discipline Priest
- **Weapons of Order** (311054): 2-minute CD (120s), 30s duration, Mistweaver Monk

The `dispelType` field is `null` for all three (they aren't magic effects removable by dispel).

### Step 1.1 — Add entries to `spellEffects.json`

- [ ] **Step 1: Open `packages/shared/src/data/spellEffects.json` and add three new entries.**

The file is a JSON object keyed by spell ID string. Insert these three entries (alphabetically by spell ID — `"311054"` sorts before `"62618"` and `"633"` in string order; place them among nearby numeric keys or at the end):

```json
"633": {
  "spellId": "633",
  "name": "Lay on Hands",
  "cooldownSeconds": 600,
  "durationSeconds": 0,
  "dispelType": null
},
"62618": {
  "spellId": "62618",
  "name": "Power Word: Barrier",
  "cooldownSeconds": 180,
  "durationSeconds": 10,
  "dispelType": null
},
"311054": {
  "spellId": "311054",
  "name": "Weapons of Order",
  "cooldownSeconds": 120,
  "durationSeconds": 30,
  "dispelType": null
},
```

After adding, confirm the JSON is valid: `node -e "require('./packages/shared/src/data/spellEffects.json'); console.log('valid')"`

Expected: `valid`

### Step 1.2 — Add IDs to `MANUAL_SPELL_IDS` in `generateSpellsData.ts`

- [ ] **Step 2: Open `packages/tools/src/generateSpellsData.ts` and add the three spell IDs to `MANUAL_SPELL_IDS`.**

Find the existing `MANUAL_SPELL_IDS` array (around line 229):

```typescript
const MANUAL_SPELL_IDS: string[] = [
  // Evoker — not in spells.json (class added in Dragonflight)
  '351338', // Quell
  '357210', // Deep Breath
  ...'360828', // Blistering Scales
];
```

Add a new section at the end of the array (before the closing `]`):

```typescript
  // Healer utility CDs — tagged in classMetadata but absent from spells.json
  '633',  // Lay on Hands (Holy Paladin)
  '62618', // Power Word: Barrier (Disc Priest)
  '311054', // Weapons of Order (Mistweaver Monk)
```

Full updated array tail:

```typescript
const MANUAL_SPELL_IDS: string[] = [
  // Evoker — not in spells.json (class added in Dragonflight)
  '351338', // Quell
  '357210', // Deep Breath
  '368970', // Tail Swipe
  '357214', // Wing Buffet
  '374227', // Zephyr
  '374251', // Cauterizing Flame
  '378441', // Time Stop
  '375087', // Dragonrage
  '363916', // Obsidian Scales
  '370553', // Tip the Scales
  '359816', // Dream Flight
  '363534', // Rewind
  '370960', // Emerald Communion
  '370537', // Stasis
  '370665', // Rescue
  '403631', // Breath of Eons
  '404977', // Time Skip
  '360828', // Blistering Scales
  // Healer utility CDs — tagged in classMetadata but absent from spells.json
  '633', // Lay on Hands (Holy Paladin)
  '62618', // Power Word: Barrier (Disc Priest)
  '311054', // Weapons of Order (Mistweaver Monk)
];
```

### Step 1.3 — TypeScript check

- [ ] **Step 3: TypeScript check**

Run: `npm run -w @wowarenalogs/tools build 2>&1 | grep -i "error\|TS[0-9]" | head -20`

Expected: No errors.

### Step 1.4 — Functional verification

- [ ] **Step 4: Verify the spells appear in prompt output**

Run: `npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 10 --healer 2>/dev/null | grep -E "Lay on Hands|Power Word: Barrier|Weapons of Order"`

Expected: At least one line per match that has a Holy Paladin, Disc Priest, or Mistweaver Monk log owner. If no matching spec appears in the 10 sampled matches, try `--count 30`.

Note: these spells will only appear if:

1. The log owner is the relevant healer spec, AND
2. The player took the ability (talent check) OR cast it during the match

If no matches are sampled with these specs, verify manually by checking that `633` is in `spellEffects.json` and in `MANUAL_SPELL_IDS`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/data/spellEffects.json packages/tools/src/generateSpellsData.ts
git commit -m "feat(F100): add Lay on Hands, Power Word: Barrier, Weapons of Order to spellEffects

These healer utility CDs are tagged Defensive/Offensive in classMetadata but were
absent from spellEffects.json, causing extractMajorCooldowns to drop them. Now they
appear in COOLDOWN USAGE (old path) and PLAYER LOADOUT + [OWNER CD] (new path).
Also added IDs to MANUAL_SPELL_IDS so future update-wow-data runs preserve them."
```

---

## Task 2: Mark F100 done in TRACKER.md

**Files:**

- Modify: `TRACKER.md`

- [ ] **Step 1: Change F100 row from `Backlog` to `✅ Done`**

Before:

```
| F100 | Backlog | Healer-specific actions absent for non-healing utility ...
```

After:

```
| F100 | ✅ Done | Healer-specific actions absent for non-healing utility ...
```

- [ ] **Step 2: Commit**

```bash
git add TRACKER.md
git commit -m "chore: mark F100 done"
```

---

## Self-Review

**Spec coverage:** F100 asks for non-healing utility CDs to appear in the timeline. Lay on Hands, Power Word: Barrier, and Weapons of Order are the concrete gaps (tagged in classMetadata, absent from spellEffects). After this fix, they appear in COOLDOWN USAGE (old path) and PLAYER LOADOUT + `[OWNER CD]` (new path). ✓

**Placeholder scan:** No TBD/TODO. All code shown in full. ✓

**Type consistency:**

- `spellEffects.json` entries follow the exact schema of existing entries (`spellId`, `name`, `cooldownSeconds`, `durationSeconds`, `dispelType`). ✓
- `MANUAL_SPELL_IDS` is `string[]` — new entries are string literals. ✓

**Edge cases:**

- Lay on Hands `durationSeconds: 0` — it's instant, no buff duration. `extractOwnerCDBuffExpiry` checks `durationSeconds > 0` before emitting `[BUFF FADED]`, so no spurious buff-faded events. ✓
- These spells are only shown for the correct healer spec (existing SPEC_EXCLUSIVE_SPELLS and talent filtering handle this). ✓
- Lay on Hands already has the tag check for target HP (`targetHpPct`) — with it now in `extractMajorCooldowns`, casts will show target HP in the timeline. ✓

**What the fix does NOT change:**

- `Aura Mastery` — already works (in spells.json + spellEffects.json)
- `Devotion Aura` — passive aura, no cast event, cannot be timeline-tracked
- `Vigilance` — does not exist in modern retail WoW
