# C5: 跨族模型 Prompt 歧义审计 — 首轮真实结果

**日期：** 2026-07-07 · **审计模型：** Gemini 3.1 Pro (High)（经 agy-run）
**样本：** 真实语料 prompts 001（Disc Priest, Win）与 003（Disc Priest, Loss），各 ~15KB
**方法：** 让异族模型完整读取真实 user-prompt，列出无法自信解读的记号/字段/矛盾，并说明它会做何种假设。原始输出：scratchpad c5-001.txt / c5-003.txt（会话产物）；关键条目摘录如下。

## 结果：17 条报告，triage 后 5 类真实缺口

### 真实缺口（系统提示词 `analyzeSystemPrompts.ts` 中无定义，已核实）

1. **`[DR: Stun Full]` / `[DR: Incapacitate Full]`** — "Full" 可读作"完整时长（无 DR）"或"完全递减（免疫）"，语义相反。系统提示词 0 处定义 DR 记号。Gemini 假设了"无 DR 完整时长"（碰巧正确），但这是掷硬币。
2. **`[HEALING]` 行归属** — 未说明是 [YOU]、全队还是全场的治疗吞吐。Gemini 假设 [YOU]。
3. **`[OFFENSIVE WINDOW] 0.43M on 2`** — "on 2" 的方向（2 号造成 vs 2 号承受）未定义。
4. **`[DMG SPIKE]` 方向** — 数值单位有定义（M/k），但"该单位承受"的方向语义靠猜；且 99%→100% HP 与 "SPIKE" 直觉矛盾（治疗覆盖了伤害），值得一句说明。
5. **`[CLEANSED]` 前瞻性标签**（003）— CC 事件行上的 [CLEANSED] 出现在实际驱散发生之前 2 秒，未说明这是"事后回填的前瞻标注"。

### 假阳性（系统提示词已定义，审计设置缺陷所致）

`[STATE]` 缺失单位=满血（已定义）、`focus:`（已定义）、`rdy:Δ`（已定义）等 ~7 条。
**根因：本轮只给了审计模型 user-prompt，没给系统提示词。** 这本身是对审计流程的第一轮真实改善：

> **C5 流程修正（已采纳）：后续歧义审计必须同时提供系统提示词与 user-prompt。**

### 低价值（接受现状）

PvP 饰品不在 loadout 清单（约定俗成）、若干措辞类小条目。

## 改善回路状态

- 5 类真实缺口的修复 = 在系统提示词图例补 1–2 句定义（DR 记号、HEALING 归属、伤害方向、CLEANSED 时序）。
- **系统提示词文本改动必须走 `evalPromptCompare` A/B 流程验证后才能采纳**（docs/prompt-ab-testing-workflow.md），不允许本次直接改——留作下一轮真实 eval 周期的 treatment。
- 注意 harness/prod 双提示词分叉（NEW_SYSTEM_PROMPT vs FINDINGS_JSON）：两侧需分别检查是否缺同样的定义。

## 成本记录

2 次 Gemini 3.1 Pro 审计各 ~48 秒；发现/成本比高，建议纳入每轮 eval 的常规步骤（每轮抽 2 个新 prompt）。
