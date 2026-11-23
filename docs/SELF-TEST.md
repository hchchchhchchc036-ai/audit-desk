# Audit Desk 自测记录

验证日期：2026-11-12。本记录区分真实 Electron / Docker 执行和本地模型协议夹具；没有使用用户付费模型验证分析质量。

| 检查 | 执行方式 | 结果 |
| --- | --- | --- |
| 核心逻辑、索引、审计验证、覆盖标识、补审、实际预算结算、测试失败记录、性能错误率、中文 Word / MD / HTML、上下文与存储、超时重试与取消 | `npm.cmd test` | 53 项通过 |
| 真实桌面导入中文路径、配置 1M、五个 Skill、实时流程、系统顶栏、本地测试和报告导出 | `npm.cmd run test:ui` | 通过，renderer 错误 0 |
| 项目隔离、切换中固定任务、模型选择自定义工具、手动工具、压缩、交接重置、失败保全、无对话 UI | `node scripts/context-check.cjs` | 11 项通过 |
| 实际容器单元、功能、性能测试 | `node scripts/live-docker-check.cjs` | 三种任务真实执行，报告见 artifacts/live-docker-check.json |
| OCR 模型配置复用 | tests/ocr-live.test.cjs | 本地 OCR 对确定性 HTTP 服务验证 OpenAI 与 Anthropic 协议 |
| 依赖漏洞 | `npm.cmd audit --registry=https://registry.npmjs.org --json` | 0 个已知漏洞 |
| Windows 0.1.8 打包程序 | `AUDIT_DESK_EXECUTABLE` 指向 release/0.1.8/win-unpacked/Audit Desk.exe 后执行 scripts/ui-check.cjs 与 scripts/context-check.cjs | 审计补审、覆盖校验、测试多选与超时恢复、Word / MD 导出、重启及上下文隔离通过，renderer 错误 0 |

桌面截图：`artifacts/desktop-window.png`。结构化验证结果：`artifacts/ui-check.json`、`artifacts/context-check.json`。架构与审计/测试流程图：`docs/design.md`；项目上下文流程图：`docs/context-and-projects.md`。

0.1.5 启动回归：`scripts/ui-check.cjs` 关闭并重新启动同一独立测试目录，检查项目索引与上下文展示为空、工作流程恢复三步默认说明；模型设置、项目列表及历史任务保留。重新选择历史项目后重建索引并复用原项目上下文，历史流程不会自动覆盖默认说明。

0.1.7 桌面回归：测试四类多选、全选与清空，单元与功能任务真实分别排队并完成；本地 HTTP 夹具第一次生成请求故意保持响应体未结束，5 秒超时后自动重试，下一次调用采用 10 秒上限并恢复测试执行。两个调用轨迹分别为失败与完成。未使用用户付费模型，未删除用户文件。由于 C 盘已满，自测与打包临时目录均显式放在 D 盘 `.runtime/temp`。

0.1.8 回归：跨文件同名边界不再产生覆盖标识冲突，未知攻击类别仍为待补审；新增边界只有在实际补审后才成为已覆盖。32K 输出上限、200K 任务预算的确定性夹具可完成六条候选的双重验证，剩余额度等于预算减实际用量。测试解析保留 JSON 汇总之后的失败，性能错误率大于零判失败，单项失败后下一测试仍完成。桌面模型协议夹具额外验证从项目导入到补审、覆盖结构校验和报告生成的完整审计路径；不代表真实模型的审计质量。

模型夹具用于验证调用协议、用量归属和状态转换；不代表真实模型审计召回率。外部模型分析质量需要配置模型后通过实际项目评估。不同语言、浏览器自动化和扫描器需要包含相应依赖的本地 Docker 镜像；Docker 可选模式已验证 Node.js 镜像；默认本地模式已验证软件内置 Node，无需 Docker。OCR 未返回内部工具轨迹或 token 时如实显示未提供。
