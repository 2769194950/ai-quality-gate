# 当前能力边界与补充测试清单

> 本文件是 `qgate × OpenCodeReview` 的当前能力边界台账。
> 它描述“已经验证到哪里”，不把 AI 的建议能力写成确定性保证。
> 需求、架构和阶段使用方式分别以 `docs/00-requirements.md`、
> `docs/01-architecture.md`、`docs/02-playbook.md` 和
> `docs/03-stage-review-playbook.md` 为准。

## 1. 阅读规则

边界条目使用以下状态：

| 状态 | 含义 |
|---|---|
| `VERIFIED` | 已有自动化测试或真实运行证据，当前可作为项目能力使用 |
| `PARTIAL` | 只在明确输入、扫描面、平台或配置范围内成立 |
| `OPEN` | 已知限制或尚未实现的能力，不得对外宣称已经具备 |
| `MITIGATED` | 已有降级或 fail-closed 处理，但根本限制仍存在 |

本文件只记录能力和边界，不记录 API Key、模型响应原文或带敏感信息的证据。

## 2. 当前已验证能力

| 能力 | 状态 | 当前保证 |
|---|---|---|
| 五阶段入口 | `VERIFIED` | `requirements → design → build → review → verify` 均可通过 `qgate stage` 生成 manifest、执行/导入审查并产出证据 |
| 确定性门禁 | `VERIFIED` | `qgate` 继续负责 schema、退出码、证据、trace、人类审批和最终 `overall_passed` |
| AI 结果隔离 | `VERIFIED` | OCR 结果只能进入阶段证据，不能直接写入 `passed`、`overall_passed` 或发布批准 |
| OCR 真实调用 | `VERIFIED` | Windows 本机已验证 `ocr.ps1` 的解析和调用；Atria 配置连接成功 |
| 离线预览 | `VERIFIED` | 无 OCR、显式 offline 或 fixture 模式可运行，且会记录降级原因 |
| 结果 fail-closed | `VERIFIED` | 空输出、损坏 JSON、非零退出、缺失可执行文件、`status=skipped` 不会被认证为“已执行且有效” |
| 安全环境边界 | `VERIFIED` | OCR 子进程只接收白名单环境变量，不透传 API Key；密钥配置位于仓库外 |
| 建议补丁 | `VERIFIED` | 可保留 OCR 的建议代码和 finding，但第一版不会自动修改工作区 |
| 真实 Git diff 审查 | `VERIFIED` | 已用临时 Git worktree 和故意引入的危险代码验证 OCR 能返回可定位 finding |
| 确定性选择/分组 | `VERIFIED` | 选择、过滤、敏感路径排除、分组和离线摘要保持相同输入相同字节 |

## 3. 当前能力边界

### 3.1 OCR 和模型调用边界

| ID | 状态 | 边界 | 影响 | 处理方式 |
|---|---|---|---|---|
| `OCR-B01` | `MITIGATED` | OCR `--background-file` 当前存在约 8000 字符硬限制；完整需求文档和架构文档可能超过限制 | 大上下文 live review 可能直接失败 | 当前记录失败并 fail-closed；后续应实现上下文切片、摘要或分组输入 |
| `OCR-B02` | `PARTIAL` | OpenCodeReview CLI 的命令参数、Windows shim、版本行为可能随上游版本变化 | 同一适配器在不同平台/版本上可能无法启动 | 通过 `resolveOcrExecutable`、PowerShell wrapper 和 CLI 兼容测试覆盖；升级 OCR 后必须重跑 live smoke test |
| `OCR-B03` | `PARTIAL` | live LLM 输出不是确定性产物；模型版本、温度、上游提示词和服务端策略可能改变 finding | 不能把 live finding 当作字节级基线 | 只对 manifest、summary 和规范化结构做确定性断言；语义质量使用 fixture、反例和人工校准 |
| `OCR-B04` | `OPEN` | 尚未建立 provider 限流、配额、网络重试和成本账本 | CI 可能因限流或预算耗尽失败，成本无法由 qgate 单独核算 | 增加请求预算、重试退避、成本记录和超预算测试；不得静默降级为“无问题” |
| `OCR-B05` | `MITIGATED` | 上游可能返回 `skipped`、空 comments 或非预期字段；上游 JSON schema 不是 qgate 的冻结契约 | 直接信任上游会制造假通过 | 本地规范化器将不可执行/不可解析结果标为无效；需要继续扩大 malformed-result 夹具 |
| `OCR-B06` | `PARTIAL` | 当前真实五阶段测试使用了项目内小型上下文；不是完整文档上下文的质量证明 | 不能据此推断完整需求和架构文档的审查召回率 | 大上下文切片方案完成前，保持该限制为发布前置条件 |

### 3.2 语义审查边界

| ID | 状态 | 边界 | 影响 | 处理方式 |
|---|---|---|---|---|
| `SEM-B01` | `OPEN` | AI 会漏报、误报或误解业务语义 | finding 不能单独等价于缺陷事实，也不能单独证明没有缺陷 | AI finding 第一版默认 warn；由确定性测试、人工审批和反例夹具兜底 |
| `SEM-B02` | `OPEN` | 当前没有自动修复、补丁应用、冲突解决和修复后自动关闭能力 | 开发者必须人工或使用外部 Agent 应用建议，并重新运行阶段 | 保留 `suggestion_code`，修复闭环必须重新审查、重跑测试并重新过门禁 |
| `SEM-B03` | `OPEN` | 当前 finding 生命周期状态不是完整的持久化产品能力 | `open/accepted/rejected/deferred/fixed/rechecked/closed` 不能仅靠一次 JSON 结果推断 | 增加 finding ledger、状态变更者、时间、理由和重检 runId |
| `SEM-B04` | `OPEN` | 尚未实现稳定的行号 re-tracking；代码变动后旧行号可能失效 | 建议补丁可能定位到旧代码 | 在修复前后保存 blob/commit 指纹，并在重检前重新定位；实现前不得宣称“行号始终稳定” |
| `SEM-B05` | `PARTIAL` | 文件选择和分组有硬上限，单组最多 10 个文件；超预算会降级到单文件组 | 跨文件逻辑可能被切断，模型看不到完整调用链 | 保留分组不变量；增加跨组依赖提示和超预算告警 |
| `SEM-B06` | `PARTIAL` | `requirementId` 关联依赖本地需求索引；AI 自己写出的未知编号不能成为有效追踪 | 语义问题可能无法回溯需求 | ingest 必须校验编号存在；未知编号 fail-closed，不得认证为有效 finding |

### 3.3 证据、安全和审计边界

| ID | 状态 | 边界 | 影响 | 处理方式 |
|---|---|---|---|---|
| `AUD-B01` | `VERIFIED` | qgate 只验证证据结构、引用、哈希和内部一致性；同一信任域内的整链伪造仍可能自洽 | 这不是外部不可伪造证明 | CI 应保留提交签名、制品清单或外部存储锚点；当前不把内部哈希链宣传成抗恶意伪造 |
| `AUD-B02` | `PARTIAL` | SAFE_001/SAFE_003 只对声明的扫描面和匹配器生效；文档、fixture、生成物和部分非身份链别名不在保证范围内 | 不能宣称“任何地方都没有密钥读取或网络调用” | 对外说明必须同时引用 `docs/01-architecture.md` 的 SAFE 边界；扩大扫描面需新增反例测试 |
| `AUD-B03` | `VERIFIED` | API Key 不应进入 qgate、证据、ledger、stdout 或 stderr；用户级 OCR 配置在仓库外 | 错误的环境传递仍可能造成泄漏 | 保持 allowlist；每次新增 runner 参数都执行敏感信息回显测试和 Git staged scan |
| `AUD-B04` | `OPEN` | 尚未系统验证超长 token、Unicode 路径、重命名/删除文件、符号链接和大小写冲突在五阶段 manifest 中的完整行为 | 跨平台输入可能导致审查范围漂移 | 增加 Windows/Linux 路径矩阵和 Git 状态矩阵测试 |
| `AUD-B05` | `PARTIAL` | `covered=true` 证明的是账本中出现了对应 testId，不等于独立证明根项目测试真实覆盖了需求 | trace 可能是同源夹具自洽 | 保留现有审计说明；需求覆盖仍需独立测试存在性和人工检查 |

### 3.4 工作流和运营边界

| ID | 状态 | 边界 | 影响 | 处理方式 |
|---|---|---|---|---|
| `OPS-B01` | `OPEN` | 尚未定义 OCR 服务不可用时的团队级 SLA、重跑策略和人工接管时限 | CI 红灯后团队处理路径不统一 | 在 CI 模板中明确重试次数、人工接管、offline fixture 和故障标签 |
| `OPS-B02` | `OPEN` | 尚未建立 finding 误报率、漏报率、采纳率、修复耗时和按类别 blocker 转换标准 | 无法有依据地把 warn 升级为 fail | 先影子运行，按类别收集数据，再逐类启用阻断 |
| `OPS-B03` | `PARTIAL` | OCR 规则、模型和提示词升级没有完整的兼容性矩阵 | 升级可能改变 finding 结构或语义 | 记录 OCR 版本、模型名、manifest 指纹和规则版本；升级必须通过离线和 live smoke test |
| `OPS-B04` | `OPEN` | 尚未覆盖并发运行、重复提交、缓存失效和同一 finding 的幂等合并 | 重复评论或证据覆盖风险 | 增加 runId/idempotency key、并发 CI 和重复 ingest 测试 |

## 4. 补充测试计划

下面的测试是当前能力从“可用原型”走向“可持续 CI 能力”前的补充项。

### P0：发布前必须补齐

| 测试 | 验证目标 | 期望结果 |
|---|---|---|
| 7999/8000/8001 字符 background | 精确确认 OCR 上下文边界及错误分类 | 8000 内成功；超限明确失败并写入 degraded reason，不得变成零 finding |
| 超时、连接断开、429、5xx、非零退出 | 外部服务故障闭环 | 退出码、重试次数、degraded 原因和证据状态一致 |
| 空输出、混合日志+JSON、截断 JSON、JSON 数组/对象漂移 | ingest fail-closed | 无效结果 `executed=false` 或 `valid=false`，必需门禁失败 |
| `status=skipped`、缺 comments、缺 path/line/category/message | 上游语义状态校验 | 不能认证为有效审查；非法 finding 不得进入 blocker 统计 |
| finding 路径越界、敏感路径、重复项、未知 requirementId | 证据归属和安全 | 拒绝或标无效；不得生成可通过的 `ocrNoBlockers=true` |
| manifest 与 ingest 的 stage、root、inputFingerprint 不匹配 | 跨阶段/旧结果重放防护 | ingest 失败，不允许用旧阶段结果冒充当前阶段 |
| Git staged、unstaged、rename、delete、binary、merge-base diff | 真实开发输入面 | 选择范围稳定，删除文件和重命名不会丢失或伪造 finding |
| 修复后重检 | 生命周期闭环 | 旧 finding 不自动 closed；必须有新 runId、测试结果和门禁证据 |
| stdout/stderr/JSON/ledger 全面 secret scan | 密钥隔离 | token、Authorization、用户路径和敏感 context 不得回显 |

### P1：上线后优先补齐

| 测试 | 验证目标 |
|---|---|
| Unicode、超长路径、大小写冲突、符号链接和硬链接矩阵 | Windows/Linux 文件身份和路径一致性 |
| 并发两个 stage review、重复 ingest、同一 commit 重跑 | 幂等性、锁和证据覆盖策略 |
| OCR 版本/模型/规则升级前后 fixture 对比 | 输出结构兼容性和 finding 漂移 |
| 10/11 文件分组、跨组依赖、token budget 临界值 | 分组硬上限和上下文截断风险 |
| 多 provider、限流、成本和重试 | 运营可控性和预算边界 |
| 反例集：AI 漏报但确定性测试失败 | 验证 AI 永远不是唯一阻断依据 |
| 反例集：AI 误报但确定性门禁通过 | 验证 warn 不会错误阻断开发 |

## 5. 修复与移除规则

“已知边界”不能因为代码看起来修过就直接删除。某个条目只有同时满足以下条件，才可以从“当前能力边界”表移除：

1. 代码修复已提交，并有明确的 commit 或 PR 关联。
2. 至少有一个针对原问题的回归测试，以及一个失败反例测试。
3. 离线 fixture 和真实场景 smoke test 都通过；涉及平台时必须在目标平台验证。
4. `qgate check`、核心测试、OCR 适配器全套测试和 baseline freshness 全部通过。
5. 文档、CLI 帮助、schema、CI 模板和测试名称已经同步，不再存在旧口径。

满足条件后：

- 从第 3 节的“当前能力边界”中移除该条目；
- 若该限制曾影响发布或产生过兼容性约束，在第 6 节保留一行 `RESOLVED` 历史记录；
- 如果只是增加了降级而没有消除根因，状态只能从 `OPEN` 改为 `MITIGATED`，不能移除。

## 6. 已解决边界记录

| ID | 解决版本/提交 | 证据 |
|---|---|---|
| `OCR-B07` | `1d8151c` | Windows `ocr.ps1` 解析、PowerShell 调用、真实 Git diff review 和五阶段 live smoke test 通过 |
| `QGATE-B01` | `1d8151c` | OCR `status=skipped` 不再被规范化为 `executed=true/valid=true`；qgate stage-review 回归测试通过 |
| `TEST-B01` | `1d8151c` | 离线 fixture 显式隔离 OCR 安装状态，适配器 145/145 通过 |

## 7. 当前发布判断

当前版本适合：

- 本地开发阶段的 AI 语义提示；
- PR 中的 review 影子运行和 warn 模式；
- 真实 Git diff 的外部 OCR 联调；
- 确定性门禁、证据追踪和人工审批的联合验证。

当前版本不适合直接承诺：

- 完整大文档上下文的稳定 live 审查；
- AI finding 的自动修复和自动关闭；
- AI 结果单独阻断发布；
- 业务缺陷零漏报；
- 多平台、多 provider、限流和成本运营已经完善。
