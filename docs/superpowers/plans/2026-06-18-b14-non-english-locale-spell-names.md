# B14: Non-English Locale Spell-Name Leak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back `getEnglishSpellName` with a complete spell ID to English name mapping (`spellNames.json`) generated from wago.tools `SpellName` CSV, ensuring that timeline events (casts, cleanses, death top-damage, etc.) do not leak localized spell names (such as Chinese) in prompts built from non-English clients.

**Architecture:**
1. Update `packages/tools/src/generateSpellIdLists.ts` to output `packages/shared/src/data/spellNames.json` mapping all spell IDs to English names.
2. Update `packages/tools/src/generateDataManifest.ts` to register `spellNames.json`.
3. Update `packages/shared/src/data/spellEffectData.ts` to load `spellNames.json` and use it inside `getEnglishSpellName(spellId, fallback)`.
4. Create a unit test `packages/shared/src/data/__tests__/spellEffectData.test.ts` to verify resolution.
5. Re-run data generation to write the `spellNames.json` database and regenerate the manifest.

**Tech Stack:** TypeScript, Jest, Node.js

---

### Task 1: Update generateSpellIdLists.ts to output spellNames.json

**Files:**
- Modify: `packages/tools/src/generateSpellIdLists.ts`

- [ ] **Step 1: Write code in generateSpellIdLists.ts to output spellNames.json**
  Update `packages/tools/src/generateSpellIdLists.ts` to output a clean flat mapping of `ID` -> `Name_lang` to `packages/shared/src/data/spellNames.json`.
  Replace:
  ```typescript
    const outputPath = path.resolve(__dirname, '../../shared/src/data/spellIdLists.json');
    const reviewDirPath = path.resolve(__dirname, '../../shared/src/data/spellIdListsReview');
    await fs.ensureDir(reviewDirPath);
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  ```
  With:
  ```typescript
    const outputPath = path.resolve(__dirname, '../../shared/src/data/spellIdLists.json');
    const reviewDirPath = path.resolve(__dirname, '../../shared/src/data/spellIdListsReview');
    await fs.ensureDir(reviewDirPath);
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);

    // Write complete spell names mapping to spellNames.json
    const spellNamesMap: Record<string, string> = {};
    spellNameRows.forEach((row) => {
      if (row.ID && row.Name_lang) {
        spellNamesMap[row.ID] = row.Name_lang;
      }
    });
    const spellNamesPath = path.resolve(__dirname, '../../shared/src/data/spellNames.json');
    await fs.writeFile(spellNamesPath, `${JSON.stringify(spellNamesMap, null, 2)}\n`);
  ```

- [ ] **Step 2: Add spellNames.json to generateDataManifest.ts**
  Modify `packages/tools/src/generateDataManifest.ts` to register the new `spellNames.json` file in `TRACKED_FILES`.
  Add this entry to `TRACKED_FILES` (around line 35):
  ```typescript
    {
      file: 'spellNames.json',
      description: 'English spell names mapping for all spell IDs from Wago.tools SpellName DB2',
      generatedBy: 'npm run start:generateSpellIdLists (packages/tools)',
      wowDataDependent: true,
    },
  ```

- [ ] **Step 3: Run data generation to write files and update manifest**
  Run the command from the repo root to pull spell metadata and regenerate files:
  `npm run -w @wowarenalogs/tools start:generateSpellIdLists`
  Then regenerate the manifest:
  `npm run -w @wowarenalogs/tools start:generateDataManifest`

- [ ] **Step 4: Commit**
  Stage the changes and newly created files:
  ```bash
  git add packages/tools/src/generateSpellIdLists.ts packages/tools/src/generateDataManifest.ts packages/shared/src/data/spellNames.json packages/shared/src/data/spellIdLists.json packages/shared/src/data/dataManifest.json
  git commit -m "feat(tools): generate spellNames.json mapping all spell IDs to English names"
  ```

---

### Task 2: Back getEnglishSpellName with spellNames.json

**Files:**
- Modify: `packages/shared/src/data/spellEffectData.ts`
- Create: `packages/shared/src/data/__tests__/spellEffectData.test.ts`

- [ ] **Step 1: Update spellEffectData.ts to import rawSpellNames and use in getEnglishSpellName**
  Modify `packages/shared/src/data/spellEffectData.ts` to load `spellNames.json` and use it inside `getEnglishSpellName`.
  Replace:
  ```typescript
  export function getEnglishSpellName(spellId: string, fallback?: string | null): string {
    return spellEffectData[spellId]?.name ?? fallback ?? spellId;
  }
  ```
  With:
  ```typescript
  import rawSpellNames from './spellNames.json';

  const spellNamesMap = rawSpellNames as unknown as Record<string, string>;

  export function getEnglishSpellName(spellId: string, fallback?: string | null): string {
    return spellNamesMap[spellId] ?? spellEffectData[spellId]?.name ?? fallback ?? spellId;
  }
  ```

- [ ] **Step 2: Add unit test in spellEffectData.test.ts**
  Create a new test file `packages/shared/src/data/__tests__/spellEffectData.test.ts` to verify `getEnglishSpellName` works for standard spells and heals:
  ```typescript
  import { getEnglishSpellName } from '../spellEffectData';

  describe('getEnglishSpellName', () => {
    it('resolves standard spells in the dictionary', () => {
      // 33206 is Pain Suppression
      expect(getEnglishSpellName('33206')).toBe('Pain Suppression');
    });

    it('resolves non-cooldown filler spells from spellNames.json', () => {
      // 85673 is Word of Glory
      expect(getEnglishSpellName('85673', 'Fallback')).toBe('Word of Glory');
    });

    it('returns the fallback if spell is missing from all dictionaries', () => {
      expect(getEnglishSpellName('9999999', 'My Fallback')).toBe('My Fallback');
    });

    it('returns the spell ID if no fallback is provided and spell is missing', () => {
      expect(getEnglishSpellName('9999999')).toBe('9999999');
    });
  });
  ```

- [ ] **Step 3: Run unit tests to verify they pass**
  Run: `npm run test -w @wowarenalogs/shared -- spellEffectData.test.ts`
  Expected: PASS

- [ ] **Step 4: Commit**
  Stage the changes and commit:
  ```bash
  git add packages/shared/src/data/spellEffectData.ts packages/shared/src/data/__tests__/spellEffectData.test.ts
  git commit -m "feat(shared): back getEnglishSpellName with spellNames.json and add tests"
  ```
