# 开发流程可验证性审计

**日期：** 2026-07-07
**范围：** 四类难验证环节（LLM 输出质量 / 代码改动正确性 / 简单执行外包 / 端到端流程），每项给出现状、风险、改善方案、优先级。
**关联：** 子项目 A（本报告）；子项目 B（agy-delegate 跨代理验证工具，已于 2026-07-07 落地，见 `docs/superpowers/specs/2026-07-07-agy-delegate-design.md`）；子项目 C（按本报告路线图逐项落地）。

报告中标注 ✅agy 的结论已用 agy-delegate `verify` 角色做过独立交叉验证。

---

## 一、LLM 输出质量

### 1.1 Judge 信任链有时效性，且有造假前科

- **现状：** 信任序已文档化（确定性检查 > LLM judge；judge 仅在通过 `/calibrate-judge` 期间有效）。F141 事故（2026-07-04 删除的 `finish_scoring.js`/`heuristic_eval.js` 伪造了 100 局中 51–100 局的分数）催生了 CLAUDE.md 的 Eval Integrity 铁律。
- **风险：** 铁律靠自觉执行，分数文件本身不携带可稽核的来源信息——事后无法区分"真 judge 跑出来的"和"脚本填的"。
- **改善：**
  1. **分数溯源元数据**：每个 `scores/` 文件写入 runner 元数据（judge 模型、时间戳、prompt hash、逐条 ordinal 完成记录），使伪造可被机器检出。
  2. **跨模型抽检**：每轮评分后随机抽 5–10 局，用 `agy-run verify`（Gemini 系）复核 judge 结论，报告一致率；一致率骤降 = judge 或流程出了问题。
- **优先级：** P1（溯源）/ P2（抽检）

### 1.2 Prompt 测试靠同族模型 role-play（弱验证）

- **现状：** "API Key Bypass" 约定用 Claude 子代理 role-play 响应 AI 来测 prompt。
- **风险：** 同族模型相关性偏差——Claude 演的"响应 AI"倾向理解 Claude 写的 prompt，测不出真实歧义。
- **改善：** 用 `agy-run ask`（Gemini/GPT-OSS）作为异族响应模拟器；prompt 里的歧义在异族模型上更容易暴露。成本低（Flash 单次 ~5–15 秒）。
- **优先级：** P1

### 1.3 确定性锚点健康，但只在本地生效

- **现状：** `promptQualityCheck`（pre-commit，STRICT=1 时缺失友方死亡即拒绝提交）与 `regression-gate`（golden-game 不变量）是可靠的确定性锚点。
- **风险：** 两者都依赖本地语料（`local-batch/healer-eval/`），CI 上不存在语料即静默跳过——换机器或新 clone 后保护消失且无提示。
- **改善：** pre-commit 在语料缺失时打印一行警告（而非静默跳过），成本一分钟。
- **优先级：** P2

## 二、代码改动正确性

### 2.1 直推 main 跳过全部 CI 测试 ✅agy

- **现状：** `test.yml` 仅在 `pull_request` 触发；本仓库习惯是直接 commit 到 main（CLAUDE.md：直落 main 时通常不需要 PR）。pre-commit 只跑 lint + typecheck，不跑单测。两点均经 agy 独立确认（含 lint/typecheck 不传递触发测试的检查）。
- **风险：** 日常开发路径上单元测试从不自动运行——测试挂了可能几天后才发现。
- **改善：** 给 `test.yml` 增加 `push: branches: [main]` 触发（CI 分钟数可接受，仓库已有 perf-bench 先例）；或加 pre-push hook 跑受影响包的测试。推荐前者：不拖慢本地提交。
- **优先级：** **P0**（改动一行，收益最大）

### 2.2 测试套件静默失效

- **现状：** ts-jest 编译错误会静默禁用整个套件（已知教训，记录在案）；`shared` 包需用 `npx tsdx test` 跑。
- **风险：** "测试通过"可能实际是"测试没跑"。
- **改善：** CI/脚本断言收集到的测试数量下限（如 `--passWithNoTests` 禁用 + 套件数阈值检查），把"没跑"变成红灯。
- **优先级：** P1

### 2.3 单模型自查缺少第二双眼睛

- **现状：** 改动质量靠 Claude 自查 + 确定性检查；无独立评审。
- **改善：** 非平凡改动后跑 `agy-run review`（Gemini 3.1 Pro，独立强模型）；REQUEST_CHANGES 的每条 finding 按 file:line 核实后再采纳。已在 SKILL.md 写成主动触发习惯。
- **优先级：** P0（工具已就绪，纯习惯问题）

### 2.4 已有的好实践（保持）

preload API drift 的 shasum 检查、`check-deps` 依赖规则校验、perf-bench 都是"机器可判"的典范，新增关卡照此风格。

## 三、简单执行外包

- **现状：** 机械性步骤（批量改名、格式转换、逐文件检查）此前全部消耗主线程 token。
- **已落地：** `agy-run exec`（默认 Flash Medium，~便宜一个数量级）。实测两个关键行为：默认模式可写 cwd 工作区文件；**`--sandbox` 会静默拦截写入且 agy 谎报成功**——因此 exec 的 preamble 强制"写后读回自证"，且 SKILL.md 要求 Claude 对 exec 结果至少抽查一个改动文件。
- **剩余风险：** exec 报告仍是 LLM 输出，批量任务的验证要用确定性手段（diff/grep 计数），不能只看报告。
- **优先级：** 已完成；抽查纪律随子项目 C 写入工作流。

## 四、端到端流程

### 4.1 云函数链路（GCS trigger → parse → Firestore）

- **现状：** 只能靠部署后观察；本地无法复现 GCS 事件。
- **改善：** fixture 驱动的本地 harness——用真实日志 fixture 构造 GCS 事件对象直接调用 handler，断言 Firestore 写入 stub 的形状。确定性、可进 CI。
- **优先级：** P2（改动少但需要摸清 handler 的依赖注入点）

### 4.2 桌面端（Electron / 录像）

- **现状：** `test-with-logs` skill 已覆盖"不开 WoW 也能测解析/UI"；录像链路仍需真机。
- **改善：** 维持现状；录像验证成本高于收益，不建议投入。
- **优先级：** 不做

### 4.3 上传链路（签名 URL + headers）与流水线

- **现状：** 上传链路靠手动验证；Windows agent → GCS → collector 流水线已有 dashboard 指标（较好）。
- **改善：** 上传链路加一个 staging 探针脚本（上传固定 fixture → 轮询 Firestore stub 出现），作为发版前手动关卡。
- **优先级：** P2

---

## 路线图（子项目 C 的候选清单，按优先级）

| #       | 改善项                                                                            | 类型   | 预估成本   |
| ------- | --------------------------------------------------------------------------------- | ------ | ---------- |
| C1 (P0) | `test.yml` 加 `push: main` 触发                                                   | 确定性 | 一行       |
| C2 (P0) | agy review/verify 习惯写入 CLAUDE.md 工作流（非平凡改动→review；承重论断→verify） | 跨模型 | 小         |
| C3 (P1) | 测试套件健康守卫（禁 passWithNoTests + 套件数阈值）                               | 确定性 | 小         |
| C4 (P1) | 分数文件溯源元数据                                                                | 确定性 | 中         |
| C5 (P1) | prompt 歧义测试改用 agy 异族模型模拟                                              | 跨模型 | 小（习惯） |
| C6 (P2) | pre-commit 语料缺失警告                                                           | 确定性 | 一行       |
| C7 (P2) | judge 跨模型抽检（一致率报告）                                                    | 跨模型 | 中         |
| C8 (P2) | 云函数 fixture harness                                                            | 确定性 | 中         |
| C9 (P2) | 上传链路 staging 探针                                                             | 半自动 | 中         |

**原则**（延续既有信任序）：能用确定性检查的绝不用 LLM 判断；LLM 交叉验证只用于确定性手段够不着的地方（语义质量、评审意见），且异族模型优先。
