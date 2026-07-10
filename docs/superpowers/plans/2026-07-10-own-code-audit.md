# 子项目 0:自有代码合规审计 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 机器化审计用户在 fork 中新增的全部文件,产出逐文件 CLEAN / NEEDS_SCRUB / DERIVED 三分类报告 + 自有修改 hunk 附录,作为全新重写项目的移植依据。

**Architecture:** 一次性 Node ESM 脚本放在 `scratch/own-code-audit/`(该目录已被 .gitignore,不进任何仓库);三层检测:① git blob 精确匹配 → ② 复制起源检测 → ③ 规范化行片段相似度。只有两份 markdown 报告提交到 `docs/analysis/`。

**Tech Stack:** 纯 Node.js(ESM,无第三方依赖),git 命令行。

## Global Constraints

- merge-base(用户工作起点):`7842b644`;上游引用:`upstream/main`(已 fetch 到本仓库);ND 期起点(上游最后 MIT commit 之后):`04f56d8e`。
- 检测阈值(spec 规定,首轮跑完可调但必须记录在报告中):连续公共行 run ≥ **8** 或与任一上游文件共享行占比 > **30%** → `NEEDS_SCRUB`;规范化后长度 < **12** 字符的行不参与比对。
- 拿不准一律降级:宁可 `NEEDS_SCRUB` 不放行。**禁止**为了让对照通过而放松阈值(参照仓库 CLAUDE.md 的 Eval Integrity 精神:诚实的部分结果 > 好看的假结果)。
- 上游 = `upstream/main` **全历史**的所有 blob(MIT 期 + ND 期都算,因为新项目一行上游代码不用)。
- 审计对象 = `git diff --diff-filter=A --name-only 7842b644 main` 中仍存在于 main 树、扩展名为 ts/tsx/js/jsx/mjs/cjs/json/md/txt 的文件。代码文件走三层;json/md/txt 只走 ①②(spec:数据文件按来源归属判断)。
- 工作目录:仓库根 `/Users/mingjianliu/code/wowarenalogs`。所有脚本用 `node --max-old-space-size=8192` 运行(上游全历史行索引在内存里,几百 MB 量级)。
- 提交物只有两份:`docs/analysis/2026-07-10-own-code-audit.md`(报告)和 `docs/analysis/2026-07-10-own-code-audit-hunks.md`(hunk 附录)。scratch 下的脚本、results.json、patch 文件都不提交。

---

### Task 1: 共享库 lib.mjs(git 封装、行规范化、run/ratio 算法)

**Files:**

- Create: `scratch/own-code-audit/lib.mjs`
- Test: `scratch/own-code-audit/lib.test.mjs`

**Interfaces:**

- Consumes: 无(最底层)。
- Produces(后续两个脚本 import):
  - 常量 `MERGE_BASE: string`、`UPSTREAM_REF: string`、`ND_BASE: string`、`MIN_LINE_LEN: number`、`RUN_THRESHOLD: number`、`RATIO_THRESHOLD: number`
  - `git(args: string[], input?: string): string` — 同步跑 git,返回 stdout;`gitBuffer(args, input?): Buffer` — 同上但返回 Buffer(供 cat-file --batch 按字节解析)
  - `isCodeFile(path: string): boolean`
  - `normalizeLines(source: string): string[]` — 去块注释/行注释、空白折叠、丢弃短行
  - `longestCommonRun(a: string[], b: string[]): number` — 最长连续公共行块(对角线法,O(匹配数))
  - `sharedRatio(ownLines: string[], otherLineSet: Set<string>): number`

- [ ] **Step 1: 写 lib.mjs**

```js
// scratch/own-code-audit/lib.mjs
import { execFileSync } from 'node:child_process';

export const MERGE_BASE = '7842b644';
export const UPSTREAM_REF = 'upstream/main';
export const ND_BASE = '04f56d8e';
export const MIN_LINE_LEN = 12;
export const RUN_THRESHOLD = 8;
export const RATIO_THRESHOLD = 0.3;

export function git(args, input) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
}

// cat-file --batch 的 size 是字节数,必须用 Buffer 解析(utf8 往返会破坏非 UTF-8 blob 的偏移)
export function gitBuffer(args, input) {
  return execFileSync('git', args, {
    maxBuffer: 1024 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
}

const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
export function isCodeFile(p) {
  return CODE_EXTS.some((e) => p.endsWith(e));
}

export function normalizeLines(source) {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const raw of noBlock.split('\n')) {
    const line = raw
      .replace(/\/\/.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line.length >= MIN_LINE_LEN) out.push(line);
  }
  return out;
}

// 最长连续公共行块。对角线动态规划:run 结束于 (i,j) 时长度 = 结束于 (i-1,j-1) 的 run + 1,
// 对角线编号 j - i 不变,所以只需保留上一行 i-1 的对角线表。
export function longestCommonRun(a, b) {
  const positions = new Map();
  b.forEach((line, j) => {
    if (!positions.has(line)) positions.set(line, []);
    positions.get(line).push(j);
  });
  let best = 0;
  let prevDiag = new Map();
  for (let i = 0; i < a.length; i++) {
    const diag = new Map();
    const js = positions.get(a[i]);
    if (js) {
      for (const j of js) {
        const run = (prevDiag.get(j - i) || 0) + 1;
        diag.set(j - i, run);
        if (run > best) best = run;
      }
    }
    prevDiag = diag;
  }
  return best;
}

export function sharedRatio(ownLines, otherLineSet) {
  if (ownLines.length === 0) return 0;
  let hit = 0;
  for (const l of ownLines) if (otherLineSet.has(l)) hit++;
  return hit / ownLines.length;
}
```

- [ ] **Step 2: 写测试 lib.test.mjs**

```js
// scratch/own-code-audit/lib.test.mjs
import assert from 'node:assert';
import { normalizeLines, longestCommonRun, sharedRatio, git, MERGE_BASE } from './lib.mjs';

// normalizeLines: 去注释、折叠空白、丢短行
const src = [
  '// pure comment line',
  'const answerToEverything = 42; // trailing',
  '/* block',
  '   comment */',
  "const   greetingMessage =    'hello world';",
  '{',
].join('\n');
assert.deepStrictEqual(normalizeLines(src), [
  'const answerToEverything = 42;',
  "const greetingMessage = 'hello world';",
]);

// longestCommonRun: [B,C,D] 连续出现在两边 → 3;完全无交集 → 0
const A = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'eeeeeeeeeeee'];
const B = ['xxxxxxxxxxxx', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'yyyyyyyyyyyy'];
assert.strictEqual(longestCommonRun(A, B), 3);
assert.strictEqual(longestCommonRun(A, ['zzzzzzzzzzzz']), 0);
// 重复行不虚增 run:A 里的 b,c 在 B2 中乱序出现 → run 1
assert.strictEqual(longestCommonRun(A, ['cccccccccccc', 'zzzzzzzzzzzz', 'bbbbbbbbbbbb']), 1);

// sharedRatio
assert.strictEqual(sharedRatio(A, new Set(['bbbbbbbbbbbb', 'cccccccccccc'])), 0.4);
assert.strictEqual(sharedRatio([], new Set(['x'])), 0);

// git 封装冒烟:merge-base 能解析
assert.match(git(['rev-parse', MERGE_BASE]).trim(), /^[0-9a-f]{40}$/);

console.log('lib.test.mjs: all assertions passed');
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd /Users/mingjianliu/code/wowarenalogs && node scratch/own-code-audit/lib.test.mjs`
Expected: `lib.test.mjs: all assertions passed`

- [ ] **Step 4: 变异验证(确认测试真的在测)**

把 `longestCommonRun` 里 `+ 1` 临时改成 `+ 2`,重跑测试,Expected: AssertionError(run 值不对)。改回 `+ 1`,重跑,Expected: 通过。

(scratch/ 已 gitignore,本任务无 commit 步骤;后续任务同理,只有 docs/ 产物才 commit。)

---

### Task 2: audit.mjs 骨架 + 检测层 ①②(blob 精确匹配、复制起源)+ 对照框架

**Files:**

- Create: `scratch/own-code-audit/audit.mjs`

**Interfaces:**

- Consumes: `lib.mjs` 的全部导出。
- Produces:
  - CLI `node audit.mjs --controls` — 跑三个校准对照,全过 exit 0,任一失败 exit 1
  - CLI `node audit.mjs` — 全量审计(Task 4 启用,本任务先留 TODO 位)
  - 内部函数(Task 3 扩展):`classifyContent(relPath, content, ctx): { verdict, evidence }`,verdict ∈ `'CLEAN' | 'NEEDS_SCRUB' | 'DERIVED'`;`buildContext(): ctx`,ctx 含 `blobs: Map<sha, examplePath>`(上游全历史 blob → 示例路径)

- [ ] **Step 1: 写 audit.mjs(层①②+对照,层③留桩)**

```js
// scratch/own-code-audit/audit.mjs
import fs from 'node:fs';
import {
  git,
  gitBuffer,
  isCodeFile,
  normalizeLines,
  longestCommonRun,
  sharedRatio,
  MERGE_BASE,
  UPSTREAM_REF,
  RUN_THRESHOLD,
  RATIO_THRESHOLD,
} from './lib.mjs';

const AUDIT_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt)$/;

// ---------- 上游库存:全历史 blob sha -> 示例路径 ----------
function upstreamObjects() {
  const raw = git(['rev-list', '--objects', UPSTREAM_REF]);
  const blobs = new Map();
  for (const line of raw.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const sha = line.slice(0, sp);
    const p = line.slice(sp + 1);
    if (AUDIT_EXTS.test(p) && !blobs.has(sha)) blobs.set(sha, p);
  }
  return blobs;
}

// ---------- 批量读 blob(git cat-file --batch,分块喂 stdin) ----------
export function* catBlobs(shas, chunkSize = 400) {
  for (let i = 0; i < shas.length; i += chunkSize) {
    const chunk = shas.slice(i, i + chunkSize);
    const b = gitBuffer(['cat-file', '--batch'], chunk.join('\n') + '\n');
    let off = 0;
    while (off < b.length) {
      const nl = b.indexOf(10, off);
      if (nl === -1) break;
      const [sha, type, sizeStr] = b.slice(off, nl).toString('utf8').split(' ');
      const size = parseInt(sizeStr, 10);
      if (type !== 'blob' || Number.isNaN(size)) {
        off = nl + 1;
        continue;
      }
      yield { sha, content: b.slice(nl + 1, nl + 1 + size).toString('utf8') };
      off = nl + 1 + size + 1;
    }
  }
}

// ---------- 层②:复制起源(文件以 copy/rename 上游内容诞生) ----------
function copyOrigin(relPath, upstreamBlobs) {
  const addCommit = git(['log', '--diff-filter=A', '--format=%H', '-1', 'main', '--', relPath]).trim();
  if (!addCommit) return null;
  const raw = git(['show', '--raw', '-C', '-C', '--format=', addCommit, '--', relPath]);
  for (const line of raw.split('\n')) {
    const m = line.match(/^:\d+ \d+ \S+ \S+ ([CR])\d*\t([^\t]+)\t(.+)$/);
    if (m && m[3] === relPath) {
      let srcSha = '';
      try {
        srcSha = git(['rev-parse', `${addCommit}^:${m[2]}`]).trim();
      } catch {
        /* src 不在父提交 */
      }
      if (srcSha && upstreamBlobs.has(srcSha)) {
        return { addCommit: addCommit.slice(0, 8), srcPath: m[2], srcSha };
      }
    }
  }
  return null;
}

// ---------- 分类(层③在 Task 3 补全) ----------
export function classifyContent(relPath, content, ctx, opts = {}) {
  // 层①:内容与上游任一历史版本完全一致
  const sha = git(['hash-object', '--stdin'], content).trim();
  if (ctx.blobs.has(sha)) {
    return { verdict: 'DERIVED', evidence: { layer: 1, exactMatch: ctx.blobs.get(sha), sha } };
  }
  // 层②:git 复制起源(只对仓库内真实路径有意义,对照文件跳过)
  if (!opts.skipCopyOrigin) {
    const co = copyOrigin(relPath, ctx.blobs);
    if (co) return { verdict: 'DERIVED', evidence: { layer: 2, ...co } };
  }
  // 层③:片段相似度 —— Task 3 实现;当前桩返回 CLEAN
  return { verdict: 'CLEAN', evidence: { layer: 3, note: 'similarity layer not implemented yet' } };
}

export function buildContext() {
  console.error('building upstream inventory...');
  const blobs = upstreamObjects();
  console.error(`upstream blobs (audited extensions): ${blobs.size}`);
  return { blobs };
}

// ---------- 校准对照 ----------
function runControls() {
  const ctx = buildContext();
  const posContent = git(['show', `${UPSTREAM_REF}:packages/parser/src/index.ts`]);
  const upstreamHead = posContent.split('\n').slice(0, 40).join('\n');
  const filler = Array.from({ length: 60 }, (_, k) => `const controlFillerVariableNumber${k} = ${k} * 1000 + 7;`).join(
    '\n',
  );
  const negContent = fs.readFileSync('packages/tools/src/checkJudgeCalibration.ts', 'utf8');

  const cases = [
    ['positive', 'DERIVED', classifyContent('CONTROL_pos.ts', posContent, ctx, { skipCopyOrigin: true })],
    [
      'scrub',
      'NEEDS_SCRUB',
      classifyContent('CONTROL_scrub.ts', upstreamHead + '\n' + filler, ctx, { skipCopyOrigin: true }),
    ],
    ['negative', 'CLEAN', classifyContent('CONTROL_neg.ts', negContent, ctx, { skipCopyOrigin: true })],
  ];
  let failed = 0;
  for (const [name, expected, res] of cases) {
    const ok = res.verdict === expected;
    if (!ok) failed++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${name}: expected ${expected}, got ${res.verdict}`,
      JSON.stringify(res.evidence),
    );
  }
  process.exit(failed ? 1 : 0);
}

const mode = process.argv[2];
if (mode === '--controls') runControls();
else if (mode === undefined) {
  console.error('full audit: implemented in Task 4');
  process.exit(2);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
```

- [ ] **Step 2: 跑对照,验证层①工作、层③桩如预期失败**

Run: `cd /Users/mingjianliu/code/wowarenalogs && node --max-old-space-size=8192 scratch/own-code-audit/audit.mjs --controls`
Expected(层③还没实现,scrub 对照必须 FAIL——这是 TDD 的红灯):

```
PASS positive: expected DERIVED, got DERIVED {"layer":1,...}
FAIL scrub: expected NEEDS_SCRUB, got CLEAN {...}
PASS negative: expected CLEAN, got CLEAN {...}
```

exit code 1。若 positive 也 FAIL,先排查 `upstream/main:packages/parser/src/index.ts` 是否存在(`git show upstream/main:packages/parser/src/index.ts | head -3`),换成任一存在的上游 ts 文件路径,并在脚本注释里记录替换原因。

---

### Task 3: 检测层③(片段相似度)+ 三个对照全绿

**Files:**

- Modify: `scratch/own-code-audit/audit.mjs`(替换 `classifyContent` 的层③桩;`buildContext` 增加行索引)

**Interfaces:**

- Consumes: Task 2 的骨架。
- Produces: `buildContext()` 返回的 ctx 增加 `blobLines: Map<sha, string[]>` 与 `lineToBlobs: Map<string, Set<sha>>`;`classifyContent` 层③真实实现(供 Task 4 全量循环直接复用,签名不变)。

- [ ] **Step 1: buildContext 增加上游代码 blob 行索引**

将 `buildContext` 替换为:

```js
export function buildContext() {
  console.error('building upstream inventory...');
  const blobs = upstreamObjects();
  console.error(`upstream blobs (audited extensions): ${blobs.size}`);

  const codeShas = [...blobs.keys()].filter((sha) => isCodeFile(blobs.get(sha)));
  console.error(`indexing ${codeShas.length} upstream code blobs...`);
  const blobLines = new Map();
  const lineToBlobs = new Map();
  const CAP = 200; // 出现在 >200 个 blob 里的行是无信号的样板行,截断以省内存
  let done = 0;
  for (const { sha, content } of catBlobs(codeShas)) {
    const lines = normalizeLines(content);
    blobLines.set(sha, lines);
    for (const l of new Set(lines)) {
      let s = lineToBlobs.get(l);
      if (!s) lineToBlobs.set(l, (s = new Set()));
      if (s.size < CAP) s.add(sha);
    }
    if (++done % 5000 === 0) console.error(`  ${done}/${codeShas.length}`);
  }
  return { blobs, blobLines, lineToBlobs };
}
```

- [ ] **Step 2: classifyContent 层③真实实现**

将层③桩替换为:

```js
// 层③:片段相似度(仅代码文件)
if (!isCodeFile(relPath)) {
  return { verdict: 'CLEAN', evidence: { layer: 3, note: 'non-code: layers 1-2 only' } };
}
const ownLines = normalizeLines(content);
if (ownLines.length === 0) return { verdict: 'CLEAN', evidence: { layer: 3, note: 'no substantive lines' } };

const counts = new Map();
for (const l of new Set(ownLines)) {
  const set = ctx.lineToBlobs.get(l);
  if (set) for (const b of set) counts.set(b, (counts.get(b) || 0) + 1);
}
const candidates = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);

let best = { sha: null, path: null, run: 0, ratio: 0 };
for (const [bSha] of candidates) {
  const bLines = ctx.blobLines.get(bSha);
  const run = longestCommonRun(ownLines, bLines);
  const ratio = sharedRatio(ownLines, new Set(bLines));
  if (run > best.run || (run === best.run && ratio > best.ratio)) {
    best = { sha: bSha, path: ctx.blobs.get(bSha), run, ratio };
  }
}
if (best.run >= RUN_THRESHOLD || best.ratio > RATIO_THRESHOLD) {
  return { verdict: 'NEEDS_SCRUB', evidence: { layer: 3, best } };
}
return { verdict: 'CLEAN', evidence: { layer: 3, best } };
```

- [ ] **Step 3: 跑对照,三个全绿**

Run: `cd /Users/mingjianliu/code/wowarenalogs && node --max-old-space-size=8192 scratch/own-code-audit/audit.mjs --controls`
Expected(索引构建约几分钟):

```
PASS positive: expected DERIVED, got DERIVED ...
PASS scrub: expected NEEDS_SCRUB, got NEEDS_SCRUB ...
PASS negative: expected CLEAN, got CLEAN ...
```

exit code 0。

**若 negative 对照 FAIL(报 NEEDS_SCRUB)**:先看 evidence 里的 best.path/run/ratio,人工对比两个文件对应片段。若确属误报样板行,把 `MIN_LINE_LEN` 上调(如 16)重测并在报告里记录;**若确实是拷贝的上游片段,这是审计的正确发现——换一个真正纯原创的文件当负对照(候选:`packages/tools/src/abCompareStats.ts`),原文件留给全量审计如实分类,禁止调阈值放行。**

---

### Task 4: 全量审计 + 报告生成 + 提交

**Files:**

- Modify: `scratch/own-code-audit/audit.mjs`(补全无参模式)
- Create(脚本生成): `scratch/own-code-audit/results.json`(不提交)、`docs/analysis/2026-07-10-own-code-audit.md`(提交)

**Interfaces:**

- Consumes: Task 3 的 `buildContext`/`classifyContent`。
- Produces: `results.json` 数组,元素 `{ path, verdict, evidence }`;报告 md。Task 5 与后续子项目按 verdict 消费:CLEAN → 直接移植,NEEDS_SCRUB → 清洗片段,DERIVED → 重写。

- [ ] **Step 1: 实现全量模式**

把 `else if (mode === undefined) {...}` 分支替换为:

```js
else if (mode === undefined) {
  const ctx = buildContext();
  // 审计对象:merge-base 之后新增、仍在 main 树上、扩展名匹配
  const added = git(['diff', '--diff-filter=A', '--name-only', MERGE_BASE, 'main'])
    .split('\n').filter((p) => p && AUDIT_EXTS.test(p));
  const mainTree = new Set(
    git(['ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean),
  );
  const targets = added.filter((p) => mainTree.has(p));
  console.error(`auditing ${targets.length} files (${added.length} added, ${added.length - targets.length} since deleted)`);

  const results = [];
  let done = 0;
  for (const p of targets) {
    const content = git(['show', `main:${p}`]);
    results.push({ path: p, ...classifyContent(p, content, ctx) });
    if (++done % 100 === 0) console.error(`  ${done}/${targets.length}`);
  }
  fs.writeFileSync('scratch/own-code-audit/results.json', JSON.stringify(results, null, 1));

  // ---- 报告 ----
  const by = (v) => results.filter((r) => r.verdict === v);
  const fmtScrub = (r) =>
    `- \`${r.path}\` — 最相似上游: \`${r.evidence.best?.path}\` (run ${r.evidence.best?.run}, ratio ${(r.evidence.best?.ratio * 100).toFixed(0)}%)`;
  const fmtDerived = (r) =>
    `- \`${r.path}\` — ${r.evidence.layer === 1 ? `与上游 blob 完全一致: \`${r.evidence.exactMatch}\`` : `复制自上游 \`${r.evidence.srcPath}\` (commit ${r.evidence.addCommit})`}`;
  const report = `# 自有代码合规审计报告

日期:2026-07-10。工具:\`scratch/own-code-audit/\`(本地,一次性)。对应 spec:\`docs/superpowers/specs/2026-07-10-clean-rewrite-roadmap-design.md\` 子项目 0。

## 方法与阈值

- 审计对象:merge-base \`${MERGE_BASE}\` 之后新增且仍在 main 的文件(ts/tsx/js/jsx/mjs/cjs 走三层;json/md/txt 只走层①②)。
- 上游 = upstream/main 全历史 blob(MIT 期 + ND 期)。
- 层① blob 精确匹配 → DERIVED;层② git copy/rename 起源于上游内容 → DERIVED;层③ 规范化行(去注释、折叠空白、丢弃 <${'${MIN_LINE_LEN}'} 字符行)连续公共块 ≥ ${RUN_THRESHOLD} 行或共享行占比 > ${RATIO_THRESHOLD * 100}% → NEEDS_SCRUB。
- 校准对照:positive(上游文件原文 → DERIVED)/ scrub(上游片段+原创填充 → NEEDS_SCRUB)/ negative(纯原创文件 → CLEAN)全部通过,见 Task 3 执行记录。

## 统计

| 分类 | 数量 |
| --- | --- |
| CLEAN(直接移植) | ${by('CLEAN').length} |
| NEEDS_SCRUB(清洗片段后移植) | ${by('NEEDS_SCRUB').length} |
| DERIVED(整体衍生,需重写) | ${by('DERIVED').length} |
| 合计 | ${results.length} |

## DERIVED 清单

${by('DERIVED').map(fmtDerived).join('\n') || '(无)'}

## NEEDS_SCRUB 清单

${by('NEEDS_SCRUB').map(fmtScrub).join('\n') || '(无)'}

## CLEAN 清单

<details><summary>${by('CLEAN').length} 个文件</summary>

${by('CLEAN').map((r) => `- \`${r.path}\``).join('\n')}

</details>

## 附录

自有修改 hunk 清单见 \`docs/analysis/2026-07-10-own-code-audit-hunks.md\`(Task 5 生成)。
`;
  fs.writeFileSync('docs/analysis/2026-07-10-own-code-audit.md', report);
  console.log(`CLEAN=${by('CLEAN').length} NEEDS_SCRUB=${by('NEEDS_SCRUB').length} DERIVED=${by('DERIVED').length} total=${results.length}`);
}
```

注意:模板字符串里嵌套的 `${'${MIN_LINE_LEN}'}` 写法是为了在报告里输出实际数值——实现时直接写 `${MIN_LINE_LEN}` 即可(lib.mjs 已导出,记得在 import 列表加上)。

- [ ] **Step 2: 全量跑**

Run: `cd /Users/mingjianliu/code/wowarenalogs && node --max-old-space-size=8192 scratch/own-code-audit/audit.mjs`
Expected: 最后一行形如 `CLEAN=… NEEDS_SCRUB=… DERIVED=… total=…`,total 等于 targets 数,无异常栈。运行时间十几分钟量级(层②每文件一次 git log)。

- [ ] **Step 3: 抽查验证(不许跳过)**

1. `python3 -c "import json;d=json.load(open('scratch/own-code-audit/results.json'));print(len(d), sum(1 for r in d if r['verdict'] not in ('CLEAN','NEEDS_SCRUB','DERIVED')))"` → 第二个数必须是 0(零未分类)。
2. 负对照文件在全量结果中也应 CLEAN:`python3 -c "import json;print([r for r in json.load(open('scratch/own-code-audit/results.json')) if r['path']=='packages/tools/src/checkJudgeCalibration.ts'])"`。
3. 从 NEEDS_SCRUB 清单随机挑 2 个,人工打开自有文件与 evidence 里的上游文件对比,确认片段确实相似(或记录为误报并按 Task 3 的规则处理阈值调整)。
4. 从 DERIVED 清单挑 1 个(若有),用 `git show <upstream-blob>` 对比确认。

- [ ] **Step 4: 提交报告**

```bash
git add docs/analysis/2026-07-10-own-code-audit.md
git commit -m "docs(analysis): own-code compliance audit report (sub-project 0)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 自有修改 hunk 附录 + 收尾

**Files:**

- Create: `scratch/own-code-audit/extractHunks.mjs`
- Create(脚本生成): `scratch/own-code-audit/own-hunks.patch`(不提交)、`docs/analysis/2026-07-10-own-code-audit-hunks.md`(提交)

**Interfaces:**

- Consumes: `lib.mjs`(`git`, `MERGE_BASE`, `ND_BASE`)。
- Produces: hunk 附录 md(子项目 4"提取逻辑重新安家"时的工作清单);完整 patch 存本地备查。

- [ ] **Step 1: 写 extractHunks.mjs**

```js
// scratch/own-code-audit/extractHunks.mjs
import fs from 'node:fs';
import { git, MERGE_BASE, ND_BASE } from './lib.mjs';

// 用户修改过(非新增)的上游文件
const modified = git(['diff', '--diff-filter=M', '--name-only', MERGE_BASE, 'main']).split('\n').filter(Boolean);

// ND 期上游也动过的文件(修改建立在 ND 版本之上,提取时要格外小心)
const ndTouched = new Set(git(['diff', '--name-only', ND_BASE, MERGE_BASE]).split('\n').filter(Boolean));

// 完整 patch(本地备查,不提交)
fs.writeFileSync('scratch/own-code-audit/own-hunks.patch', git(['diff', MERGE_BASE, 'main', '--', ...modified]));

// numstat 汇总
const rows = git(['diff', '--numstat', MERGE_BASE, 'main', '--', ...modified])
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [add, del, p] = l.split('\t');
    return { p, add, del, nd: ndTouched.has(p) };
  })
  .sort((a, b) => b.nd - a.nd || (parseInt(b.add, 10) || 0) - (parseInt(a.add, 10) || 0));

const overlapCount = rows.filter((r) => r.nd).length;
const md = `# 自有修改 hunk 附录(审计报告附录)

日期:2026-07-10。主报告:\`docs/analysis/2026-07-10-own-code-audit.md\`。

以下 ${rows.length} 个上游文件含有用户自己的修改。移植规则(见 spec):**只提取自有逻辑重新安家,不携带上游文件本体。**
标 ⚠️ 的 ${overlapCount} 个文件在 ND 期(\`${ND_BASE}\`→\`${MERGE_BASE}\`)也被上游改过——自有修改叠在 ND 版本之上,提取时必须逐 hunk 对照 MIT 版,确认不夹带 ND 期上游行。

完整 diff 在本地 \`scratch/own-code-audit/own-hunks.patch\`(不提交;查看单文件:\`git diff ${MERGE_BASE} main -- <path>\`)。

| 文件 | +行 | -行 | ND 期重叠 |
| --- | --- | --- | --- |
${rows.map((r) => `| \`${r.p}\` | ${r.add} | ${r.del} | ${r.nd ? '⚠️' : ''} |`).join('\n')}
`;
fs.writeFileSync('docs/analysis/2026-07-10-own-code-audit-hunks.md', md);
console.log(
  `modified=${rows.length} ndOverlap=${overlapCount} patchBytes=${fs.statSync('scratch/own-code-audit/own-hunks.patch').size}`,
);
```

- [ ] **Step 2: 运行并核对**

Run: `cd /Users/mingjianliu/code/wowarenalogs && node scratch/own-code-audit/extractHunks.mjs`
Expected: 输出形如 `modified=… ndOverlap=… patchBytes=…`。核对:`ndOverlap` 应接近本次调研测得的 58(允许因 fixture/lock 过滤有小偏差,但量级必须一致;偏差大则排查 ND_BASE/MERGE_BASE 是否写错)。

- [ ] **Step 3: 抽查一个 ⚠️ 文件**

挑 `packages/parser/src/CombatData.ts`(已知在重叠清单里),跑 `git diff 7842b644 main -- packages/parser/src/CombatData.ts | head -50`,确认 patch 内容与附录表格行数方向一致。

- [ ] **Step 4: 提交附录**

```bash
git add docs/analysis/2026-07-10-own-code-audit-hunks.md
git commit -m "docs(analysis): own-modification hunk appendix for audit report

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 完成定义(对照 spec 成功标准)

- [ ] 全部自有新增文件有三分类结论,零未审计(Task 4 Step 3 第 1 项)。
- [ ] 三个校准对照通过(Task 3 Step 3)。
- [ ] NEEDS_SCRUB/DERIVED 均附上游对应文件证据,抽查复核通过(Task 4 Step 3 第 3、4 项)。
- [ ] 两份报告已提交;审计工具留在 scratch(gitignored)。
