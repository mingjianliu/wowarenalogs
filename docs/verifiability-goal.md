# Goal: 可验证性路线图全量落地（真实运行验证）

**设立：** 2026-07-07 · **来源：** [可验证性审计](analysis/2026-07-07-verifiability-audit.md)
**目标状态：** 审计路线图（agy 工具 + C1–C9）每一项都 ①实现 ②经**真实运行**验证（真实 eval pass / 真实 CI run / 真实生产路径执行——绝不允许模拟结果或伪造数据，见 CLAUDE.md Eval Integrity）③根据真实运行结果完成至少一轮改善或明确接受现状。

## 完成定义（每项三栏全绿才算 DONE）

| 项                         | 实现                                                                                 | 真实运行验证                                                                                                        | 改善回路                                                                                                   | 状态                         |
| -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------- |
| B: agy-delegate 工具       | ✅ 2026-07-07                                                                        | ✅ selftest + 6 角色冒烟 + 本日 8 次真实使用（1 verify CONFIRMED、2 Pro 歧义审计、5 抽检复核）                      | ✅ 8 次真实使用后无 preamble 缺陷暴露，接受现状；实现期已按实测反转 sandbox 策略                           | **DONE**                     |
| C1: test.yml push 触发     | ✅ 2026-07-07                                                                        | ✅ push 触发 run 28875212224 全绿（真实 CI run）                                                                    | ✅ 首跑即绿，无需修复                                                                                      | **DONE**                     |
| C2: CLAUDE.md agy 工作流   | ✅ 2026-07-07                                                                        | ✅ 与 B 共用真实使用证据                                                                                            | ✅ 按 C5 教训补充了"歧义审计须附系统提示词"到 eval 工作流文档                                              | **DONE**                     |
| C3: 测试套件健康守卫       | ✅ scripts/check-test-suites.mjs + 基线 + cloud 包 flag + CI step                    | ✅ 本地标定：种植禁用套件→exit 1→恢复→PASS；CI run（9c60e51a）含守卫步骤                                            | ✅ 标定通过；新增 cloud 套件后基线同步上调 2→3                                                             | **DONE**  |
| C4: 分数溯源元数据         | ✅ 格式写入 judge 文档 + check-score-provenance.mjs + pre-commit                     | ✅ 校验器标定：有效 provenance 通过 / 篡改检出 exit 1 / 真实语料 20 legacy 仅警告                                   | ✅ 2026-07-07 真实 eval run（10 局，见 eval-ledger）全部携带 provenance，校验 10/10 verified；抽检工具自身的 verdict-键 bug 经 40% 假警报暴露并修复（修复后一致率 13/15=87%） | **DONE** |
| C5: prompt 歧义异族测试    | ✅ 流程写入 healer-eval-improvement-workflow.md                                      | ✅ 2 个真实语料 prompt × Gemini 3.1 Pro，17 条报告 → 5 类真实缺口（DR 记号、HEALING 归属、伤害方向、CLEANSED 时序） | ✅ 首轮即产生流程修正（审计必须附系统提示词——本轮 7 条假阳性的根因）；图例修复排队走 evalPromptCompare A/B | **DONE**（图例修复已走完 A/B：5/5 平局无回归，以正确性依据 adopt，见 eval-ledger System-prompt A/B 表） |
| C7: judge 跨模型抽检       | ✅ scripts/judge-spot-audit.mjs（审计 factAudit 事实断言，不碰 rubric 分）           | ✅ 真实抽检 5 局（001/005/009/013/017）：一致率 12/15 = 80%，报告在 eval 目录 spot-audit-report.md                  | ✅ 基线 80% 写入工作流文档；分歧聚焦于 HEALING 窗口歧义（与 C5 发现互证）与游戏机制争议                    | **DONE**                     |
| C8: 云函数 fixture harness | ✅ writeMatchStubHandler.test.ts：真实 fixture→真实 parser→真实 stub 生成，边界 mock | ✅ 本地 3/3 通过；已随 9c60e51a 进 CI                                                                               | ✅ 幂等性断言把 handler 的隐含契约（已存在文档不覆写）固化为测试                                           | **DONE**  |
| C9: 上传链路 staging 探针  | —                                                                                    | **BLOCKED**：本机无任何 GCP 凭据（无 gcloud/service account/env），云基础设施 upstream 所有，无 staging 环境        | 需要：staging bucket + service account，或上游提供测试端点                                                 | BLOCKED                      |

**纪律：** 验证栏只接受真实运行的产物（CI run URL、真实分数文件、真实探针日志）。任何一项如果被凭据/环境阻塞，如实标 BLOCKED 并写明缺什么，不得用模拟结果充数。

## 遗留事项

1. ~~C4 收尾~~ ✅ 2026-07-07 完成：真实 10 局 eval run，10/10 provenance verified，台账已记。
2. ~~C5 图例修复~~ ✅ 2026-07-07 完成：A/B 5/5 平局（+2% tokens，无回归），以正确性依据 adopt；顺带修复 evalPromptCompare 的 SYSTEM_PROMPT 配对 bug（agy 验证）。prod 侧（FINDINGS_JSON）经查不使用这些记号，无需修改。
3. **C9 解锁条件**：获得 staging GCS 凭据或上游测试端点后，写 fixture 上传→轮询 stub 探针。
4. ~~C3/C8 的 CI 验证~~ ✅ run 28875698999（commit 9c60e51a）全绿，guard step success。

进度更新直接改本表；全表 DONE（或 BLOCKED 项明确豁免）时在 TRACKER.md 记一行并归档本文件到 docs/archived/。
