# Goal: 可验证性路线图全量落地（真实运行验证）

**设立：** 2026-07-07 · **来源：** [可验证性审计](analysis/2026-07-07-verifiability-audit.md)
**目标状态：** 审计路线图（agy 工具 + C1–C9）每一项都 ①实现 ②经**真实运行**验证（真实 eval pass / 真实 CI run / 真实生产路径执行——绝不允许模拟结果或伪造数据，见 CLAUDE.md Eval Integrity）③根据真实运行结果完成至少一轮改善或明确接受现状。

## 完成定义（每项三栏全绿才算 DONE）

| 项                         | 实现                                                          | 真实运行验证                                             | 改善回路                                                | 状态        |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ----------- |
| B: agy-delegate 工具       | ✅ 2026-07-07                                                 | ✅ selftest + 6 角色冒烟 + 审计中真实使用                | ⬜ 在 C 项工作中累计 ≥3 次真实使用并按结果调整 preamble | IN PROGRESS |
| C1: test.yml push 触发     | ✅ 2026-07-07                                                 | ⬜ 真实 push 到 origin/main 并观察 workflow 通过         | ⬜ 若首跑失败，修复至绿                                 | IN PROGRESS |
| C2: CLAUDE.md agy 工作流   | ✅ 2026-07-07                                                 | ⬜ 与 B 共用真实使用证据                                 | ⬜ 按使用体验修订触发条款                               | IN PROGRESS |
| C3: 测试套件健康守卫       | ⬜ 套件数基线守卫 + cloud 包 passWithNoTests 缺口             | ⬜ 种植一个被禁用的套件→守卫变红→移除→变绿（真实标定跑） | ⬜                                                      | TODO        |
| C4: 分数溯源元数据         | ⬜ 评分写入路径附 judge 模型/时间戳/prompt hash               | ⬜ 在真实 judge pass 产生的分数文件上验证（禁止造分）    | ⬜                                                      | TODO        |
| C5: prompt 歧义异族测试    | ⬜ 流程写入 eval 工作流文档                                   | ⬜ 用真实语料 prompt 跑 agy 异族模型，记录发现           | ⬜ 按发现修 prompt builder 或明确接受                   | TODO        |
| C7: judge 跨模型抽检       | ⬜ 抽检工具（读真实 scores + 全量 prompt/response，agy 复核） | ⬜ 对既有真实评分抽 ≥5 局出一致率报告                    | ⬜ 一致率异常则升级 /calibrate-judge                    | TODO        |
| C8: 云函数 fixture harness | ⬜ 真实日志 fixture → handler → 断言 stub 形状                | ⬜ 进 CI 并在真实 CI run 通过                            | ⬜                                                      | TODO        |
| C9: 上传链路 staging 探针  | ⬜ fixture 上传 → 轮询 stub 出现                              | ⬜ 对真实 GCS/staging 跑通一次                           | ⬜                                                      | TODO        |

**纪律：** 验证栏只接受真实运行的产物（CI run URL、真实分数文件、真实探针日志）。任何一项如果被凭据/环境阻塞，如实标 BLOCKED 并写明缺什么，不得用模拟结果充数。

进度更新直接改本表；全表 DONE 时在 TRACKER.md 记一行并归档本文件到 docs/archived/。
