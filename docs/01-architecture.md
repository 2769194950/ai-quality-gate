# 01 — 架构与接口契约（qgate 门禁契约引擎 × OCR 适配层）

| 字段 | 值 |
|---|---|
| 文档 ID | `docs/01-architecture.md` |
| 契约版本 | `configSchemaVersion = "1.0"` ｜ `runResultSchemaVersion = "1.0"` ｜ `ledgerSchemaVersion = "1.0"` ｜ `traceMatrixSchemaVersion = "1.0"` |
| 状态 | **FROZEN**（本文件字段名/类型/枚举/退出码即实现验收基线） |
| Owner | architect（接口契约与设计）；实现 owner 见 §7 |
| 关联需求 | `docs/00-requirements.md` 的 REQ-QUALITY-GATE-001 … 016 |
| 落盘根 | 项目根下的相对路径（POSIX 风格） |

**冻结结论（一句话）**：`qgate.config.json`（§4）、`RunResult`（§5.2）、证据账本与追踪矩阵（§5）、CLI 与退出码（§6）四组契约已冻结为字段级规格；实现方按字段名逐字实现，不得重命名、不得增减基线字段。若与实现冲突，上报 captain 走契约变更，不自行发明。

---

## 1. 外部事实来源与取材边界

本架构只使用以下两处已核实的公开实践，未核实的模型行为一律不写：

| 来源 | 被采用的确定性事实 |
|---|---|
| `alibaba/open-code-review`（CLI `ocr`） | 混合架构（确定性流水线 + LLM Agent）；`internal/agent/selection.go` 文件选择纯确定性、无副作用，`--preview` 与真实执行共享同一选择结果；二进制 / 密钥路径 / 默认排除目录 / 扩展名过滤；`FileGroup` 分组，`maxFilesPerGroup=10`，超 token 预算降级为单文件组，LLM 分组失败回退 per-file；`.opencodereview/rule.json` 规则优先级 `--rule` > 项目 > 用户 > 系统内置且第一条匹配生效；行号定位与 re-tracking；reflection / suggestion validation（`CommentWorkerPool` 异步）；失败降级；密钥路径检查先于用户 `include` 且内置敏感路径不可被 include 重新纳入；取舍为更高 Precision/F1、Token 约通用 Claude Code Agent 方案的 1/9、Recall 更低；支持 Delegation Mode、JSON 输出与 CI 集成 |
| Anthropic AI-Native SDLC Playbook | 生命周期 Plan → Design → Build → Test → Deploy → Maintain；每个交接点设人类审批门禁；用机器可验证的制品与证据替代“信任模型输出” |

**不采用的推论**：不声称 `ocr` 内部提示词内容、不声称其模型准确率数字、不声称 Anthropic Playbook 的未公开细节。凡本文件未在上表列出的行为，均属本项目的工程决策而非外部事实。

---

## 2. 融合架构总览

```
                       ┌─────────────────────────── qgate（确定性内核，零依赖、离线） ───────────────────────────┐
被检仓库 + qgate.config.json ─►│ config loader/validator ─► gate scheduler（5 stage 顺序） ─► check executors × 7 │─► RunResult(JSON)
                       │                                   ▲                │                                  │
                       │                        provider 适配（deterministic / scripted / llm / external）      │
                       └───────────────────────────────────┼────────────────┴──────────────────────────────────┘
                                                           │ evidence 引用（path/kind/excerpt）
                                                           ▼
   adapters/opencodereview（确定性复刻 + ocr 缺失降级）─► verification/evidence/*.json ─► verification/reports/*.md
                                                           ▲
   demo/（五阶段示例仓库） ────────────────────────────────┘        .github/workflows/quality-gate.yml ─► 5 个 CI job
```

设计原则（顺序即优先级）：

1. **能被代码确定性判定的，绝不交给模型**（门禁判定、文件选择、分组、规则匹配、行号、证据哈希）。
2. **模型只产出 finding，不产出“通过”**：`overall_passed` 只能由确定性检查算出。
3. **一切结论必须带证据引用**：没有 `evidence` 的判定视为无效判定。
4. **降级优先于崩溃**：provider、`ocr`、外部命令缺失时降级并标注 `degraded`。
5. **同输入必得同输出**：除运行时字段（§5.4）外，RunResult 完全可复现。

---

## 3. (a) 五阶段门禁流水线与人类门禁位置

### 3.1 阶段顺序（固定，不可配置）

| 序号 | stage | 中文名 | 与 AI-Native SDLC 映射 | 是否有人类门禁 |
|---|---|---|---|---|
| 1 | `requirements` | 需求阶段 | Plan | 是（出口） |
| 2 | `design` | 设计阶段 | Design | 是（出口） |
| 3 | `build` | 构建阶段 | Build | 否 |
| 4 | `review` | 评审阶段 | Test（质量评估部分） | 是（出口） |
| 5 | `verify` | 验证阶段 | Test → Deploy（可发布性） | 否 |

### 3.2 人类门禁固定 3 处（不可增删、不可换位）

| 交接点（由 `stage` 出口判定） | 交接 gateId（默认值，可由 `humanGate.gateId` 覆盖） | role（必须匹配） | approvalRecord 默认路径 | enforcement |
|---|---|---|---|---|
| requirements → design | `req-to-design` | `product` | `verification/approvals/req-to-design/approval.json` | `blocking` |
| design → build | `design-to-build` | `architect` | `verification/approvals/design-to-build/approval.json` | `blocking` |
| review → verify | `review-to-verify` | `reviewer` | `verification/approvals/review-to-verify/approval.json` | `blocking` |

**冻结规则**：

- 合法位置由 **`stage`** 判定（**不是**由门禁 id 判定）：`humanGate` **只允许**出现在 `stage ∈ {requirements, design, review}` 的门禁上——这三个 stage 的**出口**正是上表三个交接位置。其他 stage（`build` / `verify`）出现 `humanGate` ⇒ **配置错误（退出码 2）**（REQ-008）。
- **交接身份由 `stage` 推导，不由门禁 id 推导**：requirements → `req-to-design`、design → `design-to-build`、review → `review-to-verify`（实现即 `handoverPositionForStage(stage)`，见 `packages/qgate/src/config.mjs`）。因此承载人类门禁的门禁**可以叫任意合法 id**（例如 `req-spec`），其交接身份仍由 stage 决定。
- `humanGate.gateId` 是**可选**的**显式覆盖**：省略时用上一条推导出的交接 id；给出时必须匹配 §5.1 的 gate id pattern `^[a-z0-9][a-z0-9-]{1,63}$`（三个交接 id 均满足）。它覆盖的是**交接身份**，不改变「由 stage 决定合法位置」这一判据。
- `role` 必须与**交接位置**匹配：requirements → `product`、design → `architect`、review → `reviewer`；不匹配 ⇒ 配置错误（退出码 2）。
- `approvalRecord` 的默认路径按 `<gateId>` 组织：`verification/approvals/<gateId>/approval.json`，其中 `<gateId>` 取**显式 `humanGate.gateId`（若给出）否则由 stage 推导出的交接 id**。
- 允许 `humanGate` 少于 3 处，缺失处输出 `approvals_missing` 计数；但 `verify` 阶段必须始终存在。（原型不因缺失而崩溃，因为真实仓库渐进落地时可能先从 1 处开始。）
- `enforcement` 是 `humanGate` 的**必填**字段，枚举仅 `blocking` 一个取值；`required` 字段留给门禁本身（§4.3），二者语义解耦（REQ-016）。

> **与旧措辞的差异（本裁决修正）**：上文原写「合法位置仅上述 3 处」并暗示判据是**门禁 id**。准确读法是：§3.2 冻结的是**交接位置**（stage 对），`req-to-design` / `design-to-build` / `review-to-verify` 是这些位置的**交接 id**，可被 `humanGate.gateId` 显式覆盖。门禁自身的 `id` 与交接 id 是**两个不同的标识**，同名只是约定而非要求。这样 §3.2、§5.1 字段表与 §5.1 参考示例（`gate.id="req-spec"` + `stage="requirements"` + 无 `humanGate.gateId`）三者同时成立。

### 3.3 角色分工（确定性代码 / AI / 人）

| 阶段 | 确定性代码负责 | AI 负责（仅产出 finding） | 人负责 |
|---|---|---|---|
| requirements | 需求 ID 唯一性与格式、`testIds` 非空、追踪矩阵完整性、文档存在性 | 需求是否可测、验收标准是否含糊、非目标是否缺失 | 签署 `req-to-design` 审批：需求范围与优先级 |
| design | 接口字段名/类型齐备、schema 示例可解析、模块布局与文件路径存在、owner 标注 | 接口是否可实现、字段是否存在歧义、契约与需求是否矛盾 | 签署 `design-to-build` 审批：接口契约冻结 |
| build | 零依赖/离线/ESM 静态检查、check 七类语义、RunResult 形状、退出码矩阵、确定性复跑 | 代码可读性与代码异味 finding（不阻断除非 `high`+） | 处理升级（§4.2）中的接口/安全类修复 |
| review | 反例门禁（非法配置必须退出 2）、断言必须可复现、评审结论必须带文件+行号 | 对抗式评审 finding、契约一致性找茬、**能否绕过**门禁 | 签署 `review-to-verify` 审批：是否允许进入验证 |
| verify | 端到端复跑、证据哈希复算、trace 全覆盖、CI 一致性 | 不可验证项归类与风险说明（不得把未验证说成已通过） | 终审 `verification/` 报告与放行决策 |

### 3.4 五阶段要素表（每阶段 7 要素齐备）

每格内容为契约值；`必需证据制品` 为**精确文件路径**（相对项目根）。

#### 阶段 1 — `requirements`

| 要素 | 内容 |
|---|---|
| 目的 | 冻结“做什么/不做什么”，使后续所有门禁都有可追溯的需求 ID 基准 |
| 角色分工 | 确定性：ID 唯一性、`testIds` 非空、文档存在性与非目标章节存在性 ｜ AI：可测性/模糊表述 finding ｜ 人：签署 `req-to-design` |
| 进入条件 | 至少存在 1 份需求文档（`docs/00-requirements.md` 存在）；`provider` 可初始化（`deterministic` 或可降级） |
| 必需证据制品 | `docs/00-requirements.md`、`docs/requirements-index.json`（ID 清单，`[{id,priority,testIds,stage}]`）、`verification/approvals/req-to-design/approval.json` |
| 退出条件 | 门禁 `req-spec` 通过（ID 唯一、数量 ≥12、P0/P1 均有 `testIds`）且人类门禁已 `approved` |
| 阻断判据 | 出现重复需求 ID；P0/P1 需求 `testIds` 为空；`docs/00-requirements.md` 不存在；该交接点审批缺失或 `decision !== "approved"` |

#### 阶段 2 — `design`

| 要素 | 内容 |
|---|---|
| 目的 | 把需求转译为**可直接实现**的接口契约（字段名+类型+枚举+退出码），并冻结 |
| 角色分工 | 确定性：schema 示例可被 JSON 解析、字段名与类型表齐备、模块路径存在 ｜ AI：契约歧义/不可实现 finding ｜ 人：签署 `design-to-build` 冻结接口 |
| 进入条件 | 阶段 1 门禁通过（含人类门禁） |
| 必需证据制品 | `docs/01-architecture.md`、`schemas/config.schema.json`、`schemas/run-result.schema.json`、`schemas/evidence-ledger.schema.json`、`schemas/trace-matrix.schema.json`、`verification/approvals/design-to-build/approval.json` |
| 退出条件 | 四份 schema 均存在且通过 `json_assert`；`01-architecture.md` 含字段表与示例；人类门禁已 `approved` |
| 阻断判据 | 任一 schema 缺失或其 `$id`/`version` 与文档不一致；文档字段规格以指向实现的措辞替代了字段名与类型表；契约冻结审批缺失 |

> **「双 cwd 深度相等」的精确读法（t20 实测修正）**：该陈述原先写作「剔除运行时字段后深度相等」，**过强**。2026-09-17 实测（引擎 `check --config qgate.config.json --json`，三个 cwd：`E:\Desktop\ai-quality-gate`、`E:\ai-quality-gate`、`E:\Desktop`）：

> - **门禁判定完全一致**：5 个 gate / 18 个 check 的 `passed`、`overall_passed=true`、blockers 全为 0，**三个 cwd 逐项相同**；
> - 剔除四个运行时字段后，**唯一不同的语义叶子是** `/gates/2/checks/3/evidence/0/excerpt`——即 `build-deterministic` 门禁里 `no-bypass`（`type="policy"`，前缀 `CONTRACT_001`）的证据 excerpt，其中 `scannedConfig` 记的是**配置文件的绝对路径**；
> - 除该叶子外，`gates[2].checks[3]` 的其余全部内容在把该路径替换为占位符后**逐字节相同**（实测为真）。

> 因此精确表述为：**「相等」指剔除运行时字段后、除 `/gates/2/checks/3/evidence/0/excerpt` 这 1 个绝对路径叶子之外深度相等**。该叶子**不是语义差异**（判定结果、severity、evidence 的 `path` 与 `kind` 均未变，变的只是 "记录的是哪一条等价路径"），但**足以让朴素字节级比对失败**，故必须显式排除或先做占位符归一化。完整记账见 §6.2.3 **GAP-7**。

> **--config 的 cwd 语义（t22 实测补充，纠正早前表述）**：`--config` **按 cwd 解析**——**相对路径只在它存在的那个 cwd 下可用**；**一旦配置被找到，root 由配置文件自身位置推断，RunResult 与 cwd 无关**。实测三组（引擎 `check --config … --json`）：
>
> | 场景 | 结果 |
> |---|---|
> | `cwd=.` + **相对** config（仓库根） | **exit 0** |
> | `cwd=packages/qgate` + **相对** config | **exit 2**，`error.code="CONFIG_NOT_FOUND"`（message: `configuration file not found: qgate.config.json`） |
> | `cwd=packages/qgate` + **绝对** config | **exit 0**，且与仓库根运行相比**叶子差异 = 0** |
>
> 因此早前「不依赖 `--root`、只需 `--config`」的表述**漏了前半句前提**：`--config` 的相对形式本身依赖 cwd。准确表述即上面两句：**相对路径受 cwd 约束，配置一旦找到则 RunResult 与 cwd 无关**。

#### 阶段 3 — `build`

| 要素 | 内容 |
|---|---|
| 目的 | 实现冻结契约，证明“零依赖、离线、确定性”三条硬属性成立 |
| 角色分工 | 确定性：七类 check 语义、RunResult 形状、退出码矩阵、双 cwd 复跑一致 ｜ AI：可读性/异味 finding ｜ 人：仅处理升级项 |
| 进入条件 | 阶段 2 门禁通过（含人类门禁）；`packages/qgate/package.json` 存在 |
| 必需证据制品 | `packages/qgate/bin/qgate.mjs`、`packages/qgate/src/*.mjs`、`packages/qgate/gates/stage-order.json`、`packages/qgate/examples/valid/five-stage.json`、`packages/qgate/examples/invalid/*.json`、`packages/qgate/test/*.test.mjs` |
| 退出条件 | `node --test packages/qgate/test` 全绿；**同一 `--config`（同名输入）**在 2 个不同 cwd 下 RunResult **在剔除运行时字段（`run_id` / `started_at` / `finished_at` / `duration_ms`，口径见 §5.4）之后深度相等**——前提是 `--config` 在该 cwd 可解析（相对路径只在其存在的 cwd 可用；见 §3.4 的 cwd 语义注记），此时叶子差异 = 0；七类 check 均有通过+失败用例 |
| 阻断判据 | `dependencies` 非空；出现网络调用；任一 check 类型缺失；RunResult 出现多余或缺失字段；退出码与 §6.4 不符 |

#### 阶段 4 — `review`

| 要素 | 内容 |
|---|---|
| 目的 | 用对抗式方法尝试**推翻**前面阶段的结论：契约是否与实现一致、声称是否被代码强制、门槛能否被绕过 |
| 角色分工 | 确定性：反例必须以退出码 2 落入 `verification/negative/`、finding 必须带文件+行号 ｜ AI：找茬 finding（默认怀疑）｜ 人：签署 `review-to-verify` |
| 进入条件 | 阶段 3 门禁通过；`verification/negative/` 目录存在 |
| 必需证据制品 | `verification/negative/*.json`（≥6 个非法配置）、`verification/reports/review-findings.json`、`verification/approvals/review-to-verify/approval.json` |
| 退出条件 | 反例门禁全部通过（非法配置 ⇒ 退出码 2）；无 `blocker`/`high` finding；人类门禁已 `approved` |
| 阻断判据 | 任一非法配置未退出 2；存在未处置 `blocker`；发现绕过路径（例如 §5 非目标 9 的“跳过必需检查”）；审批缺失 |

#### 阶段 5 — `verify`

| 要素 | 内容 |
|---|---|
| 目的 | 在干净环境下复跑，用可复算证据证明交付物真实可用、可发布 |
| 角色分工 | 确定性：端到端复跑、证据 sha256 复算、`trace_matrix` 全覆盖、CI 步骤本地复现 ｜ AI：仅做风险归类说明，不得把未验证项写成通过 ｜ 人：终审放行 |
| 进入条件 | 阶段 4 门禁通过（含人类门禁） |
| 必需证据制品 | `verification/evidence/ledger-index.json`、`verification/evidence/ledger-<run_id>.json`、`verification/trace-matrix.json`、`verification/end-to-end.json`、`verification/ci-parity.json`、`verification/reports/final-report.md` |
| 退出条件 | `qgate check --config demo/qgate.config.json --json` 退出 0 且 `overall_passed=true`；`trace_matrix` 检查 `covered=true` 全覆盖；账本哈希复算一致；CI 每个 job 的本地复现退出码与 workflow 判据一致 |
| 阻断判据 | 端到端退出码非 0；存在 `covered=false` 的 P0/P1 需求；账本哈希不一致；CI job 无法本地复现；出现无法离线验证的断言（记为 `blocked` 而非通过） |

### 3.5 阶段契约的结构化表述

```json
{
  "pipeline": {
    "stageOrder": ["requirements", "design", "build", "review", "verify"],
    "humanGates": [
      { "gateId": "req-to-design",    "from": "requirements", "to": "design", "role": "product",   "enforcement": "blocking", "approvalRecord": "verification/approvals/req-to-design/approval.json" },
      { "gateId": "design-to-build",  "from": "design",       "to": "build",  "role": "architect", "enforcement": "blocking", "approvalRecord": "verification/approvals/design-to-build/approval.json" },
      { "gateId": "review-to-verify", "from": "review",       "to": "verify", "role": "reviewer",  "enforcement": "blocking", "approvalRecord": "verification/approvals/review-to-verify/approval.json" }
    ]
  }
}
```

---

## 4. (b) 反馈闭环与降噪策略

### 4.1 OCR 的确定性工程如何降噪

| OCR 手法（复刻到本原型） | 降噪机理 | 本项目的落地位置 |
|---|---|---|
| 纯确定性文件选择（`selection.go` 无副作用） | 选择结果与执行方式无关，`--preview` 与真实执行同源 ⇒ 消除“预览看到的和实际跑的不一样”这类不可复现差异 | `adapters/opencodereview/src/selection.mjs` + `qgate preview` |
| 密钥路径/二进制/默认排除/扩展名过滤 | 在进入昂贵分析前先剪掉噪声与危险输入 | `adapters/opencodereview/src/filters.mjs` |
| `FileGroup` + `maxFilesPerGroup=10` + token 预算降级 + LLM 分组失败回退 per-file | 限制单次上下文规模，避免长上下文导致的“泛化式误报”；分组失败不产生部分结果 | `adapters/opencodereview/src/grouping.mjs` |
| `.opencodereview/rule.json` 优先级 + 第一条匹配生效 | 判定规则确定化，同一文件不会因规则竞争得出不同结论 | `adapters/opencodereview/src/rules.mjs` |
| 行号定位与 re-tracking | 定位漂移被纠正，避免“报告位置错”这类假缺陷 | 适配层定位模块 |
| reflection / suggestion validation（`CommentWorkerPool` 异步） | 每条建议在产出前被独立复核，未通过复核的建议被丢弃 ⇒ 提高 Precision、降低误报 | `adapters/opencodereview/src/reflection.mjs`（离线规则化复刻） |
| 失败降级 | 任一步失败不产生“半个结论”，避免误把错误当结论 | 全链路 `degraded` 标记 |

### 4.2 已知取舍与其对策（不隐藏）

OCR 的公开取舍是：**更高 Precision/F1、Token 约为通用 Claude Code Agent 方案的 1/9，但 Recall 更低**（以少报换少噪声）。本原型的对策：

1. **多角度互补检查代替单点召回**：同一事实用不同机制重复验证（`file_exists` + `json_assert` + `trace_matrix`），任一机制发现即发现。
2. **只让高置信 finding 阻断**：`blocker`/`high` 阻断，`medium` 记技术债，`low` 仅记录（§4.4）——把“可能漏”与“误报代价”解耦。
3. **证据优先**：判定必须带 `evidence`，人可复核漏报，而不必信任模型。
4. **Recall 缺口显式记账**：`verification/reports/final-report.md` 必须列出“本原型覆盖不了的检查项”。

### 4.3 AI 修复预算策略（在环内快修 vs 提交门禁后修复）

| finding 类别 | 修复时机 | 预算 | 超预算动作 |
|---|---|---|---|
| 语法/格式/文档错别字/证据路径 | 在环内快修（当次门禁内） | 同一 finding ≤ 2 次自动尝试 | 第 3 次 ⇒ `escalate:true`，`reason` 含 `FIX_BUDGET_EXCEEDED` |
| 逻辑缺陷、测试缺失 | 在环内快修 | ≤ 2 次 | 升级为 `high` 并阻断相位推进，交人裁决 |
| **公共接口字段名/类型变更、安全不变量（密钥路径、include 覆盖）** | **禁止原地自动修复** | 0 次 | 直接进入“提交门禁后修复”：暂停流水线，人类签署决策（`verification/approvals/<gateId>/approval.json` 中附 `decision:"revise"` 记录），修复后必须从所属阶段重跑 |
| `blocker` 级且无法定位根因 | 提交门禁后人工介入 | 0 次 | 阻断并留证 `verification/reports/` |

升级政策（三段式）：`auto-fix(≤2)` → `human-adjudication(阻断+审批)` → `block-release(仅人类可解除)`。**任何情况下不得通过“跳过检查”来消解 finding**（见 `docs/00-requirements.md` §5 非目标 9）。

### 4.4 finding 分级与“真实缺陷”判据

| 级别 | 阻断相位推进 | 真实缺陷判据（必须全部满足） |
|---|---|---|
| `blocker` | 是 | 可复现步骤存在 + 违反冻结契约（字段名/类型/退出码/安全不变量）+ 证据路径可解析 |
| `high` | 是 | 可复现 + 影响验收标准成立（例如确定性被破坏、遥测发网）+ 证据可解析 |
| `medium` | 否（记技术债） | 影响可维护性/可读性，无法证明违反验收标准 |
| `low` | 否（仅记录） | 风格/措辞，无功能影响 |

**误报处置**：任何被判定为误报的 finding 必须留下一条“驳回记录”（`findingId`、`rejectedBy`、`reason`、`evidence`），否则视为未处置。禁止静默忽略。

---

## 5. (c)(d)(e) 数据契约

### 5.1 (c) `qgate.config.json` schema

顶层结构：

```json
{
  "version": "1.0",
  "provider": { "type": "deterministic" },
  "gates": [
    {
      "id": "req-spec",
      "stage": "requirements",
      "required": true,
      "checks": [
        { "id": "req-doc-exists", "type": "file_exists", "file": "docs/00-requirements.md", "required": true },
        {
          "id": "req-ids-present", "type": "regex", "required": true,
          "files": ["docs/00-requirements.md"],
          "pattern": "REQ-QUALITY-GATE-\\d{3}", "mode": "count", "minMatches": 12,
          "countMode": "unique"
        },
        {
          "id": "req-index-valid", "type": "json_assert", "required": true,
          "file": "docs/requirements-index.json",
          "assertions": [
            { "pointer": "/requirements/0/id", "exists": true },
            { "pointer": "/requirements", "exists": true }
          ]
        }
      ],
      "humanGate": {
        "role": "product",
        "approvalRecord": "verification/approvals/req-to-design/approval.json",
        "enforcement": "blocking"
      }
    },
    {
      "id": "interface-frozen",
      "stage": "design",
      "required": true,
      "checks": [
        {
          "id": "contract-fields-present", "type": "regex", "required": true,
          "files": ["docs/01-architecture.md"],
          "pattern": "requirementId|overall_passed|json_assert|trace_matrix|humanGate",
          "mode": "each", "minMatches": 5
        },
        { "id": "schemas-exist", "type": "file_exists", "file": "schemas/*.schema.json", "required": true }
      ],
      "humanGate": {
        "role": "architect",
        "approvalRecord": "verification/approvals/design-to-build/approval.json",
        "enforcement": "blocking"
      }
    },
    {
      "id": "build-deterministic",
      "stage": "build",
      "required": true,
      "checks": [
        { "id": "no-dep", "type": "json_assert", "required": true, "file": "packages/qgate/package.json", "assertions": [{ "pointer": "/dependencies", "equals": {} }] },
        { "id": "unit-tests", "type": "command", "required": true, "run": ["node", "--test", "packages/qgate/test/"], "expectExitCode": 0, "timeoutMs": 120000, "captureStdout": true },
        { "id": "no-bypass", "type": "policy", "required": true, "policyId": "SAFE_001", "onFail": "fail" }
      ]
    },
    {
      "id": "review-counterexample",
      "stage": "review",
      "required": true,
      "checks": [
        { "id": "negative-fixtures", "type": "file_exists", "file": "packages/qgate/examples/invalid/*.json", "required": true },
        {
          "id": "invalid-must-fail", "type": "json_assert", "required": true,
          "file": "verification/negative/oom-unknown-type.result.json",
          "assertions": [{ "pointer": "/exitCode", "equals": 2 }]
        }
      ],
      "humanGate": {
        "role": "reviewer",
        "approvalRecord": "verification/approvals/review-to-verify/approval.json",
        "enforcement": "blocking"
      }
    },
    {
      "id": "verify-coverage",
      "stage": "verify",
      "required": true,
      "checks": [
        {
          "id": "trace-complete", "type": "trace_matrix", "required": true,
          "requirementsFile": "docs/requirements-index.json",
          "traceFile": "verification/trace-matrix.json",
          "enforce": "strict", "testIdSource": "ledger-index"
        }
      ]
    }
  ]
}
```

> **契约变更同步纪律（t22 新增，强制）**：本节字段表（§5）与 `schemas/**` 是**同一份契约的两种表达**，而它们的**可执行哨兵** `packages/qgate/test/schema-contract.test.mjs`（含其冻结字段表与 `packages/qgate/test/_canonical-config.json`）**位于 core-engineer 的范围**。因此：
>
> 1. **任何修改 §5 字段表或 `schemas/**` 的人，必须在同一次改动中请 core-engineer 同步更新该测试的冻结字段表与 `_canonical-config.json`，并复跑到引擎套件全绿**（`node --test --experimental-test-isolation=none packages/qgate/test/schema-contract.test.mjs`）。**不得**以「测试在别人范围」为由把套件留在红色状态。
> 2. 该测试**跨边界保留**在 `packages/qgate/test/`（captain 裁决：不搬迁）——它是「**契约 ↔ schema ↔ 引擎**」三者一致性的**哨兵**：既断言 schema 与 §5 字段表逐项一致（missing/surplus 双向），也对引擎侧取值做有价值的校验。搬迁成本高于收益，故保留并把协作责任写成上述纪律。
> 3. 变更发起人负责**发起**同步（不是等对方发现红灯）；若下游无法当次同步，必须在报告里显式声明「引擎套件将因此转红，需 core-engineer 派单」，并给出**确切的一行修改**（文件、行号、完整新值）。本条对应 §6.2.3 **GAP-8**。

**字段表 — 顶层 `qgate.config.json`**

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `version` | `string` | 是 | — | 必须为字面量 `"1.0"`（`configSchemaVersion`） |
| `provider` | `object` | 是 | — | 见 provider 字段表 |
| `gates` | `array<object>` | 是 | — | 长度 ≥1；`gate.id` 全局唯一；`gate.stage` 取值见枚举 |
| `policy` | `object` | 否 | `{}` | 见 policySettings 字段表；默认 `{"evidenceDir":"verification/evidence","reportDir":"verification/reports","failFast":false,"scanRoots":null}` |
| `projectRoot` | `string` | 否 | 省略 | 非空，可含 `/`；**相对配置文件所在目录**的仓库根路径，由引擎解析（`loadConfig`）。当配置与其校验的仓库**相邻**而非位于其内部时使用（例：`demo/qgate.config.json` 声明 `"projectRoot": "mini-service"`）。设置后优先于 `inferRootFromConfig` 的推断，并在 RunResult/账本中以 `.` 呈现 |
| `selection` | `object` | 否 | `{}` | 见 selectionSettings 字段表；确定性文件选择配置（OCR 选择一致性的配置面） |
| `grouping` | `object` | 否 | `{}` | 见 groupingSettings 字段表；确定性 `FileGroup` 分组配置 |

> 上述 5 项（`projectRoot`、`selection`、`grouping`、`provider.fixture`、`provider.confidenceThreshold`、`policy.scanRoots`、`policy.expectedFiles`）原为「已实现但未声明」字段，经 captain 裁决按**方案 (a) 补进契约**（见 `schemas/README.md` 的裁决记录）。引擎的 `topAllowed` 白名单为 `version|provider|gates|policy|selection|grouping|projectRoot`：除这些字段外，顶层出现任何其他键都是配置错误（退出码 2）。

**字段表 — `provider`**

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `type` | `string` 枚举 | 是 | — | `deterministic` \| `scripted` \| `llm` \| `external` |
| `script` | `string` | 条件 | `null` | `type="scripted"` 时必填；相对项目根的 POSIX 路径；必须 export `run(context)` |
| `timeoutMs` | `integer` | 否 | `30000` | 500–600000 |
| `model` | `string` | 否 | `null` | 仅 `type="llm"` 使用；本原型不要求可用 |
| `endpoint` | `string` | 否 | `null` | 仅 `type="llm"` 使用；本原型不要求可用（离线时降级） |
| `fixture` | `string \| null` | 否 | `null` | 相对项目根的 POSIX 路径，指向离线 fixture（provider recordings）。`null` 表示使用内置离线 fixture 路径（`provider.mjs` 的 `DEFAULT_FIXTURE_PATH`）。确定性 provider 由该 fixture 驱动 |
| `confidenceThreshold` | `number` | 否 | `0.7` | `[0,1]`。置信度 ≥ 阈值的 finding 才升级为 blocker，低于阈值的降级为 advisory finding（`classifyFindings`） |

**字段表 — `policy`（policySettings）**

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `evidenceDir` | `string` | 否 | `"verification/evidence"` | 非空相对路径 |
| `reportDir` | `string` | 否 | `"verification/reports"` | 非空相对路径 |
| `failFast` | `boolean` | 否 | `false` | `true` 时首个阻断检查即终止本阶段 |
| `scanRoots` | `array<string> \| null` | 否 | `null` | 限定策略检查（`SAFE_001` 密钥 token、`SAFE_003` 网络面）扫描的子树；`null` 或空数组表示扫描整个仓库 |

**字段表 — `selection`（selectionSettings）**

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `include` | `array<string>` | 否 | `["**/*"]` | 元素非空；包含 glob |
| `exclude` | `array<string>` | 否 | `[]` | 元素非空；在 include 之后应用 |
| `extensions` | `array<string>` | 否 | `[".mjs",".js",".json",".md",".yaml",".yml",".txt"]` | 元素非空；接受的扩展名 |
| `defaultExcludedPaths` | `array<string>` | 否 | `[".git","node_modules","dist","build","coverage",".qgate/evidence","verification/evidence"]` | 元素非空；始终排除的目录 |
| `maxFileSizeBytes` | `integer` | 否 | `262144` | ≥1；超过该大小的文件被排除 |
| `maxFilesPerGroup` | `integer` | 否 | `10` | ≥1；分组上限镜像，生效值在 `grouping` 中 |
| `tokenBudgetPerGroup` | `integer` | 否 | `12000` | ≥1；每组 token 预算 |
| `ruleFile` | `string \| null` | 否 | `null` | 相对项目根的 POSIX 路径；OCR 规则文件（例：`.opencodereview/rule.json`），用于确定性规则匹配 |

**字段表 — `grouping`（groupingSettings）**

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `maxFilesPerGroup` | `integer` | 否 | `10` | ≥1；OCR 一致性契约值为 10，超 token 预算时降级为单文件组 |
| `tokenBudgetPerGroup` | `integer` | 否 | `12000` | ≥1；每组 token 预算 |
| `tokensPerFile` | `integer` | 否 | `4` | ≥1；预算判定用的每文件估算 token 数 |

**字段表 — `gate`**

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `id` | `string` | 是 | — | `^[a-z0-9][a-z0-9-]{1,63}$`；全局唯一 |
| `stage` | `string` 枚举 | 是 | — | `requirements` \| `design` \| `build` \| `review` \| `verify` |
| `required` | `boolean` | 否 | `true` | `false` 时失败只记录不阻断 `overall_passed` |
| `checks` | `array<object>` | 是 | — | 长度 ≥1；`check.id` 在门禁内唯一 |
| `humanGate` | `object` | 否 | 省略 | **仅允许**出现在 `stage ∈ {requirements, design, review}` 的门禁上（三个交接位置的出口）；其他 stage 出现 ⇒ 配置错误（退出码 2）。**交接身份由 `stage` 推导**，不要求门禁 `id` 等于交接 id；`humanGate.gateId` 可显式覆盖推导结果 |

**字段表 — `humanGate`**

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `role` | `string` 枚举 | 是 | — | `product` \| `architect` \| `reviewer`；**必须与交接位置匹配**（requirements→`product`、design→`architect`、review→`reviewer`），否则配置错误 |
| `gateId` | `string` | 否 | 由 `stage` 推导（`req-to-design` \| `design-to-build` \| `review-to-verify`） | 可选的**显式覆盖**；须匹配 `^[a-z0-9][a-z0-9-]{1,63}$`（即 §5.1 gate id pattern），实现侧进一步要求取值为三个交接 id 之一 |
| `approvalRecord` | `string` | 否 | `verification/approvals/<gateId>/approval.json` | 相对项目根 POSIX 路径；`<gateId>` 取显式 `gateId`（若给出）否则取由 `stage` 推导的交接 id |
| `enforcement` | `string` 枚举 | 是 | — | 仅 `blocking` |

**字段表 — 所有 check 共有字段**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | `string` | 是 | — | 门禁内唯一，`^[a-z0-9][a-z0-9-]{1,63}$` |
| `type` | `string` 枚举 | 是 | — | `file_exists` \| `file_not_exists` \| `regex` \| `command` \| `json_assert` \| `trace_matrix` \| `policy` |
| `required` | `boolean` | 否 | `true` | `false` 时该检查失败仅记入 `checks`，不产生 blocker |
| `severity` | `string` 枚举 | 否 | 按类型 | `blocker` \| `high` \| `medium` \| `low`；默认：`file_exists`/`file_not_exists`/`json_assert`/`trace_matrix`/`policy` ⇒ `high`；`regex` ⇒ `medium`；`command` ⇒ `high` |
| `onFail` | `string` 枚举 | 否 | `"fail"` | `fail` \| `warn`；`warn` ⇒ `passed` 按真实结果记录，但不进 `blockers` |
| `description` | `string` | 否 | `""` | 人类可读说明，进 `--summary` 输出 |

**字段表 — 每类 check 的专属字段**

| check.type | 专属字段（名称 : 类型 : 必填 : 默认 : 约束） |
|---|---|
| `file_exists` | `file : string : 是 : — : 相对项目根 POSIX 路径，支持 `*`/`**` glob`；`minCount : integer : 否 : 1 : ≥1（glob 匹配数下限）` |
| `file_not_exists` | `file : string : 是 : — : 同上（glob 命中任意一个即失败）` |
| `regex` | `files : array<string> : 是 : — : 长度 ≥1，元素为相对路径或 glob`；`pattern : string : 是 : — : 非空，JS 正则源`；`flags : string : 否 : "gm" : 仅 `gimsuy` 子集`；`mode : string 枚举 : 否 : "each" : `each`\|`any`\|`all`\|`count``；`minMatches : integer : 否 : 1 : ≥1；`mode="count"` 时为全局下限`；`countMode : string 枚举 : 否 : "total" : `total`\|`unique``；`encoding : string 枚举 : 否 : "utf8" : `utf8`\|`utf16le`` |
| `command` | `run : array<string> : 是 : — : 长度 ≥1，`run[0]` 为可执行文件名（不解析 shell）`；`expectExitCode : integer : 否 : 0 : 0–255`；`timeoutMs : integer : 否 : 60000 : 1000–600000`；`cwd : string : 否 : 项目根 : 相对项目根 POSIX 路径`；`captureStdout : boolean : 否 : true : 捕获输出写入 evidence.excerpt（截断 4096 字符）`；`stdoutRegex : string : 否 : 省略 : 设置后额外要求 stdout 命中` |
| `json_assert` | `file : string : 是 : — : 必须为单个 JSON 文件（不支持 glob）`；`assertions : array<object> : 是 : — : 长度 ≥1`；每个断言 `{ pointer : string : 是 : JSON Pointer (RFC 6901)`；`exists : boolean : 否 : 省略`；`equals : any : 否 : 省略`；`matches : string : 否 : 省略 : 对字符串化值做正则`；三者至少给一个 }` |
| `trace_matrix` | `requirementsFile : string : 是 : — : 相对路径`；`traceFile : string : 是 : — : 相对路径`；`enforce : string 枚举 : 否 : "strict" : `strict`\|`lenient``（strict 下 `covered=false` 的 P0/P1 需求即失败）；`testIdSource : string 枚举 : 否 : "ledger-index" : `ledger-index`\|`trace-only`` |
| `policy` | `policyId : string 枚举 : 是 : — : `SAFE_001`\|`SAFE_002`\|`SAFE_003`\|`CONTRACT_001`（含义见下表）`；`expectedFiles : array<string> \| null : 否 : null : 元素为非空相对路径；非空时把该策略检查的扫描限定为这份显式文件列表（最多前 5 个记录为 evidence），取代按 `policy.scanRoots` 的子树扫描` |


> **唯一性约束的表达力边界（t20 记录）**：`gate.id` **全局唯一**与 `check.id` **门禁内唯一**这两条约束**由引擎校验，JSON Schema 不表达**——JSON Schema 没有跨元素唯一性关键字（`uniqueItems` 只能判定「数组元素整体互不相同」，无法按某个字段去重），硬表达只会伪造强度。因此 `packages/qgate/examples/invalid/` 中**依赖唯一性的反例**（如 `duplicate-check-id.json`）**预期在 schema 下 `valid=true`、在引擎下退出码 2**（`error.code="CONFIG_INVALID"`，message 含 `duplicate check.id`）。判定「配置是否被接受」**以引擎为准**，schema 只是字段级的静态检查。

**`policyId` 语义表**

| policyId | 断言 | 违反后果 |
|---|---|---|
| `SAFE_001` | 配置、脚本与文档中不得出现 `apiKey`/`ANTHROPIC_API_KEY` 的**读取**或 `secrets.` 形式的密钥引用 | 失败（无网络/无密钥硬保证） |
| `SAFE_002` | 密钥路径（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`credentials*`、`secrets/**`）不得出现在任何 `include` 的有效结果中 | 失败（OCR 安全不变量） |
| `SAFE_003` | 实现中不得出现网络调用面（`fetch(`、`net.`、`http.request`、`https.request`） | 失败（离线硬保证） |
| `CONTRACT_001` | 受检文件中出现的 check.type / stage / 字段名必须全部在冻结枚举与字段表内 | 失败（契约漂移检测） |

---

### 5.2 (d) RunResult schema

结构（字段名与类型必须与实现一致）：

> **示例读法（与 §3.2 裁决一致，必读）**：本示例中的人类门禁挂在 `gate.id="req-spec"`、`stage="requirements"` 的门禁上。门禁 **id ≠ 交接 id**：示例**省略**了可选字段 `humanGate.gateId`，因此**交接身份由 `stage` 推导**为 `req-to-design`，`approvalRecord` 的默认路径即 `verification/approvals/req-to-design/approval.json`，`role` 必须是该交接位置对应的 `product`。**这正说明承载人类门禁的门禁可以叫任意合法 id**——`req-spec` 不是三大交接 id 之一，却因位于 `requirements` 的出口而合法（见 §3.2 冻结规则；同一例子在 `packages/qgate/test/_canonical-config.json` 与引擎回归中被验证）。若要改写交接身份，可显式给出可选覆盖：`"humanGate": { "gateId": "req-to-design", "role": "product", "approvalRecord": "verification/approvals/req-to-design/approval.json", "enforcement": "blocking" }`。

```json
{
  "version": "1.0",
  "run_id": "2026-05-05T10-22-31-004Z-a1b2c3d4",
  "started_at": "2026-05-05T10:22:31.004Z",
  "finished_at": "2026-05-05T10:22:33.918Z",
  "duration_ms": 2914,
  "overall_passed": false,
  "provider": { "type": "deterministic", "degraded": false, "detail": "offline-fixture" },
  "gates": [
    {
      "id": "req-spec",
      "stage": "requirements",
      "required": true,
      "passed": true,
      "humanGate": { "role": "product", "approvalRecord": "verification/approvals/req-to-design/approval.json", "approvalState": "approved", "approvedBy": "product-owner", "approvedAt": "2026-05-04T09:00:00Z" },
      "blockers": [],
      "checks": [
        {
          "id": "req-doc-exists",
          "type": "file_exists",
          "passed": true,
          "severity": "high",
          "evidence": [ { "path": "docs/00-requirements.md", "kind": "file", "excerpt": "sha256:9f2c…" } ]
        },
        {
          "id": "req-ids-present",
          "type": "regex",
          "passed": true,
          "severity": "medium",
          "evidence": [ { "path": "docs/00-requirements.md", "kind": "file", "excerpt": "uniqueMatches=16" } ]
        }
      ]
    },
    {
      "id": "verify-coverage",
      "stage": "verify",
      "required": true,
      "passed": false,
      "humanGate": null,
      "blockers": [
        {
          "checkId": "trace-complete",
          "severity": "high",
          "message": "TRACE_GAP: REQ-QUALITY-GATE-014 covered=false (testIds present, no ledger run references T-QG-014)",
          "evidence": [ { "path": "verification/trace-matrix.json", "kind": "trace", "excerpt": "/requirements/13/covered" } ]
        }
      ],
      "checks": [
        {
          "id": "trace-complete",
          "type": "trace_matrix",
          "passed": false,
          "severity": "high",
          "evidence": [
            { "path": "verification/trace-matrix.json", "kind": "trace", "excerpt": "/requirements/13" },
            { "path": "verification/evidence/ledger-index.json", "kind": "ledger", "excerpt": "runIds=3" }
          ]
        }
      ]
    }
  ]
}
```

**字段表 — RunResult 顶层**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version` | `string` | 是 | 恒为 `"1.0"`（`runResultSchemaVersion`） |
| `run_id` | `string` | 是 | `^[0-9T:.\-Z]+-[0-9a-f]{8}$`；同一 run 内唯一 |
| `started_at` | `string` | 是 | RFC3339 UTC |
| `finished_at` | `string` | 是 | RFC3339 UTC，≥ `started_at` |
| `duration_ms` | `integer` | 是 | ≥0 |
| `overall_passed` | `boolean` | 是 | `= gates.filter(g=>g.required).every(g=>g.passed)` |
| `provider` | `object` | 是 | `{type: string, degraded: boolean, detail: string}` |
| `gates` | `array<object>` | 是 | 顺序 = §3.1 阶段顺序；见下表 |

**字段表 — `gates[]`**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 与配置 `gate.id` 一致 |
| `stage` | `string` 枚举 | 是 | 五阶段之一 |
| `required` | `boolean` | 是 | 与配置一致 |
| `passed` | `boolean` | 是 | **当且仅当**该门禁内不存在「`required=true && passed=false && onFail!=="warn"`」的检查、且人类门禁满足时为 `true`。**`severity` 不是阻断开关**（见 §5.2.1） |
| `humanGate` | `object \| null` | 是 | 无人类门禁时必须为 `null`（显式键存在）；否则 `{role, approvalRecord, approvalState:"approved"\|"missing"\|"rejected"\|"role_mismatch", approvedBy:string\|null, approvedAt:string\|null}` |
| `blockers` | `array<object>` | 是 | 可为空数组；元素见下表 |
| `checks` | `array<object>` | 是 | 按配置顺序；元素见下表 |

**字段表 — `gates[].blockers[]`**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `checkId` | `string` | 是 | 触发阻断的检查 id（人类门禁阻断时用门禁 id） |
| `severity` | `string` 枚举 | 是 | `blocker` \| `high` \| `medium` \| `low` |
| `message` | `string` | 是 | 单行机器可读前缀 + 说明，前缀枚举见 §9.2 |
| `evidence` | `array<object>` | 是 | 长度 ≥1；元素见 §5.3.1 |

**字段表 — `gates[].checks[]`**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 与配置 `check.id` 一致 |
| `type` | `string` 枚举 | 是 | 七类之一 |
| `passed` | `boolean` | 是 | 该检查真实判定结果（`onFail="warn"` 不必为 true） |
| `severity` | `string` 枚举 | 是 | 与配置或类型默认一致 |
| `evidence` | `array<object>` | 是 | 长度 ≥1（无证据则视为实现缺陷）；元素见 §5.3.1 |

#### 5.2.1 阻断语义（冻结裁决）与 `--stage` 的输出形状

> **裁决（t27，配对 t26 的实现修复）：`required` 决定门禁通过与否，`severity` 只决定呈现与升级。**

**判定规则（唯一自洽读法）**：

1. 对任一检查：**`check.required === true && check.passed === false && check.onFail !== "warn"` ⇒ 该门禁 `passed=false`；若该门禁 `required=true`，则 `overall_passed=false` ⇒ 退出码 1**。
2. **`severity` 不是阻断开关**：`severity ∈ {blocker, high, medium, low}` **仅**用于报告分级、排序与升级路径（见 §4.4 的 finding 分级、`--summary` 的呈现顺序、AI 修复预算的升级判定）。**不得**用它决定某个已失败的检查是否阻断门禁。
   - 具体地：**默认 `severity` 为 `medium` 的必需检查（例如 `regex`）失败，同样必须阻断** —— 这正是 §5.1 参考示例「不写 `severity`」依然会被阻断的原因。
3. **`onFail` 是唯一显式免阻断通道**：`onFail="warn"` ⇒ 该检查的 `passed` 仍按**真实结果**记录（可为 `false`），但**不产生 blocker、不使门禁失败**；`onFail="fail"`（默认）⇒ 按规则 1 阻断。该字段已在 §5.1「所有 check 共有字段」定义（枚举 `fail` | `warn`，默认 `fail`）。
4. `gate.required === false` ⇒ 该门禁失败**只记录**，不影响 `overall_passed`（与顶层公式一致）。

**顶层 `overall_passed` 公式（含 `--stage` 情形）**：

```text
overall_passed = gates[].filter(g => g.required).every(g => g.passed)
# gates[] 只包含本次「已运行」的门禁（见下），因此 --stage 情形下该公式
# 只对「已运行且 required」的门禁求 every —— 语义依旧自洽。
```

**`--stage` / `--gate` 过滤后的 `gates[]` 形状（冻结）**：

- **未运行的门禁不出现在 `gates[]` 中**（**省略**：既不记 `passed:false`，也不记 `passed:true`）。实测：`qgate check --stage build --json` ⇒ `gates[].id` = `req-spec, interface-frozen, build-deterministic`，`overall_passed=true`，exit 0。
- **为什么不能占位**：`overall_passed` 的公式对 `gates[]` 求 `every`。若把未运行门禁以 `passed:false` 留在 `gates[]`，`--stage` 将**永远算出 `false`**，§8.2 的四个阶段 job 会**全部挂**；若记 `true`，则构成**假通过**（与「未验证却声称通过」同类）。**省略是唯一既非 false 也非 true 的诚实表达。**
- **`--summary` 有两个输出面，必须分清（t44 写清；此前措辞含糊，曾使 captain 与 verifier 各误判一次）**：
  - **① stdout 人类可读文本面**（不给 `--out` 时的默认面，**不是 JSON**）：门禁表格 + `overall_passed=… run_id=… provider=…`，**未运行的门禁以人类行逐条列出**：`not-run <stage>/<gate>: <reason>`。
  - **② `--summary --out <file>` 落盘的 JSON 包络面**：键集合实测为 `overall_passed` / `gates` / **`not_run_gates`** / `run_id` / `provider` / `approvals_missing`。**结构化数组 `not_run_gates: [{id, stage, reason}]` 只存在于这个包络里——必须给 `--out` 才能取得**；它**不在** RunResult 中（RunResult 的键集合由 §5.2 冻结、`additionalProperties:false`），**也不在** stdout 文本里以 JSON 形式出现。
  - 两面的**实测样例**见下方两个代码块（同一次 `--summary --out` 调用，两面的 `run_id` 相同）。
- 这与 §6.2 命令表「`--stage <name>`（只跑到该阶段，含）」一致：**已运行的门禁完整出现在 `gates[]`，未运行的门禁完全不在其中**。

**实测样例 ① stdout 文本面**（`node packages/qgate/bin/qgate.mjs check --stage build --config demo/qgate.config.json --summary --out <file>` 的 stdout，原文节选）：

```text
stage        | gate                 | required | passed | blockers | checks
-------------|----------------------|----------|--------|----------|-------
requirements | req-spec             | true     | true   | 0        | 3
design       | interface-frozen     | true     | true   | 0        | 4
build        | build-deterministic  | true     | true   | 0        | 4

overall_passed=true run_id=2026-09-17T19-53-38.291Z-cfd6a5fe provider=deterministic
  not-run review/review-counterexample: excluded by the --stage/--gate filter
  not-run verify/verify-coverage: excluded by the --stage/--gate filter
ledger=.qgate/evidence/ledger-2026-09-17T19-53-38.291Z-cfd6a5fe.json
ledger-index=.qgate/evidence/ledger-index.json
```

**实测样例 ② `--out` 包络面**（**同一次调用**落盘的 JSON，节选 `not_run_gates`；`run_id` 为运行时字段，与样例 ① 相同）：

```json
{
  "overall_passed": true,
  "gates": [ { "id": "req-spec", … }, { "id": "interface-frozen", … }, { "id": "build-deterministic", … } ],
  "not_run_gates": [
    { "id": "review-counterexample", "stage": "review", "reason": "excluded by the --stage/--gate filter" },
    { "id": "verify-coverage", "stage": "verify", "reason": "excluded by the --stage/--gate filter" }
  ],
  "run_id": "2026-09-17T19-53-38.291Z-cfd6a5fe",
  "provider": { "type": "deterministic", "degraded": false, "detail": "offline-fixture" },
  "approvals_missing": 0
}
```

**人类行与结构化数值逐字一致（实测，t44 复跑）**：`--stage requirements` ⇒ `not_run_gates` **4** 项、`design` ⇒ **3**、`build` ⇒ **2**、`review` ⇒ **1**，`reason` 全部为 `excluded by the --stage/--gate filter`；且 stdout 的 `not-run <stage>/<gate>` 序列与包络的 `not_run_gates[].stage` + `.id` 序列**四组逐项相同**（两面对照 `consistent=true`）。

---

### 5.3 (e) 证据制品格式

#### 5.3.1 证据引用对象（嵌在 RunResult 中）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `path` | `string` | 是 | 相对项目根 POSIX 路径；必须能被解析（`kind="file"` 时文件必须存在） |
| `kind` | `string` 枚举 | 是 | `file` \| `stdout` \| `json_pointer` \| `ledger` \| `trace` |
| `excerpt` | `string` | 是 | ≤4096 字符；`json_pointer` 时存 JSON Pointer 字符串；`file` 时存 `sha256:<hex>` 或行片段 |

#### 5.3.2 证据账本 `verification/evidence/ledger-<run_id>.json`

```json
{
  "schemaVersion": "1.0",
  "ledgerId": "2026-05-05T10-22-31-004Z-a1b2c3d4",
  "runId": "2026-05-05T10-22-31-004Z-a1b2c3d4",
  "started_at": "2026-05-05T10:22:31.004Z",
  "finished_at": "2026-05-05T10:22:33.918Z",
  "projectRoot": ".",
  "configPath": "demo/qgate.config.json",
  "configSha256": "6b1f…",
  "provider": { "type": "deterministic", "degraded": false, "detail": "offline-fixture" },
  "entries": [
    {
      "gateId": "req-spec",
      "stage": "requirements",
      "checkId": "req-doc-exists",
      "type": "file_exists",
      "required": true,
      "passed": true,
      "severity": "high",
      "durationMs": 3,
      "testId": "T-QG-001",
      "evidence": [ { "path": "docs/00-requirements.md", "kind": "file", "excerpt": "sha256:9f2c…" } ]
    },
    {
      "gateId": "verify-coverage",
      "stage": "verify",
      "checkId": "trace-complete",
      "type": "trace_matrix",
      "required": true,
      "passed": false,
      "severity": "high",
      "durationMs": 11,
      "testId": "T-QG-006",
      "evidence": [ { "path": "verification/trace-matrix.json", "kind": "trace", "excerpt": "/requirements/13" } ]
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `string` | 是 | `"1.0"` |
| `ledgerId` | `string` | 是 | 等于 `runId` |
| `runId` | `string` | 是 | 与 RunResult `run_id` 一致 |
| `started_at` / `finished_at` | `string` | 是 | RFC3339 UTC |
| `projectRoot` | `string` | 是 | 恒为 `"."`（相对化锚点） |
| `configPath` | `string` | 是 | 相对项目根 |
| `configSha256` | `string` | 是 | 配置内容 sha256（hex，≥16 位截断亦可） |
| `provider` | `object` | 是 | 同 RunResult.provider |
| `entries` | `array<object>` | 是 | 按 `gateId` 升序、再 `checkId` 升序稳定排序后写盘 |
| `entries[].testId` | `string \| null` | 是 | 映射检查的 testId；无法映射时为 `null` |
| `entries[].durationMs` | `integer` | 是 | 该检查的**实测耗时（毫秒）**，≥0。**属运行时字段**：与 RunResult 的 `duration_ms` 同类，**不参与「同输入同输出」的确定性比对**（§5.4 的运行时字段口径）。实现须用**单调时钟**测量（实测采用 `process.hrtime.bigint()`，例如 `command-smoke=92ms`、`no-secret-paths=9ms`）；**不得**用 `Date.now()` 差值（会被系统时钟回拨影响），也**不得**恒置 0 |

**账本索引 `verification/evidence/ledger-index.json`**

```json
{
  "schemaVersion": "1.0",
  "updated_at": "2026-05-05T10:22:33.918Z",
  "runIds": ["2026-05-04T08-11-02-115Z-77aa11bb", "2026-05-05T10-22-31-004Z-a1b2c3d4"],
  "ledgers": [
    { "runId": "2026-05-05T10-22-31-004Z-a1b2c3d4", "path": "verification/evidence/ledger-2026-05-05T10-22-31-004Z-a1b2c3d4.json", "sha256": "c4d9…", "overall_passed": false, "started_at": "2026-05-05T10:22:31.004Z" }
  ],
  "testIds": ["T-QG-001", "T-QG-002", "T-QG-003", "T-QG-004", "T-QG-005", "T-QG-006"]
}
```

约束：`runIds` 只追加不重排（按写入顺序）；`ledgers[].sha256` 必须等于该账本文件真实 sha256；`testIds` 为所有账本 `entries[].testId` 去重后的升序数组（用于 §5.3.3 的孤儿检测）。

**能力边界（信任模型，t35 记录）**

本小节由 **t29 第二轮评审**提出，captain 裁决为「**记边界，不造机制**」：在校验者与被校验对象同域时，用自包含校验去"防伪造"是不可能做到的，硬做只会产生"看起来更安全"的假象。故这里只**如实限定保证强度**，不新增机制。

**能发现什么（三种实测情形）**：引擎在跑任何门禁前校验账本链，下列三条**全部成立**才继续，任一不成立即抛 `EVIDENCE_UNRESOLVED`（§6.5 的 `error.code` 枚举，退出码 3）：

1. 逐条复算 `ledgers[].sha256` 与该账本文件的真实 sha256；
2. `runIds` 与 `ledgers[]` 必须**同集合且无重复**；
3. 证据目录内**不得存在未登记的账本文件**。

t29 实测（落盘：`verification/review-round2.md` §2 第 5 条，复核时 L51）：三种**真实篡改**各自 exit 3 + `EVIDENCE_UNRESOLVED`——① 改账本某条 `passed`；② 改 `ledger-index.ledgers[0].sha256`；③ 篡改 `runIds`。这三种在第一轮评审时**都是 exit 0**，即这层校验确实收紧了它们，分别对应**意外 / 陈旧 / 局部篡改**（人工改动或部分覆盖留下的不自洽会被复算抓到）。

**不能发现什么（同域限制）**：**整条链的一致伪造**。t29 第二轮**新构造**的绕过（落盘：同文件 §3 第 1 条，复核时 L126-L129）：清空 `evidence/**` 后，用引擎自己的 sha256 写一个**自造**账本 `ledger-<伪造 runId>.json`（条目覆盖索引声明的全部 testId），再写一份 `runIds` / `ledgers` / `testIds` 自洽、`sha256` 与文件一致的 `ledger-index.json` ⇒ **未报 `EVIDENCE_UNRESOLVED`**、`trace-complete` 通过（该次整体 exit 1 仅因实验同时清空了 `test-results.json` 等，blocker 全是 `FILE_MISSING`，与本绕过无关）。

根因是**信任域**：校验依据（`sha256`、`ledger-index.json`）与被校验对象（账本文件）**同在 `verification/evidence/**` 内、同由能写该目录的一方决定**。因此该检查的**保证强度**是「**完整性一致性**」——同一目录内的账本与索引自洽、且未被局部改动；**不是**「抗恶意伪造」。一句话：**能写 `verification/evidence/**` 的一方，就能铸造覆盖率依据**。这是"自包含校验"这一设计选择的固有上限，不是实现缺陷。

**措辞纪律（因此不得暗示的）**：本文档其它位置——含 §8.2 的 CI artifact 上传、§9.1 的审批记录、`docs/00-requirements.md` REQ-005 的"可复算"与 REQ-007 的"可审计"——**均不得**被解读为"证据/审批不可伪造"或"证据链可抗恶意方"。同族事实：`verification/approvals/**` 的审批记录是**自报 JSON**（`approvedBy` / `approvedAt` 无签名、无身份认证），"要求某角色签字"只能证明"该路径下存在一份形态合法的签字记录"（见 §8.2 的信任边界注记）。

**可选的外部锚点方向（本轮 t35 未实现，仅记录）**：下列做法能把"链是否被重铸"变成**跨域**可判定的问题，但都需要 CI / 版本控制侧配合；本项目**当前一个都没采用**：

| 方向 | 能防什么 | 不能防什么 | 本项目当前状态 |
|---|---|---|---|
| CI 产出清单：在 CI 内生成账本/索引清单并作为 artifact 留存，且本地不再作为校验输入 | 只有在 CI 真跑过且 artifact 被留存时，事后可比对"仓库内的链是否等于 CI 那次运行" | CI 从未运行、artifact 被删、或 CI 内本身可被改写时，不提供任何额外保证 | **未采用**：workflow 已上传 `qgate-evidence-*` artifact（5 个 job 各一步 `actions/upload-artifact`），但它是**留存**，从不作为校验输入、也不与提交绑定 |
| 提交签名：对含 `verification/**` 的提交签名，`git verify-commit` 通过才放行 | 把"谁写了这条链"绑定到**持钥者身份**，能发现"事后在本地重铸并伪装成同一次提交" | 只覆盖被签名的提交；持钥者（或被授权改仓库的人）仍可自己铸造 | **未采用**：本仓库当前**无 VCS**（无 `.git` 目录），也无签名流程 |
| 把 `ledger-index` 的哈希登记到 CI 产物 / 提交信息（例如写进 workflow run summary 或 commit trailer） | 让"链的哈希"离开 `verification/**` 这个信任域：任何重铸都会与已登记的哈希不一致 | 登记动作若由同一信任域执行，仍需外部（CI 平台 / 托管方）留存才有效 | **未采用**：现无任何登记或回写步骤 |

结论：**本原型只声明"完整性一致性"，不声明"抗伪造"**；上表三向均为**后续可选**方向，不在 t35（本轮）实施。

#### 5.3.3 追踪矩阵 `verification/trace-matrix.json`

```json
{
  "schemaVersion": "1.0",
  "generated_at": "2026-05-05T10:22:33.918Z",
  "generated_by": "qgate trace",
  "run_id": "2026-05-05T10-22-31-004Z-a1b2c3d4",
  "pipeline": ["requirements", "design", "build", "review", "verify"],
  "summary": { "requirements": 16, "covered": 15, "uncovered": 1, "orphanTestIds": 0, "coverageRatio": 0.9375 },
  "requirements": [
    {
      "requirementId": "REQ-QUALITY-GATE-001",
      "title": "门禁契约引擎必须按有序阶段执行",
      "priority": "P0",
      "stage": ["requirements", "design", "build", "review", "verify"],
      "testIds": ["T-QG-001"],
      "codePaths": ["packages/qgate/src/pipeline.mjs", "packages/qgate/src/checks/*.mjs"],
      "covered": true,
      "evidence": [ { "path": "verification/evidence/ledger-index.json", "kind": "ledger", "excerpt": "T-QG-001@2026-05-05T10-22-31-004Z-a1b2c3d4" } ]
    },
    {
      "requirementId": "REQ-QUALITY-GATE-014",
      "title": "provider 可替换，确定性 provider 由离线 fixture 驱动",
      "priority": "P1",
      "stage": ["build", "verify"],
      "testIds": ["T-QG-014"],
      "codePaths": ["packages/qgate/src/providers/*.mjs"],
      "covered": false,
      "evidence": []
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | `string` | 是 | `"1.0"` |
| `generated_at` | `string` | 是 | RFC3339 UTC |
| `generated_by` | `string` | 是 | 恒为 `"qgate trace"` |
| `run_id` | `string` | 是 | 生成时关联的 run |
| `pipeline` | `array<string>` | 是 | 恒为五阶段顺序 |
| `summary` | `object` | 是 | `{requirements:integer, covered:integer, uncovered:integer, orphanTestIds:integer, coverageRatio:number(0–1)}` |
| `requirements[].requirementId` | `string` | 是 | `^REQ-[A-Z0-9-]+-\d{3}$`，全文唯一 |
| `requirements[].title` | `string` | 是 | 非空 |
| `requirements[].priority` | `string` 枚举 | 是 | `P0` \| `P1` \| `P2` |
| `requirements[].stage` | `array<string>` | 是 | 元素取自五阶段枚举，非空 |
| `requirements[].testIds` | `array<string>` | 是 | `^T-[A-Z0-9-]+-\d{3}$`；P0/P1 必须非空 |
| `requirements[].codePaths` | `array<string>` | 是 | 相对项目根 POSIX 路径或 glob；可为空数组 |
| `requirements[].covered` | `boolean` | 是 | `= testIds.length>0 && testIds.every(t => ledgerIndex.testIds.includes(t))` |
| `requirements[].evidence` | `array<object>` | 是 | `covered=true` 时必须非空 |

**一致性规则（`trace_matrix` 检查的判定依据）**

1. `summary.requirements` 等于 `requirements.length`；`covered + uncovered = requirements`。
2. 每个 `requirements[].requirementId` 在 `docs/requirements-index.json` 中存在（双向一致）。
3. `orphanTestIds = |ledgerIndex.testIds − ⋃ testIds|` 必须为 0。
4. `enforce="strict"` ⇒ 任一 `priority ∈ {P0,P1}` 且 `covered=false` 的条目使检查失败，blocker `message` 前缀为 `TRACE_GAP`。
5. `coverageRatio = round(covered / requirements, 4)`。

#### 5.4 运行时字段口径（t37 补，冻结）

**定义**：**运行时字段** = 由「运行时刻」而非「输入内容」决定的字段。当前共两处（其余字段都必须是配置与被检内容的纯函数）：

| 位置 | 运行时字段 | 依据 |
|---|---|---|
| RunResult（§5.2） | `run_id`、`started_at`、`finished_at`、`duration_ms` | §5.2 字段表；§3.4 阶段 `build` 的退出条件 |
| 证据账本（§5.3.2） | `entries[].durationMs` | §5.3.2 字段表（与 RunResult 的 `duration_ms` 同类） |

**判定规则（REQ-010「同输入同输出」的精确读法）**：

1. 同一输入（同一 `--config` 取值 + 同一被检内容）的两次运行，RunResult **剔除上表四个顶层字段后**必须深度相等；账本的 `entries[].durationMs` **不进**确定性比对面（`entries[]` 的其它字段仍在比对面内）。
2. **除上表字段外，任何字段出现在两次运行的差异里都应视为非确定性缺陷**——不得把别的字段也当"运行时噪声"排除。
3. 运行时字段**不影响门禁判定**：`overall_passed`、`gates[].passed`、`blockers[]`、`checks[].passed` 都不依赖它们。

**边界（实测，t20 更正，见 §3.4）**：剔除运行时字段后，引擎 `check --json` 在**不同 cwd** 下仍可能有 **1 个**叶子不同——`/gates/2/checks/3/evidence/0/excerpt`（`no-bypass` 证据里回显了**被扫描配置文件的绝对路径**）。它只随 `--config` 的**路径拼写**变化、与 cwd 无关，属**输入回显**而非非确定性，完整记账见 §6.2.3 **GAP-7**。

---

## 6. (f) CLI 契约

入口：`node packages/qgate/bin/qgate.mjs <command> [options]`。发布形态为包内 `bin`（`packages/qgate/package.json` 的 `bin.qgate`），不依赖全局安装。

### 6.1 全局选项（所有命令可用）

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--config <path>` | string | `qgate.config.json` | **相对 cwd**（相对路径只在它存在的那个 cwd 下可用）或绝对路径；配置一旦被找到，root 由配置文件自身位置推断、RunResult 与 cwd 无关（见 §3.4 的「`--config` 的 cwd 语义」实测注记） |
| `--root <path>` | string | 配置文件所在目录的父级推断 | 被检仓库根 |
| `--json` | boolean | `false` | stdout 只输出机器可读 JSON（无前缀、无彩色、无日志；日志走 stderr） |
| `--summary` | boolean | `false` | stdout 输出**人类可读**摘要（表格/纯文本，**不是 JSON**）；与 `--json` 互斥，同时给出 ⇒ 退出码 2。分工见 §6.2.0 |
| `--quiet` | boolean | `false` | 抑制 stderr 进度日志 |
| `--color <mode>` | string 枚举 | `auto` | `auto` \| `always` \| `never` |
| `--out <path>` | string | 省略 | 额外把 JSON 结果原子写盘 |

### 6.2 命令参数表

#### 6.2.0 `--json` 与 `--summary` 的职责分工（冻结）

| 模式 | 输出形态 | 用途 | 判据 |
|---|---|---|---|
| `--json` | **机器可读 JSON**（各命令的契约面：`preview` 见 §6.2.1、`check` 见 §5.2、`trace` 见 §5.3.3） | CI、脚本、以及任何需要按字段断言的消费方 | 必须可被 `JSON.parse` 直接解析，**无**人类可读前缀 |
| `--summary` | **人类可读摘要**（表格或纯文本） | 人看；`--json` 与 `--summary` **互斥**，同时给出 ⇒ 退出码 2 | **不是** JSON；由各命令的 summary 渲染器生成（如 `cli.mjs` 的 `previewSummary` / `checkSummary`） |
| 二者都不给 | 命令的**默认文本输出** | 交互式使用 | — |

**实测（不得含糊）**：`node packages/qgate/bin/qgate.mjs preview --root demo/mini-service --json` ⇒ 合法 JSON，顶层 8 键（§6.2.1）；同一命令加 `--summary` ⇒ 形如 `root=… / included=14 excluded=14 groups=2 …` 的**纯文本**，**`JSON.parse` 会失败**。因此「`--summary` 也是 JSON」这一读法是错的——这正是 §6.1 全局选项表与本节要消除的歧义。

| 命令 | 用途 | 专属参数 | `--json` 行为 | `--summary` 行为 |
|---|---|---|---|---|
| `qgate contract` | 打印冻结契约自描述（schema 版本、枚举、命令表、退出码） | `--check`（校验本地 schema 文件与内置契约一致，不一致退出 3） | 输出 `{ok, configSchemaVersion, runResultSchemaVersion, checkTypes[], stages[], humanGates[], commands[], exitCodes{}}` | 输出契约表格摘要 |
| `qgate check` | 执行门禁流水线 | `--stage <name>`（只跑到该阶段，含）、`--gate <id>`（只跑该门禁，可重复）、`--fail-fast` | 输出完整 RunResult（§5.2） | 每个门禁一行：`stage \| gate \| passed \| blockers \| checks` |
| `qgate trace` | 生成/查看追踪矩阵 | `--write`（写盘到 `verification/trace-matrix.json`，原子替换） | 输出 trace-matrix 对象（§5.3.3） | 输出 `requirementId → testIds → covered` 表 |
| `qgate preview` | 确定性预览：选择/分组/规则结果，不执行门禁 | `--root <path>`（必用）、`--rule <path>`（覆盖规则文件） | 输出 **8 个顶层键** `{ok, degraded, root, selection{included[],excluded[]}, groups[{id,files[],downgraded,tokens}], ruleMatch[{file,ruleSource,ruleId,match,severity,category,priority}], rules{sources[],projectPath,note}, invariants{secretPathsSelected[],ocrAvailable}}`（完整类型与语义见 §6.2.1） | 人类可读分组/排除统计文本（**非 JSON**，见 §6.2.0） |
| `qgate report` | 由账本生成报告 | `--last <n>`（默认 1）、`--longest <n>`（默认 1，"longest" 的同义参数名固定为 `--longest`） | 输出 `{ok, reports:[{run_id, overall_passed, path}]}` | 输出报告路径与总判定 |
| `qgate explain` | 解释某个门禁/检查/需求为何通过或失败 | `--gate <id>` 或 `--check <id>` 或 `--requirement <REQ-ID>`（三者恰好给一个） | 输出 `{ok, subject:{kind,id}, passed, reason, evidence[], relatedRequirements[]}` | 人类可读解释段落 |
| `qgate stage` | 生成、导入或解释某个阶段的 AI 语义审查证据 | `<stage> <review\|ingest\|explain>`、`--mode`、`--result`、`--diff`、`--evidence` | 输出阶段证据；`review --mode offline` 不调用网络，`ingest` 只接受外部 OCR JSON | 输出阶段摘要和 finding |

**参数校验**：未知命令、未知选项、`--json` 与 `--summary` 同时出现、`explain` 未给或给了多个定位参数 ⇒ **退出码 2**，`error.code="CONFIG_INVALID"`。

`qgate stage` 不改变七类 check 或 RunResult 的通过权。它生成 `.qgate/evidence/ai/<stage>.json`，后续如需纳入门禁，必须由现有 `json_assert` 等确定性检查读取该制品；AI finding 本身不能写入 `overall_passed`。

#### 6.2.1 `qgate preview --json` 的输出键与 `ruleMatch[]` 形状（冻结）

`preview --json` 的顶层键集合**恰好为 8 项**（逐字取自实现 `packages/qgate/src/cli.mjs` 的 `commandPreview()`，其 `value` 字面量在该函数内构造）：

| # | 输出键 | 类型 | 说明（语义逐字取自实现） |
|---|---|---|---|
| 1 | `ok` | `boolean` | 恒为 `true`（成功路径；失败时走 §6.5 的错误对象而非本结构） |
| 2 | `degraded` | `boolean` | 降级信号。preview 本身不调用 `ocr`，故当前恒为 `false`；保留为与 `ocr` 适配层一致的降级位 |
| 3 | `root` | `string` | **审计锚点**：本次预览实际使用的根目录（`--root` 给出时为其 `path.resolve` 结果，否则为配置推断出的项目根），绝对路径 |
| 4 | `selection` | `object` | `{included: string[], excluded: [{path, reason, rule?, stage?}]}`；`included` 为被选中的项目根相对 POSIX 路径，`excluded` 每项给出排除理由（实现另带 `rule`/`stage` 字段，见下注） |
| 5 | `groups` | `array<object>` | `[{id: string, files: string[], downgraded: boolean, tokens: integer}]`；`id` 为分组标识，`files` 为该组成员，`downgraded=true` 表示因超 token 预算降级为单文件桶，`tokens` 为该组估算 token |
| 6 | `ruleMatch` | `array<object>` | **逐文件数组**：对 `selection.included` 中的**每个文件**各一项，给出该文件最终命中的规则（7 字段见下） |
| 7 | `rules` | `object` | 规则层来源证据：`{sources: [{source, path, pathKind, rules}], projectPath: string, note: string}`。`sources` 每层给出层名、路径、`pathKind`（`file` = 真实文件；`pseudo` = 内置层的引擎常量标识而非可解析位置）与规则条数；`projectPath` 为项目级规则路径常量；`note` 说明 `pseudo` 的含义 |
| 8 | `invariants` | `object` | **确定性/安全证据**：`{secretPathsSelected: array, ocrAvailable: boolean}`。`secretPathsSelected` 必须为空数组（任何非空即安全不变量违规）；`ocrAvailable` 当前恒为 `false`（preview 不探测 `ocr`） |

> **为什么是 8 个键而不是 3 个（不要裁剪）**：`degraded` 是**降级信号**、`root` 是**审计锚点**、`rules` 与 `invariants` 是**确定性/安全证据**。契约的职责是**准确描述现实**，不是把现实削到好看；裁剪它们会**丢信息**。下游若只关心选择/分组/规则，可按需读取 `selection` / `groups` / `ruleMatch` 三个键，但**不得**据此认为顶层只有三个键。

> **`selection.excluded[]` 的字段**：§6.2.1 上表按契约面记 `{path, reason}`；实现实测还带 `rule` 与 `stage`（例：`{"path":".env","reason":"secret_path","rule":"secret-env","stage":"secret_path"}`）。这两个附加字段属**实现附加信息**，消费方不应依赖其存在；如需冻结请走契约变更流程。

**`ruleMatch[]` 每项的字段表**（类型即实现契约；来源：`packages/qgate/src/rules.mjs` L106 的 `matchRule` 返回值，以及 `packages/qgate/src/cli.mjs` L453 为「无任何规则命中」补齐的兜底对象）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `file` | `string` | 该 entry 对应的文件（项目根相对 POSIX 路径），与 `selection.included` 一一对应 |
| `ruleSource` | `string` | 命中规则的来源层；取值含 `none`（无规则命中时的兜底层）。其余取值取自规则链的层名（`cli:flags` / `cli:--rule` / `project` / `user` / `builtin` 等，由 `loadRuleChain` 决定） |
| `ruleId` | `string \| null` | 命中规则的 `id`；规则未声明 id 时为 `null` |
| `match` | `string \| null` | 命中规则的匹配模式（glob）；无命中时为 `null` |
| `severity` | `string \| null` | 命中规则的严重度；规则未声明时为 `null` |
| `category` | `string \| null` | 命中规则的分类；规则未声明时为 `null` |
| `priority` | `number \| null` | 命中规则层的优先级序号（由该层在 `RULE_SOURCES` 中的位置决定，数字越小越优先）；无命中时为 `null` |

**形状规则（不得歧义）**：

1. `ruleMatch` **不是**单个对象，而是**逐文件数组**。一个变更集必然包含多个文件，每个文件各自命中一条规则，因此数组是唯一自然的形状（`qgate preview` 是参考实现）。
2. 数组长度等于 `selection.included.length`，且第 *i* 项的 `file` 等于第 *i* 个被选中的文件；无规则命中的文件同样产生一项，其 `ruleSource="none"`、其余可空字段为 `null`。
3. 只有单文件诉求时取 **`ruleMatch[0]`**，不要假定顶层是对象。
4. `ruleMatch` 与 `groups` 互补：`ruleMatch` 说明「每个文件为什么被纳入/如何被归类」，`groups` 说明「文件如何被组织成评审批次」。

> **自描述对齐注记（t31 更新）**：`packages/qgate/src/contract.mjs` 的 `commands[].json` 自描述把 preview 的 JSON 写作字符串常量 `"selection/groups/ruleMatch"`。注意两点：(a) 该常量**只列了 3 个键**，而实测顶层是 **8 个键**（§6.2.1）——它并**没有**断言「顶层只有三键」，但读者容易误读成那样，故本节是**键集合的规范出处**；(b) 该常量**无需修改**：preview 的 JSON 顶层是 `additionalProperties` 无约束的对象，`contract.mjs` 的常量只是自描述文本、不参与门禁判定。若 `qgate contract --json` 今后要输出更细的自描述（例如列出全部 8 键），由 **core-engineer 处理**（`packages/qgate/**` 的实现与自描述归其负责；architect 不改动其代码），并须按 §5.1 的**契约变更同步纪律**（t22）同批更新 `schema-contract.test.mjs` 的冻结表与 `_canonical-config.json`。

#### 6.2.2 适配层 `ocr-preview` 与 `qgate preview` 的字段名映射（冻结）

**裁决前提（captain 裁决，t12）**：适配层是 **OCR 兼容层**，其字段名（`rule_id` / `rule_source` / `estimated_tokens` 等）刻意贴近 `ocr` 的真实 JSON 输出形状以保持互操作。因此**保留适配层命名，不做重命名对齐**；本节的映射表是两边字段名关系的**唯一权威出处**，两份文档不得各写一套。适配层实现与 fixture 见 `adapters/opencodereview/src/ocr-pipeline.mjs` L146-L180 与 `adapters/opencodereview/test/fixtures/preview.default.json`。

**标注口径**：`同名` = 键名与语义完全一致；`等价异名` = 语义相同但键名不同；`适配层独有` / `契约独有` = 只有一侧存在。

##### 6.2.2.1 `ruleMatch[]`（两边都是逐文件数组；项数 == `selection.included.length`）

| 概念 | 适配层键（ocr-preview） | 契约键（§6.2.1） | 标注 |
|---|---|---|---|
| 文件路径 | `file` | `file` | 同名 |
| 规则来源层 | `ruleSource` | `ruleSource` | 同名 |
| 规则 id | `ruleId` | `ruleId` | 同名 |
| 匹配模式（glob） | `pattern` | `match` | 等价异名（适配层用 `pattern`，契约用 `match`） |
| 规则严重度 | —（无） | `severity` | 契约独有 |
| 规则分类 | —（无） | `category` | 契约独有 |
| 决策（included/excluded） | `decision` | —（无） | 适配层独有 |
| 人类可读理由 | `reason` | —（无） | 适配层独有 |
| 层优先级序号 | `priority` | `priority` | 同名（**但数值基准不同，见 §6.2.2.4**） |

覆盖：适配层 7 键全部列出，契约 7 键全部列出（7 ↔ 7，其中 3 同名、1 等价异名、2 契约独有、2 适配层独有）。

##### 6.2.2.2 `selected[]` / `excluded[]`（适配层独有的详细数组，**snake_case**）

适配层的 `selected[]`（L146）与 `excluded[]`（L148）使用 **snake_case**，而同一份产物里的 `ruleMatch[]`（L172-L180）使用 **camelCase**：

| 概念 | 适配层 `selected[]` 键（snake_case） | 适配层 `excluded[]` 键 | 契约对应 |
|---|---|---|---|
| 文件路径 | `path` | `path` | `file`（等价异名；`ruleMatch[].file`） |
| 规则来源层 | `rule_source` | `rule_source` | `ruleSource`（等价异名） |
| 规则 id | `rule_id` | `rule_id` | `ruleId`（等价异名） |
| 匹配模式 | `pattern` | `pattern` | `match`（等价异名） |
| 决策 | `decided_by` | `decided_by` | `decision`（等价异名；同为 `rule`/`safety`/… 判定者语义） |
| 人类可读理由 | `reason` | `reason` | 契约无（适配层独有） |
| 文件字节数 | `size` | —（无） | 契约无（适配层独有） |
| 估算 token | `tokens` | —（无） | 契约无（适配层独有；**注意不要与 `groups[].tokens` 混淆**） |
| 严重度 | —（无） | `severity` | **同名异义**（两侧都有此键但语义不同，**不可直接比较**；详见 §6.2.3 GAP-4） |
| 是否物化（盘上存在） | `materialized`（**t48 新增**） | —（无） | 契约无（**适配层独有**）；`false` = diff 声明但盘上不存在，见 **§6.2.2.5** |

适配层实测：`selected[0]` = `{"decided_by":"rule","path":"…","pattern":"src/**/*.mjs","reason":"…","rule_id":"demo-src","rule_source":"cli:--rule","size":415,"tokens":104,"materialized":true}`；`excluded[0]` = `{"decided_by":"safety","path":".env.production","pattern":".env*","reason":"sensitive_path_never_included","rule_id":"SAFETY-001-SENSITIVE-PATH","rule_source":"SAFETY_INVARIANT","severity":"safety-invariant"}`。两个数组的**语义**与 `ruleMatch[]` 同源（同一批选中/排除文件），差别在**拼写风格与字段集**。（**t48 追加**：`selected[]` 另带 `materialized: boolean`，故上例的键集由 8 键变为 9 键；该键为**适配层独有**，语义见 §6.2.2.5。）

**命名规律（单向蕴含，冻结判据）**

> captain 早期把该规律概括为**双向**（「引擎有同名概念 ⇒ camelCase；适配层自造 ⇒ snake_case」）。逐键清点实测**推翻了该双向概括**，准确规律是**单向蕴含**，本节即其判据出处（§6.2.3 GAP-2 只负责描述现象，与本节不冲突）。

1. **`snake_case` ⇒ 适配层独有（单向蕴含，零例外）**：适配层输出中出现的 snake_case 键共 **10 个**（`decided_by`、`rule_id`、`rule_source`、`estimated_tokens`、`file_count`、`downgrade_reason`、**`excluded_unmaterialized`（t48）**，以及 `decided_by`/`rule_id`/`rule_source` 在 `selected[]` 与 `excluded[]` 两个容器上的重复出现）——**全部**为适配层独有字段，**零例外**。因此：**一旦看到 snake_case，即可断言该字段是适配层独有，契约中不存在同名概念。**（t48 的 `counts` 容器同理：`selected_materialized` / `unmaterialized` / `groups_dropped_unmaterialized` 等全部为 snake_case，且全部适配层独有，见 §6.2.2.5。）
2. **camelCase 不是信号（反向蕴含不成立）**：`camelCase` 只是适配层的**默认风格**，**不能**据此推断「引擎也有此字段、可跨侧通用」。适配层输出中的 camelCase 键里有 **15 个完全是适配层独有**（含 t48 追加的 `selected[].materialized`；原句写作「13 个」与所列清单（14 项）不符，此处按逐键清点更正）：`ruleMatch[].decision` / `.pattern` / `.reason`、`groups[].id` / `.files` / `.downgraded`、`selected[].path` / `.pattern` / `.reason` / `.size` / `.tokens` / `.materialized`、`excluded[].path` / `.pattern` / `.reason`（逐键清点见下）。
3. **唯一例外是「同名异义」而非「适配层独有」**：camelCase 中另有 `excluded[].severity` 一个键——它在两侧**同名**，但语义完全不同（见 GAP-4），因此既不算「适配层独有」，也**不构成**「camelCase ⇒ 引擎面字段」的反例：它恰恰是**不能**按名字跨侧通用的典型。camelCase 中真正与契约同名同义的只有 `ruleMatch[].file` / `.ruleSource` / `.ruleId`。
4. **分区判据是「逐字段的来源」，不是「整个集合一套风格」**：同一容器可以混用两种风格，`groups[]` 即实例——camelCase 的 `id` / `files` / `downgraded` 与 snake_case 的 `estimated_tokens` / `file_count` / `downgrade_reason` 共存（适配层 `ocr-pipeline.mjs` L150-L157 逐字段命名）。因此**任何「按容器批量套用一种命名假设」的解析代码都会出错**；正确做法是按 §6.2.2 的映射表逐字段取用，或只用契约面（`selection` + `groups` + `ruleMatch`）中已声明可跨侧的键。

**逐键清点（本条的实测依据）**：`ruleMatch` 键集 `{decision,file,pattern,priority,reason,ruleId,ruleSource}`（全 camelCase；其中 `file`/`ruleSource`/`ruleId` 与契约同名同义，`priority` 同名但基准不同＝GAP-1）；`selected[0]` 键集 `{decided_by,path,pattern,reason,rule_id,rule_source,size,tokens}`（全 snake_case ⇒ 全为适配层独有）；`excluded[0]` 键集 `{decided_by,path,pattern,reason,rule_id,rule_source,severity}`（仅 `severity` 同名异义，其余全为适配层独有）；`groups[0]` 键集 `{downgrade_reason,downgraded,estimated_tokens,file_count,files,id}`（混用）。证据：`adapters/opencodereview/test/fixtures/preview.default.json`（真实运行产物）与 `adapters/opencodereview/src/ocr-pipeline.mjs` L146/L148/L150-L157/L172-L180。

##### 6.2.2.3 `groups[]`

| 概念 | 适配层键 | 契约键（§6.2.1） | 标注 |
|---|---|---|---|
| 分组标识 | `id` | `id` | 同名 |
| 组成员 | `files` | `files` | 同名 |
| 是否降级为单文件桶 | `downgraded` | `downgraded` | 同名 |
| 该组估算 token | `estimated_tokens` | `tokens` | 等价异名（**契约用 `tokens`**；易与 `selected[].tokens` 混淆） |
| 组内文件数 | `file_count` | —（无；由 `files.length` 导出） | 适配层独有 |
| 降级原因 | `downgrade_reason` | —（无） | 适配层独有 |
| 组内被剔除的未物化路径数 | `excluded_unmaterialized`（**t48 新增**） | —（无） | 契约无（**适配层独有**，计数；见 **§6.2.2.5**） |

适配层实测 `groups[0]` = `{"downgrade_reason":null,"downgraded":false,"excluded_unmaterialized":0,"estimated_tokens":306,"file_count":4,"files":[…4 项…],"id":"bucket:injection-chain"}`（`ocr-pipeline.mjs` L150-L157）。同类 `excluded[]`/`selected[]`，`groups[]` 也混用拼写：`id`/`files`/`downgraded` 为 camelCase 风格，`estimated_tokens`/`file_count`/`downgrade_reason` 为 snake_case。

##### 6.2.2.4 `selection`（**与契约同形的兼容视图**）

`selection`（`ocr-pipeline.mjs` L168-L171）是适配层为**直接对接 `qgate preview` 契约**而输出的投影视图，与 §6.2.1 逐字同形：

| 概念 | 适配层 `selection` | 契约（§6.2.1） | 标注 |
|---|---|---|---|
| 选中文件路径数组 | `included: string[]` | `included: string[]` | 同名（camelCase 键名，与契约一致） |
| 排除项 | `excluded: [{path, reason}]` | `excluded: [{path, reason}]` | 同名 |

**与 `ruleMatch[]` / `selected[]` 的关系（是否冗余视图）**：

1. `selection.included[]` 是 `selected[].path` 的**投影**（同一批文件、同一顺序）；实测两者长度均为 14 且逐项对应。它是**冗余视图**，用于免改写地喂给契约形状的消费者。
2. `selection.excluded[]` 是 `excluded[]` 只保留 `{path, reason}` 的**投影**（丢弃 `rule_id`/`rule_source`/`pattern`/`decided_by`/`severity`）；实测两者长度均为 9 且逐项对应。同为**冗余视图**。
3. `ruleMatch[]` **不是**投影：它是按文件给出的「最终命中规则」解释，长度与 `selection.included[]` 一致（14 == 14）、第 *i* 项 `file` 对应第 *i* 个 included 文件，但字段集与语义（命中规则 vs 选择结果）不同。`ruleMatch[]` 与 `selected[]` 才是同一批信息的**两种拼写**。
4. 因此消费方的推荐口径：**只用 `selection` + `groups` + `ruleMatch`（契约面）**；`selected[]` / `excluded[]` / `selectedPaths[]` / `excludedPaths[]` 是适配层的详细信息视图，按需读取，不要与契约面交叉混用字段名。
> **`selection.included[]` 含未物化路径（t48 复核；语义与映射均未变）**：该字段仍是**纯字符串数组、含全部声明路径**（不因物化与否增删），因此 t48 的计数修复**不改冻结面语义**。但读者**不得**据此以为它只含盘上存在的路径——实测：`--diff` 声明 9 条、其中 6 条不存在时，`selection.included` = **9**，而同一次运行的 `counts.selected_materialized` = **3**、`counts.unmaterialized` = **6**；要区分「声明」与「盘上真有」，用 `selected[].materialized`（§6.2.2.2）或顶层 `unmaterialized[]` / `selectedPathsMaterialized[]`（§6.2.2.5）。`selection.excluded[]` 不受影响。

##### 6.2.2.5 顶层计数与未物化清单（**t48 新增；适配层独有**）

t48 引入「**未物化路径**」（diff 声明、但盘上不存在的路径）的计数口径。下列键在**引擎侧全部无对应**（**适配层独有**），新增它们**不改变**任何既有键的语义（见 §6.2.2.4 的 `selection.included[]` 注记）：

| 概念 | 适配层键 | 契约键（§6.2.1） | 标注 | 语义 |
|---|---|---|---|---|
| 已物化的选中文件数 | `counts.selected_materialized` | —（无） | **适配层独有** | 「评审覆盖面」应当使用的计数 |
| 未物化路径数 | `counts.unmaterialized` | —（无） | **适配层独有** | 与顶层 `unmaterialized[]` 同源（同一批路径的计数） |
| 因整组都是未物化而被丢弃的组数 | `counts.groups_dropped_unmaterialized` | —（无） | **适配层独有** | 使 `counts.groups` 与 `--root` 对照对齐 |
| 未物化路径清单 | 顶层 `unmaterialized: string[]` | —（无） | **适配层独有** | 显式列出「声明了但盘上没有」的路径 |
| 已物化路径清单 | 顶层 `selectedPathsMaterialized: string[]` | —（无） | **适配层独有** | `selectedPaths[]` 的已物化子集 |

**实测（t50，适配层 CLI：`--diff` 声明 9 条 / 其中 6 条不存在 vs `--root` 对照）**：

- `selection.included` = **9**（含 6 条未物化）vs 对照 **3**；`counts.selected` = 9 vs 3。
- `counts.selected_materialized` = **3** vs 3；`counts.unmaterialized` = **6** vs 0；`counts.groups` = 2 vs 2；`counts.groups_dropped_unmaterialized` = **1** vs 0。
- `groups[].files` 合计 = **3**（未物化路径不进入任何组）vs 3；顶层 `unmaterialized[]` = 6 条路径 vs `[]`；顶层 `selectedPathsMaterialized[]` = 3 条 vs 3。
- **组内剔除的计数（混合组实测）**：声明 `src/mix/keep.mjs`（存在）+ `src/mix/gone.mjs`（不存在）⇒ 该组存活且 `file_count=1`、**`excluded_unmaterialized=1`**，同时 `counts.selected_materialized=1` / `counts.unmaterialized=1`。

> **与适配层 README 的措辞对照（读取口径提醒）**：`adapters/opencodereview/README.md` §6.2 把该清单写作「`payload.unmaterialized[]`」——**实测的键是顶层的 `unmaterialized`**（适配层输出**没有** `payload` 容器；README 里的「payload」指整个 CLI JSON 产物）。消费方请按**顶层** `unmaterialized` / `selectedPathsMaterialized` 读取。

> **同步纪律（t50 追加；与 §5.1 的「§ 字段表 / `schemas/**` 变更须请 core-engineer 同批同步 `schema-contract.test.mjs`」并列）**：适配层**新增输出键**或**改变既有键语义**时，必须**同批**更新本节 §6.2.2——本节的映射表是两侧字段名关系的**唯一权威出处**，权威面一旦落后于实现，读者会据此以为某键**不存在**（这正是「逐键权威」的全部价值）。
>
> **触发本条纪律的实例**：t48 给适配层输出加了 `selected[].materialized`、`groups[].excluded_unmaterialized`、`counts.selected_materialized`、`counts.unmaterialized`、`counts.groups_dropped_unmaterialized`、顶层 `unmaterialized[]` 与顶层 `selectedPathsMaterialized[]`，**未同批更新 §6.2.2**；由 t49 复验（**F8，medium**）发现，t50 补齐（即上表与 §6.2.2.5）。

#### 6.2.3 字段名对齐缺口（已知偏差，显式记账）

以下偏差**已知、已接受、不假装已对齐**。它们已并入本原型的「能力边界 / 已知缺口」记账（§8.3），由 captain 裁决为「保留适配层 OCR 原生命名，契约负责权威映射」。

| 编号 | 缺口 | 性质 | 影响 | 可复现证据 |
|---|---|---|---|---|
| **GAP-1** | `priority` **数值基准不同**：适配层 `ruleMatch[].priority` 为 **1 基**（CLI 层 = 1），引擎 `ruleMatch[].priority`（§6.2.1）为 **0 基**（`RULE_SOURCES.indexOf`，CLI 层 = 0） | **语义级差异（不是命名差异）** | 消费方把两侧 `priority` 当同一量纲混用（例如直接比较大小做「取最优层」或排序）会得到**错误排序**；只有层间相对顺序仍一致 | 适配层：`adapters/opencodereview/src/rules.mjs` L32-L37 的 `RULE_PRIORITY`（`cli:1, project:2, user:3, builtin:4`）经 `ocr-pipeline.mjs` L175 `priority: RULE_PRIORITY[e.ruleSource] ?? (e.ruleSource === 'cli:flags' ? 0 : null)` 写入；引擎：`packages/qgate/src/rules.mjs` L10 `RULE_SOURCES = ['--rule','project','user','builtin']` 经 L106 `priority: RULE_SOURCES.indexOf(layer.source)` 写入 |
| **GAP-2** | 适配层**同一份产物内两套命名风格**：`selected[]` / `excluded[]` / `groups[]` 的多数键为 snake_case（`rule_id`、`rule_source`、`decided_by`、`estimated_tokens`、`file_count`、`downgrade_reason`，以及 **t48 的 `excluded_unmaterialized` 与 `counts` 容器内的 `selected_materialized` / `unmaterialized` / `groups_dropped_unmaterialized`**），而 `ruleMatch[]` 与 `selection` 为 camelCase（`ruleId`、`ruleSource`、`decision`、`file`、`included`） | 命名风格差异 | 下游解析器若按「本产物统一 snake_case」或「统一 camelCase」的假设批量取值，会在另一组数组上取到 `undefined`（例如对 `selected[]` 读 `ruleId`、对 `ruleMatch[]` 读 `rule_id` 都为空） | 实测键集：`selected[0]` = `{decided_by,materialized,path,pattern,reason,rule_id,rule_source,size,tokens}`（t48 起含 `materialized`）；`ruleMatch[0]` = `{decision,file,pattern,priority,reason,ruleId,ruleSource}`（全 camelCase）；`groups[0]` = `{downgrade_reason,downgraded,estimated_tokens,excluded_unmaterialized,file_count,files,id}`（混用；t48 起含 `excluded_unmaterialized`）。见 `preview.default.json` 与 `ocr-pipeline.mjs` L146/L148/L150-L157/L172-L180 |
| **GAP-3** | 适配层独有、**契约中无对应**的键：`ruleMatch[].decision`、`ruleMatch[].reason`、`selected[].size`、`selected[].tokens`、`excluded[].severity`、`groups[].file_count`、`groups[].downgrade_reason`、`selectedPaths[]`、`excludedPaths[]`、顶层 `counts` / `grouping` / `rules` / `safety` / `provider` / `version`，以及 **t48 新增的 `selected[].materialized` / `groups[].excluded_unmaterialized` / `counts.selected_materialized` / `counts.unmaterialized` / `counts.groups_dropped_unmaterialized` / 顶层 `unmaterialized[]` / 顶层 `selectedPathsMaterialized[]`** 等 | 契约缺口（适配层独有） | 契约形状的消费者拿不到这些信息（尤其是 `safety.no_sensitive_selected` 这一安全断言与 `groups[].downgrade_reason` 这一降级留痕）；需要它们的消费者必须读适配层原始输出，不能只读契约面 | 见 `preview.default.json` 顶层键集与 `safety` 块；`ocr-pipeline.mjs` L190-L200（`safety`）与 L181-L189（`rules`） |
| **GAP-4** | **`severity` 是「同名异义」、`category` 是「引擎侧独有」**。`severity`：适配层**确实输出**该键（`excluded[].severity`），且与引擎 `ruleMatch[].severity` **同名**，但**语义不同、不可直接比较**——适配层的 severity 是**过滤判定类别**，引擎的 severity 是**规则条目声明**。`category`：适配层源码 `category` 出现 **0 次**，属引擎侧独有（注意：GAP-3 把 `excluded[].severity` 计入「适配层独有键」是按**字段集**口径，本条按**同名**口径记为同名异义，两者不矛盾） | 同名异义（`severity`）+ 引擎侧独有（`category`） | 消费方若把 `excluded[].severity` 当作引擎的规则严重度读取或比较，会得到**错误结论**（例如把安全不变量标记 `blocker` 误当成规则严重度 `blocker`）；只读适配层输出时也无法按规则的 `category` 分流 | 适配层来源：`adapters/opencodereview/src/filters.mjs` 的 `classifyFile()` 产出判定类别（L175 敏感路径 = `blocker`，L187/L199/L210/L224 其余 = `info`），经 `adapters/opencodereview/src/ocr-pipeline.mjs` **L148** `severity: e.decidedBy === 'safety' ? 'safety-invariant' : 'info'` 写入 `excluded[].severity`；实测 `preview.default.json` 的该字段值分布为 `{"safety-invariant": 9}`（本样例 9 条排除项全由安全层判定；非安全层的排除项写作 `info`）。引擎来源：`packages/qgate/src/rules.mjs` 的 `BUILTIN_RULES`（L16-L21，规则条目自带 `{id, match, severity, category}`，如 `builtin-tests` = `severity:"medium"` / `category:"tests"`），经 L106 写入 `ruleMatch[].severity` / `.category`。**管道现状（如实记账，本轮不修代码）**：适配层 `adapters/opencodereview/src/rules.mjs` 的 `explainFile()`（L208-221 区域）**未把 `classification.severity` 传出**（返回对象为 `{…, ruleId, pattern, decidedBy, layersLoaded}`），故 `ruleMatch[]` 中看不到 severity（实测 `ruleMatch[0]` 键集确无 `severity`），severity 只出现在 `excluded[].severity`——这是一条已记账的能力缺口 |
| **GAP-5** | **规则层解析在「未显式给出 root」时以 `process.cwd()` 为锚，导致 `layer_trace[].file` 随 cwd 变化**（跨 cwd 确定性缺口）。实测同一命令：(a) `cwd=仓库根` 与 (b) `cwd=E:\Desktop`——适配层输出**仅有 1 个叶子键**不同：`$.rules.layer_trace[1].file` = `E:\ai-quality-gate\.opencodereview\rule.json`（a）vs `E:\Desktop\.opencodereview\rule.json`（b）；其余全部叶子键一致（逐叶子比对，差异键数 = 1）。**引擎侧经实测不受影响**：`packages/qgate/src/cli.mjs` 的 `commandPreview` 在 `--config` 模式下经 `loadConfig(...)` 的 root 推断（L209）取 `<config 所在目录>` 为 root，在 `--root` 模式下 L442-L443 取显式 root；两种模式下从两个 cwd 运行输出**字节级一致**（`--config` 模式 12395 B == 12395 B，`--root` 模式 113406 B == 113406 B，差异叶子键 = 0）。且引擎 preview 输出**不含** `layer_trace` 字段（仅 `rules.sources` / `rules.projectPath`，来自契约路径而非 cwd），故 L204 的 `process.cwd()` 兜底在当前 preview 路径上未被触发 | **确定性缺口（跨 cwd）**，非命名差异 | **REQ-010「同一输入必得同一输出」在跨 cwd 意义上不成立**（对适配层的规则层轨迹而言）。影响面：适配层 `rules.layer_trace[].file`（及 `loaded_layers[].file`），即「项目级/用户级规则文件被解析成哪个绝对路径」这一留痕；不影响 **规则内容**（在两者中 `.opencodereview/rule.json` 均不存在，`loaded=false`，实际生效层相同），也不影响选择/分组/ruleMatch 结果。风险在于审计与 diff 场景：同一仓库从不同目录运行会得到不同的绝对路径留痕，若把该产物当字节级证据使用会误判为「漂移」 | 适配层根因：`adapters/opencodereview/src/ocr-pipeline.mjs` **L35** `const ruleRoot = opts.root ? path.resolve(opts.root) : process.cwd();`。引擎根因（当前未触发，但属同源写法）：`packages/qgate/src/cli.mjs` **L204** `root: ctx.options.root ? path.resolve(process.cwd(), ctx.options.root) : process.cwd()`（仅在不给 `--config` 而走 `defaultConfig()` 兜底分支时生效，L209 之后被 `loadConfig` 覆盖）。**修复方向（待修）**：无 `--root` 时不要以 `process.cwd()` 为锚，改为锚到**输入文件所在目录**（diff 路径所在目录）或**配置文件所在目录**；两侧写法同源，宜一并修。**修复代价**：须重录 3 个 fixture（`adapters/opencodereview/test/fixtures/preview.default.json`、`preview.token-budget-300.json`、`selection.default.md`），属预期变更 |
| **GAP-6** | **夹具把仓库绝对路径固化为期望值（夹具可移植性缺口）**——性质与 GAP-5 **不同**：GAP-5 是**源码缺陷**（`process.cwd()` 锚点），修完即彻底；GAP-6 是**数据 / 测试资产缺陷**，属另一层。**该缺口已在修复中**：`adapters/opencodereview/test/fixtures/preview.default.json` 原先内嵌仓库绝对路径 `E:\Desktop\ai-quality-gate\...`（t19 实测四处：**L347**（`rules.layer_trace[0].file`）、**L353**（`rules.layer_trace[1].file`）、**L373**（`rules.loaded_layers[0].file`）、**L609**（`source.path`））；**t20 复测：这四处行号仍指向同一批字段，但内容已替换为占位符** —— `"<ADAPTER_ROOT>/demo/rule.json"`、`"<ADAPTER_ROOT>/demo/.opencodereview/rule.json"`、`"<ADAPTER_ROOT>/demo/rule.json"`、`"<ADAPTER_ROOT>/demo/diff.json"`，夹具内已**不再含任何 `E:\` 绝对路径**（实测 `contains E:\Desktop\ai-quality-gate` = false、`contains <ADAPTER_ROOT>` = true） | **夹具可移植性缺口（数据资产）** | (a) **换盘符 / 换目录 / 换机器即失配**；(b) **任何非逐字相同的拼写即失配**（junction 别名、大小写差异、尾斜杠——判据是路径串的**逐字比较**，与它是否指向同一文件无关）。**与 GAP-5 的关系**：`layer_trace[1].file` **同时**是 GAP-5 的 cwd 敏感键与 GAP-6 的固化键 ⇒ 非仓库根 cwd 下三条 `fixtures.test.mjs` 回归必然失配（**正是 GAP-5 的后果**）；且**在仓库内用 junction 别名拼写也同样失败**。**判据（t16 实测）**：决定因素是**运行时的绝对路径拼写**，而非「是否位于仓库内」；**唯一全绿基线是仓库的规范路径** `E:\Desktop\ai-quality-gate`——实测规范路径 **57 通过 / 0 失败**、别名 `E:\ai-quality-gate` **54 通过 / 3 失败**、`E:\Desktop` **54 通过 / 3 失败**，三者失败项完全相同，且规范路径 vs 任一其他拼写的差异叶子键**恰为上述 4 个** | **修法**：重录夹具时改用**仓库相对占位符**，断言侧做占位符替换后再比对，**不得**继续内嵌绝对路径。**先例与实现现状（t20 复测更新）**：原先的先例是 `adapters/opencodereview/test/fixtures.test.mjs` L15-L31 的 `normalize()` / L33 的 `scrubText()`，其正则只匹配**含 `adapters/opencodereview` 段**的路径，而项目级规则路径 `…\.opencodereview\rule.json` 不含该段 ⇒ 不会被替换（这正是四个差异键中 `layer_trace[1]` 未被抹平的原因）。**现已重构**：新增 `adapters/opencodereview/test/portable.mjs`，定义 `ROOT_TOKENS = [["<ADAPTER_ROOT>", …], ["<REPO_ROOT>", …]]` 与 `portableize()` / `portableizeString()` / `portableizeText()` / `materializeString()`，并规定「替换顺序须最长/最具体优先（`<ADAPTER_ROOT>` → `<REPO_ROOT>` → `<HOME>`）」，`fixtures.test.mjs` 的 `normalize`/`scrubText` 改为委托它。**覆盖面因此扩大到仓库根级路径，正对应本节要求的修法方向** **状态（t20 复测更新）**：**修复进行中**。①**夹具侧已完成**——`preview.default.json` 的四处绝对路径已换成 `<ADAPTER_ROOT>` 占位符（行号 L347/L353/L373/L609 不变）；②**替换器已重构**为 `test/portable.mjs`（`<ADAPTER_ROOT>` / `<REPO_ROOT>` 双层占位，最长优先）；③**但跨 cwd 一致性尚未成立**：新增的回归 `GAP-5/GAP-6: 三种 cwd 下 layer_trace / loaded_layers / source.path 完全一致` 在**三个 cwd 下均失败**（t20 实测：规范路径 61 通过 / 4 失败、别名 57 通过 / 8 失败、`E:\Desktop` 57 通过 / 8 失败；套件已从 57 例扩到 **65** 例），说明**源码侧锚点（GAP-5）仍在起作用**。故：夹具侧记账可标记为已修，**跨 cwd / 换机的一致性在 GAP-5 修完并通过该回归之前不得声称成立**。与 GAP-5 必须同批验收。 |
| **GAP-7** | **引擎侧有 1 个随 `--config` 路径拼写变化的 evidence 叶子**：`build-deterministic` 门禁中 `no-bypass`（`type="policy"`，证据前缀 `CONTRACT_001`）的 `evidence[0].excerpt`，其 `scannedConfig` 记录**被扫描配置文件的绝对路径** | **输入回显差异（非 cwd 确定性缺口）** | **影响（比 t20 记述更轻）**：**对固定 `--config` 取值，RunResult 完全可复现且与 cwd 无关**；两个**解析到同一文件**的拼写会给出不同的 `scannedConfig` 字符串——junction 别名在任何平台上都如此，**大小写变体只在大小写不敏感的文件系统上**如此。这是**输入回显**而非非确定性。**平台相关性（t61 补正：原文把「junction 别名 / 大小写」无条件并称为「等价拼写」，该表述会让 Linux/CI 读者得到错误预期）**：在**区分大小写的**平台上，大小写拼错的 `--config` **不是等价拼写，而是直接加载失败** —— `exit 2` / `CONFIG_NOT_FOUND`（`packages/qgate/src/config.mjs` L587-L597：`path.resolve` 不做大小写归一化，`fs.readFileSync` 打不开即抛该错误）。**证据层级（如实标注，不得读作「Linux 实测」）**：本机**没有真实 Linux/Ubuntu 实测**（无 WSL：`wsl -l -v` ⇒ `E_ACCESSDENIED`；`fsutil file setCaseSensitiveInfo` ⇒ `Access denied`）；依据是 ①**代码路径推导**（同上的 `config.mjs` L587-L597）与 ②**受控严格大小写模拟**（在 Node FS 边界对 `readdirSync`/`statSync`/`readFileSync` 实施**逐分量**严格匹配，并以 `shimSelfTest` 自证其严格性；同一命令在该模拟下 `exit 2`、在原生 Windows 下 `exit 0`，两条独立依据结论一致）。跨 cwd 的字节级比对**不再需要**排除该叶子（前提是 `--config` 取值相同，**且该拼写在所运行的平台上能解析**）；只有当镜像/审计把**不同拼写**（且两者都能解析）视为同一输入时，才需先做占位符归一化。**完全不影响门禁判定**（5 gate / 18 check 的 `passed`、`overall_passed=true`、blockers 计数在全部实测组合下一致，该检查本身 `passed=true`）。 | **实测（t22，引擎 `check --config <p> --json`，2×2 矩阵 = cwd × 配置路径拼写）**：差异叶子路径 = **`/gates/2/checks/3/evidence/0/excerpt`**；`--config` 用规范拼写 ⇒ `"scannedConfig":"E:\\Desktop\\ai-quality-gate\\qgate.config.json"`，用 junction 别名拼写 ⇒ `"scannedConfig":"E:\\ai-quality-gate\\qgate.config.json"`。**成因（t22 实测结论，已更正 t20 的归因）**：该叶子**只随 `--config` 传入的路径字符串变化，与 cwd 无关** —— 同一个 `--config` 值从两个不同 cwd 运行、剔除运行时字段后**叶子差异 = 0**；同一个 cwd 下换 `--config` 的路径拼写则**差异 = 1**。t20 曾把它记为「cwd 敏感」，那是因为当时两次运行**恰好同时换了 cwd 与 `--config` 字符串**，归因错误，此处更正。**修法建议**：可在 `evidenceDir` 归一化时把绝对路径改写为项目根相对路径（与 GAP-5/GAP-6 同一占位符机制），或记为**「不修、仅记账」**——因为记录「解析到的配置文件绝对路径」对审计有真实价值。**取证前置条件（t44 追加：可执行步骤）**：**跨 cwd 做字节级比对前，必须先固定 `--config` 的取值**（建议两次运行使用**同一个绝对路径字符串**）；否则差异会来自**输入回显**而非 cwd。t44 实测（探针副本，`check --json`，剔除 4 个运行时字段后逐叶子比对 235–246 个叶子）：① **同一个绝对** `--config`、两个不同 cwd（仓库根 vs `demo/`）⇒ **差异叶子 0**（不剔除运行时字段时恰为 `run_id`/`started_at`/`finished_at`/`duration_ms` 这 4 个）；② 两个**相对**拼写但**解析到同一个配置文件**（`demo/qgate.config.json` 与在 `demo/` 下看到的 `qgate.config.json`）⇒ **差异叶子 0**；③ 同一个相对字符串、但 cwd 经 **junction 别名**（`…\_t44probe\repo` vs `…\_t44probe\alias`）⇒ **差异叶子 1**，即 `CONTRACT_001`（`no-bypass`）证据里 `scannedConfig` 的**绝对路径**（root 配置 = `/gates/2/checks/3/evidence/0/excerpt`，demo 配置 = `/gates/3/checks/3/evidence/0/excerpt`）。⇒ 判据是**解析后的绝对路径字符串**，不是 cwd 本身；把它固定成同一个 `--config` 取值，该差异即归零。（t40 复验报告为"相对 `--config` 时 9 个差异叶子"；t44 用上述三种组合实测为 0 / 0 / 1，**未能复现 9**——比对集合或归一化口径可能不同，已回报 captain 与 verifier 对齐；**本行以 t44 实测的 1 个叶子为准，"先固定 `--config` 拼写"这条指引不受影响**。） |
| **GAP-8** | **§5 字段表 / `schemas/**` 与 `packages/qgate/test/schema-contract.test.mjs` 冻结表的跨负责人一致性**：契约的可执行哨兵（冻结字段表 + `_canonical-config.json`）位于 **core-engineer 范围**，而契约本身由 **architect** 独占 | **流程/协作缺口（非代码缺陷）** | 契约变更会**使他人范围的测试转红**：architect 按纪律不得改 `packages/qgate/**`，于是**契约变更与引擎套件全绿无法由同一人在同一次改动内达成**；若只看红灯，**容易把「契约变更未同步」误判为「引擎回归」**。当前**无自动守卫**，只能靠 §5.1 的同步纪律（变更发起人负责发起同步）。 | **本次实例**：t17 在 `schemas/config.schema.json` 的 `$defs.humanGate` 增加可选 `gateId`（`properties` = `role, gateId, approvalRecord, enforcement`），而测试冻结表里 `config:humanGate` 仍为 `role, approvalRecord, enforcement` 旧值 ⇒ 引擎套件报 `config:humanGate: surplus [gateId]`；t22 全量 enumerate 后确认**漂移仅此一条**。**状态**：**已用文档纪律缓解**（§5.1 纪律第 1–3 条 + `schemas/README.md` 同名纪律）。**可选改进（未实现，待 captain 裁决）**：① 让该测试从一个机器可读的契约清单（而非硬编码数组）读取字段表，使双方共用单一来源；② 或加一条「契约变更后自动提示同步」的 CI 守卫。两者都属可选项，本任务不实现 |

**声明（GAP-1…GAP-8，按性质分为三类）**：以上八项偏差**不阻塞**原型交付（离线可跑、门禁判定不依赖跨侧字段名一致性），但均**不得被当作已解决**。两类性质不同，修法与验收判据也不同：

- **字段名类缺口（GAP-1…GAP-4）**：本质是**命名与语义映射**问题——适配层保留 OCR 原生命名与 1 基 `priority`，与契约的 camelCase + 0 基 `priority` 不逐字一致。**跨侧消费必须先读本节的映射表**；任何试图「让两侧键名逐字相同」的改动都属于契约变更，须走 captain 裁决流程（本轮裁决结论为：不改适配层命名，只在此处显式记账）。
- **确定性 / 可移植性类缺口（GAP-5、GAP-6）**：GAP-5 是**源码缺陷**（适配层规则层解析以 `process.cwd()` 为锚），GAP-6 是**数据 / 测试资产缺陷**（夹具把绝对路径固化为期望值）。两者同源（绝对路径）但分属源码与测试资产两层，故分开记账，且**必须同批修复**。
- **输入回显类（GAP-7）**：引擎证据 excerpt 的 `scannedConfig` 随 **`--config` 的路径拼写**变化（**与 cwd 无关**，t22 已更正 t20 的归因）。这不是非确定性——固定 `--config` 取值时可完全复现——而是「把输入里的绝对路径原样回显」；仅在把不同拼写当同一输入时才需归一化。
- **流程 / 协作类（GAP-8）**：§5 字段表与 `schemas/**`（architect 独占）同 `schema-contract.test.mjs` 冻结表（core-engineer 范围）**跨负责人**，契约变更会使他人范围的测试转红，且**无自动守卫**——已用 §5.1 的同步纪律缓解。二者**必须分开记账、同批修复**：只修源码侧，`layer_trace[].file` 在**换机 / 换目录 / 换盘符**时仍会失配，因为夹具里存的仍是绝对路径。**GAP-5 修完之后不得据此声称「跨 cwd 与换机都好了」**——GAP-6 未修则换机仍失败；反之亦然。在两者修复前，**不得声称「跨 cwd 确定性成立」**，且任何跨 cwd 的字节级比对都须排除 `layer_trace[].file` / `loaded_layers[].file`。

**GAP-4 的管道现状（如实记账，本轮不修代码）**：适配层 `adapters/opencodereview/src/rules.mjs` 的 `explainFile()`（L208-221 区域）**未把 `classification.severity` 传出**——其返回对象为 `{…, ruleId, pattern, decidedBy, layersLoaded}`，不含 severity；因此适配层 `ruleMatch[]` 中**看不到 severity**（实测 `ruleMatch[0]` 的键集确实无 `severity`），severity 只出现在 `excluded[].severity`。这是一条**已记账的能力缺口**，与 GAP-4 的「同名异义」结论互为补充：适配层并非没有 severity 概念，而是**把它放在另一处、且用的是另一套语义**。

**GAP-5 的状态**：**待修，已排期于独立验证复验（t24）之后**——避免在验证进行中改动本树而污染验证结论。t24 完成后由 `adapters/**` 的 owner（adapter-engineer）按上表「修复方向」执行，并同步重录 3 个 fixture；引擎侧同源写法（`cli.mjs` L204）一并评估。在此之前，**任何跨 cwd 的字节级比对结论都必须显式排除 `rules.layer_trace[].file` / `loaded_layers[].file`**，否则会误判为漂移。

**补充实测事实（与本节的 GAP-5 相关，供 verifier 对照，均为本机复现结果）**：

**现象 1 —— cwd 依赖（即本节的 GAP-5，已复现）**：适配层 `node adapters/opencodereview/tools/run-tests.mjs` 的结果随 `cwd` 变化：`cwd=仓库的规范路径（`E:\Desktop\ai-quality-gate`）` ⇒ **`tests 57 / pass 57 / fail 0`**（全绿）；`cwd=非仓库根（如 `E:\Desktop`）` ⇒ 57 项中 **54 通过 / 3 失败**，失败项全部是 `test/fixtures.test.mjs` 的三条真实产物回归。用**同一命令、两个 cwd、逐叶子比对 JSON** 可直接定位到差异键：`$.rules.layer_trace[1].file`（未显式给出 `--root` 时锚在 `process.cwd()`，正是 GAP-5 的后果）。**注意**：只有「仓库的规范路径」是全绿基线；把仓库的**另一种拼写**（junction 别名 `E:\ai-quality-gate`）当作 cwd 也会落到失败态（原因见现象 2），故文档不以「是否位于仓库内」作为判据，而以**运行时的绝对路径拼写**为判据。

**现象 2 —— 夹具固化了绝对路径（夹具可移植性缺口，独立于 cwd）**：`adapters/opencodereview/test/fixtures/preview.default.json` 内嵌**仓库绝对路径** `E:\Desktop\ai-quality-gate\...`，实测四处：**L347**（`rules.layer_trace[0].file`）、**L353**（`rules.layer_trace[1].file`）、**L373**（`rules.loaded_layers[0].file`）、**L609**（`source.path`）。该缺口的含义是：夹具把**当次运行的仓库绝对路径**存档为期望值，于是（a）只要运行时的锚点与存档时的路径拼写不一致就会失配，（b）仓库**换盘符 / 换目录 / 换机器**时同样会失配。**不要**把成因归给 junction：`E:\ai-quality-gate\adapters` 与 `E:\Desktop\ai-quality-gate\adapters` 实测**均可正常访问**，junction 有效。

**两个现象的接合点（如实说明）**：`layer_trace[1].file` 既是**现象 1 的 cwd 敏感键**，又是**现象 2 存档进夹具的四个键之一**——所以从非仓库根 cwd 运行时，三项 `fixtures.test.mjs` 回归会因该键失配而失败（54 通过 / 3 失败），这**正是 GAP-5 的后果**；而即便在仓库内，若用 junction 的另一种拼写（`E:\ai-quality-gate`）作为 cwd，实测同样落到 54 通过 / 3 失败，因为存档的期望值是 `E:\Desktop\ai-quality-gate` 这一拼写。因此：**cwd 依赖是"锚点漂移"，夹具可移植性是"期望值固化"，两者同因于绝对路径，但不是同一个缺口。**

**为何本节此前的数字被替换**：该段先前称「两个 cwd 均为 54 通过 / 3 失败、与 cwd 无关」。复跑显示：以仓库的**规范路径**为 cwd 时是全绿（57 通过 / 0 失败），上述归纳因此被证伪。据此本节改为分列两个现象，并只保留可复现结论；判据是**运行时的绝对路径拼写**，而非「是否位于仓库内」。

**输出路径政策（补记，依据 §8.2）**：引擎的 `policy.evidenceDir` / `policy.reportDir` / `traceFile` **允许在开发与调试时改道到 scratch 目录**（例如仓库内的 `.qgate/out/**`）做本地试验；**但发布与 CI 必须落在 `verification/**`**——因为 §8.2 的 CI 需要把 `verification/evidence/` 作为 build artifact 上传以保留审计链，改道出该目录会使 artifact 上传与 §8.2 的失败判据落空、审计链断链。契约默认值（`verification/evidence`、`verification/reports`、`verification/trace-matrix.json`）不因调试改道而改变。

**`verification/**` 硬规则**：**任何成员不得删除或清空 `verification/**`**；引擎的正常输出写入该目录**不算污染**——它是审计链的一部分；**删除权限仅属于 captain**；删除任何他人独占的目录之前**必须先读取目录清单**，不得盲删。**事故教训**：2026-09-17 **02:32:06** 一次**未先读取清单**的 `Remove-Item verification -Recurse -Force` 导致 verifier 的 t9 取证全部丢失——`report.json`（**34799 B**）、**9** 个 `tools/`、**36** 个 `artifacts/`，以及 `negative/` 夹具。结构性成因是当时**两类内容共用该目录**；修法是按归属分目录（§7）：引擎审计链留在 `verification/**` 且路径冻结，verifier 私有产物迁至 `verification-t9/**`——**但分目录并不解除本硬规则**。

**协作纪律（t44 追加，全队适用）：一致性声称必须成对给出 sha256**

任何「改动前后一致 / 未变 / 未触碰 / 与 tXX 一致」的**声称**，必须**同时给出改动前的 sha256（或可区分的前缀）与改动后的 sha256**；只给"当前值"，或只给"逐行 diff = IDENTICAL"这类**无法对照的聚合结论**，验证者**没有可复核的锚点，只能标 `blocked`**。

1. **最小可复核集**：① 对象（文件路径，或一条命令 + cwd）；② **成对**取值（改前 / 改后，或 声称前 / 声称后）；③ 取值形式 = `sha256`（或其可区分前缀，≥8 位）＋ 字节数或行数（便于发现截断与换行差异）。
2. **对「未触碰」的声称同样适用**：要写"该文件在 tNN 开始前 = `<前缀 X>`，本次结束时 = `<前缀 X>`（两次实测一致）"，而不是只写"没动过"。
3. **理由**：本仓库**没有 VCS**（顶层无 `.git`，实测 `Test-Path .git` = False），因此**哈希（或"行号 + 原文"）是唯一可复核的对照手段**；但哈希**只有成对给出**才具有对照意义——单个当前值无法证明"改前等于改后"，聚合结论（如"12 个文件逐行相同"）也无法被独立复算。
4. **触发本案的实例**：t40 复验把一次"12 个配置逐行 diff = IDENTICAL"的一致性声称记为 **F5（medium）`blocked`**——不是因为结论可疑，而是因为**声称方未给出任何改动前的基线值**，验证者无从复核。这条纪律要求的是**证据形式**，不是更多工作量：改前先 `Get-FileHash`（或 Node `crypto`）一次即可。

> 与 GAP-8 的关系：GAP-8 管的是"契约变更要**同步**到他人范围的哨兵"；本条管的是"**任何**一致性声称都要能被独立复核"。二者同属协作纪律，且都源于同一个结构性事实——**没有 VCS 的仓库里，哈希是唯一的对照物**。

### 6.3 退出码（冻结）

| 退出码 | 含义 | 触发条件 |
|---|---|---|
| `0` | 通过 | 命令成功且无门禁失败（`overall_passed=true` 或非 check 类命令成功） |
| `1` | 门禁失败 | 至少一个必需门禁 `passed=false`（`overall_passed=false`） |
| `2` | 配置错误 | 配置文件缺失/不可解析/违反 §5.1 校验、CLI 参数非法、`humanGate` 位置非法 |
| `3` | 内部错误 | 未捕获异常、`provider` 失败（`PROVIDER_FAILED`）、证据断链（`EVIDENCE_UNRESOLVED`）、schema 自检不一致（`CONTRACT_DRIFT`） |

### 6.4 命令退出码矩阵

| 命令 | 正常 | 门禁失败 | 配置错误 | 内部错误 |
|---|---|---|---|---|
| `contract` | 0 | n/a | 2 | 3（`--check` 不一致时为 `CONTRACT_DRIFT`） |
| `check` | 0 | 1 | 2 | 3 |
| `trace` | 0（即使存在 `covered=false`） | n/a | 2 | 3 |
| `preview` | 0（OCR 缺失时 `degraded:true` 仍为 0） | n/a | 2 | 3 |
| `report` | 0 | 0（报告含失败判定不改变退出码） | 2 | 3 |
| `explain` | 0 | 0（解释失败项本身不算失败） | 2 | 3 |

### 6.5 结构化错误对象（stdout，`--json` 时）

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_INVALID",
    "message": "check.type \"file_exist\" is not allowed",
    "jsonPointer": "/gates/0/checks/0/type",
    "details": [ { "jsonPointer": "/gates/0/checks/0/type", "expected": "file_exists|file_not_exists|regex|command|json_assert|trace_matrix|policy", "actual": "file_exist" } ]
  }
}
```

`error.code` 枚举：`CONFIG_INVALID`、`CONFIG_NOT_FOUND`、`PROVIDER_FAILED`、`INTERNAL_ERROR`、`EVIDENCE_UNRESOLVED`、`CONTRACT_DRIFT`、`IO_ERROR`。

### 6.6 `ok` 取值矩阵

| 命令 | `ok` |
|---|---|
| `contract` | `true` |
| `check` | `= overall_passed` |
| `trace` | `true` |
| `preview` | `true` |
| `report` | `true` |
| `explain` | `= subject.passed` |

### 6.6 `ok` 取值矩阵（t44：按**三个输出面**写清；`--summary` 的文本面与包络面**不是同一个面**）

**先把"面"数清楚**——此前把 `--summary` 当成**一个**面，是 captain 与 verifier 各误判一次的直接原因（两人都只跑 `--summary` 看 stdout，便判定"契约要求的结构化字段缺失"，而该字段其实在 `--out` 包络里）。三个面：

| 输出面 | 触发方式 | 内容 |
|---|---|---|
| **JSON 面** | `--json` | 各命令的机器可读**文档**（`check` = §5.2 RunResult；`trace` = §5.3.3 冻结文档；`preview` = §6.2.1 对象；`contract` = 自描述；`report` / `explain` = 各自结果） |
| **摘要文本面** | `--summary`（不给 `--out`） | **人类可读**表格 / 纯文本，**不是 JSON** |
| **摘要包络面** | `--summary --out <file>` | 落盘的 **JSON 包络**（`--summary` 时 `--out` 写的是包络，**不是**上面的 JSON 面） |

**`ok` 逐面实测（t44；`--summary --out` 的包络键集合为实测值）**：

| 命令 | `--json`（JSON 面） | `--summary`（stdout 文本面） | `--summary --out`（包络面） | `ok` 取值 |
|---|---|---|---|---|
| `contract` | 有 `ok` | 无（文本非 JSON） | 有 `ok` | `true` |
| `check` | **无**（§5.2 RunResult 的 8 个键） | 无 | **无**（包络键 = `overall_passed` / `gates` / `not_run_gates` / `run_id` / `provider` / `approvals_missing`） | **不适用——读 `overall_passed`** |
| `trace` | **无**（§5.3.3 的冻结 trace 文档没有 `ok`） | 无 | 有 `ok` | `true` |
| `preview` | 有 `ok` | 无 | 有 `ok` | `true` |
| `report` | 有 `ok` | 无 | 有 `ok` | `true` |
| `explain` | 有 `ok` | 无 | 有 `ok` | `= subject.passed` |
| 任一命令失败（§6.5 错误文档，退出 2/3） | 有 `ok:false` | — | — | `false` |

⇒ **判定 `check` 是否通过必须读 `overall_passed`；`check` 在三个成功输出面上都不产出 `ok`**（实测：`--json` 顶层 8 键、`--summary` 为文本、`--summary --out` 包络 6 键，均无 `ok`）。

> **引擎自描述已同步（t41 修正、t44 复核，取代 t37 曾记的"仍写旧值"）**：`contract --json` 的 `commandOkSemantics` 现为**逐面描述**，与上表一致，例如 `check` = "absent from every success surface (--json RunResult, --summary text and --summary --out envelope); the verdict is overall_passed"、`trace` = "absent from --json … present in --summary --out only"、`contract` = "present in --json and in --summary --out … absent from the --summary text"。`contract --check` 实测 **exit 0**（说明冻结记录 `packages/qgate/gates/contract.json` 与自描述逐字同步）。**t37 的过期待办注记到此关闭。**

---

## 7. (g) 模块与文件布局

```
E:\ai-quality-gate\                     ← 项目根（所有配置中的相对路径以此为锚）
├── README.md                            ← 集成 owner: core-engineer（t7）
├── package.json                         ← 根工作区脚本（workspaces: packages/*, adapters/*）
├── docs/
│   ├── 00-requirements.md               ← owner: architect（本任务）
│   ├── 01-architecture.md               ← owner: architect（本任务）
│   ├── 02-playbook.md                   ← owner: docs-engineer
│   └── requirements-index.json          ← owner: architect（需求 ID 机器可读清单）
├── schemas/
│   ├── config.schema.json               ← owner: architect
│   ├── run-result.schema.json           ← owner: architect
│   ├── evidence-ledger.schema.json      ← owner: architect
│   └── trace-matrix.schema.json         ← owner: architect
├── packages/qgate/                      ← owner: core-engineer（不得被其他成员修改）
│   ├── package.json                     ← 零运行时依赖；bin.qgate → ./bin/qgate.mjs
│   ├── bin/qgate.mjs                    ← 命令分发、参数解析、退出码映射
│   ├── src/
│   │   ├── config.mjs                   ← 加载 + 校验配置（错误含 jsonPointer）
│   │   ├── pipeline.mjs                 ← 五阶段顺序调度、required 语义
│   │   ├── checks/                      ← 七类 check 各一文件（file_exists…policy）
│   │   ├── providers/                   ← deterministic / scripted / llm / external + 降级
│   │   ├── evidence.mjs                 ← evidence 引用构造与解析
│   │   ├── ledger.mjs                   ← 账本追加写 + 哈希 + index 原子更新
│   │   ├── trace.mjs                    ← trace-matrix 生成与一致性规则
│   │   ├── report.mjs                   ← Markdown 报告渲染
│   │   └── util/                        ← glob、sha256、JSON Pointer、原子写
│   ├── gates/                           ← 可复用门禁配置片段（stage-order.json 等）
│   ├── examples/
│   │   ├── valid/five-stage.json        ← 合法五阶段完整配置
│   │   └── invalid/*.json               ← 6 个非法配置（反向用例）
│   └── test/*.test.mjs                  ← node:test 用例（T-QG-001…016）
├── adapters/opencodereview/             ← owner: adapter-engineer
│   ├── src/selection.mjs                ← 纯确定性文件选择（preview 与执行同源）
│   ├── src/filters.mjs                  ← 二进制/密钥路径/默认排除/扩展名
│   ├── src/grouping.mjs                 ← FileGroup，maxFilesPerGroup=10，降级单文件组
│   ├── src/rules.mjs                    ← rule.json 优先级与第一条匹配
│   ├── src/reflection.mjs               ← 建议复核（离线规则化复刻）
│   └── bin/ocr-preview.mjs              ← 适配层唯一 CLI（--root/--diff/--rule/--include/--token-budget/--max-files/--json）；ocr 缺失时 degraded:true；无 select 子命令
├── demo/                                ← owner: core-engineer（五阶段示例仓库 + 可注入缺陷）
│   └── qgate.config.json
├── verification/                        ← 引擎审计链专属（引擎写出物 + verifier 只读引用；见下方硬规则）
│   ├── evidence/{ledger-*.json, ledger-index.json}   ← 引擎写出（默认 evidenceDir）
│   ├── approvals/{req-to-design,design-to-build,review-to-verify}/approval.json
│   ├── reports/*.md                     ← 引擎写出（默认 reportDir）：review-findings.json / final-report.md
│   └── trace-matrix.json                ← 引擎写出（默认 traceFile）
├── verification-t9/                     ← owner: verifier（t9 私有取证区：工具、原始产物、反向用例与报告）
│   ├── tools/*.mjs                      ← verifier 自用工具（leaf-diff、schema-eval、tree-fingerprint…）
│   ├── artifacts/**                     ← 复跑原始产物（runresult-*.json、*-suite.txt…）
│   ├── negative/*.json                  ← verifier 的反向用例与实测结果
│   ├── report.json                      ← 验证结论（机器可读）
│   └── review.md                        ← 验证结论（人类可读）
└── .github/workflows/quality-gate.yml   ← owner: adapter-engineer
```

| 目录 | 职责 | owner |
|---|---|---|
| `docs/` | 需求、架构契约、落地手册 | architect（00/01/index）、docs-engineer（02） |
| `schemas/` | 四份 JSON Schema，与 §5 字段表一一对应 | architect |
| `packages/qgate/` | 门禁引擎与 CLI | core-engineer |
| `adapters/opencodereview/` | OCR 确定性复刻与降级 | adapter-engineer |
| `demo/` | 五阶段可运行示例仓库 | core-engineer |
| `verification/` | **引擎审计链专属**（契约冻结路径）：`evidence/**`、`reports/**`、`trace-matrix.json`、`approvals/**`。由**引擎写出**，verifier 与其他成员**只读引用**；CI 会把它作为 artifact 上传 | core-engineer（写出）/ captain（唯一可删除） |
| `verification-t9/` | **verifier 私有取证区**（独立验证工具、原始产物、反向用例、结论报告）；与引擎审计链分开，避免两类内容共用目录 | verifier |
| `.github/workflows/` | CI 模板 | adapter-engineer |
| 根 `README.md` / `package.json` | 一键入口与工作区声明 | core-engineer（t7 集成） |

**跨目录规则**：`adapters/**` 只能通过 `bin/qgate.mjs` 的 CLI 契约调用引擎，不得 import `packages/qgate/src/**`；`schemas/**` 由 architect 独占，任何成员不得改（契约由 architect 独占）。

**`verification/**` 硬规则（新增，源自一次真实损失事故）**：

1. **任何成员不得删除或清空 `verification/**`**——**删除权限只属于 captain**。引擎的输出**可以写入**该目录（`evidenceDir` / `reportDir` / `traceFile` 的默认落点），但「可写」不等于「可删」。
2. **每次运行前先读取目录清单**，不得盲删。本次事故的直接触发链：有人执行 `Remove-Item verification -Recurse -Force`（**未先读取目录清单**），随后按默认路径把引擎证据写回 `verification/**`，导致 verifier 放在该目录下的私有产物（`verification/tools/**`、`verification/artifacts/**`、`verification/negative/**`、`verification/report.json`）**全部丢失**。
3. **结构性成因与修法**：事故根因是**两类内容共用同一目录**——引擎按 §8.2 必须把证据写入 `verification/**`（CI 还要上传为 artifact），而 verifier 当时把自己的私有产物也放在 `verification/**`。修法是**按归属分目录**：引擎审计链留在 `verification/**`（路径**不得更改**，CI 与契约依赖它），verifier 的私有产物迁至 `verification-t9/**`。
4. 一句话教训：**删除他人独占的目录前，必须先读取目录清单并确认其中没有他人产物**；跨 owner 的删除一律先走 captain。

---

## 8. (h) 落地路线图与能力边界

### 8.1 套用到真实仓库（4 步）

1. **复制引擎**：把 `packages/qgate/` 与 `qgate.config.json` 复制到目标仓库（或作为 devDependency 引入）；确认 Node ≥ 18、无需 `npm install`（零依赖）。
2. **改写门禁**：按 §5.1 字段表把目标仓库的真实交付物写成 `gates[*].checks[*]`；先只启用 `build` + `verify` 两个阶段跑通，再补 `requirements`/`design`/`review` 与人类门禁。
3. **接入人类门禁**：在 3 个交接点创建 `verification/approvals/<gateId>/approval.json`（§9.1 格式），由对应角色签署后门禁方可放行。
4. **接入 CI**：使用 `.github/workflows/quality-gate.yml`；每个 job 调一个阶段命令；把 `verification/evidence/` 作为 build artifact 上传以保留审计链（离线环境无需任何 secret）。

### 8.2 CI 映射

| workflow job | 命令 | 失败判据 |
|---|---|---|
| `requirements` | `node packages/qgate/bin/qgate.mjs check --stage requirements --config qgate.config.json --json` | 退出码 1 |
| `design` | `--stage design` | 退出码 1 |
| `build` | `--stage build` | 退出码 1 |
| `review` | `--stage review` | 退出码 1 |
| `verify` | `check --config demo/qgate.config.json --json` 完整流水线 | 退出码 1 |

所有 job 均不得引用 `secrets.*`；人类门禁以 approval 制品存在性 + 角色匹配判定（REQ-015）。

**信任边界（t35 记账，与 §5.3.2「能力边界（信任模型）」同源）**

上表的判据与"放行"全部建立在**仓库内制品**上：`verification/evidence/**` 的账本与索引、`verification/approvals/**` 的审批记录。它们都属**自证**——写这些路径的一方与校验者**同一信任域**，因此：

- 账本链可以被**整体重铸**而仍然自洽（t29 实测绕过，见 §5.3.2）；
- 审批记录是**自报 JSON**：`approvedBy` / `approvedAt` 无签名、无身份认证，**"门禁要求某角色签字"只能证明该路径下存在一份形态合法的签字记录，不能证明该角色真的签了**。

本表里的两件事**都不改变**这一点：① artifact 上传（`actions/upload-artifact`）只是**留存**，不是外部锚定；② verify job 里"检查审批记录存在性 + 角色匹配"的步骤恒 `exit 0`，是**报告**不是门禁。可选的外部锚点方向（CI 产出清单 / 提交签名 / 哈希登记）见 §5.3.2，**本轮未实现**。

**产出路径规则（调试可改道，发布与 CI 必须落 `verification/**`）**：

1. **默认值**：`policy.evidenceDir` = `verification/evidence`、`policy.reportDir` = `verification/reports`、`traceMatrix` 的 `traceFile` = `verification/trace-matrix.json`（§5.1 字段表与 §9.1 审批路径同源）。§8.2 各 job 与 CI artifact 上传都以**这些默认路径**为准。
2. **开发/调试可改道**：允许把 `evidenceDir` / `reportDir` / `traceFile` 指向 scratch 目录（例如仓库内的 `.qgate/out/**`）做本地试验，避免污染审计链。**但发布与 CI 必须落回 `verification/**`**——否则 CI 的 artifact 上传与 §8.2 的失败判据会落空，审计链断链。
3. **本项目的当前选用 vs 契约默认**（如实记录）：仓库根 `qgate.config.json` 目前**采用默认路径**（`evidenceDir="verification/evidence"`、`reportDir="verification/reports"`、`traceFile="verification/trace-matrix.json"`）；`demo/qgate.config.json` 则**改道到 `.qgate/**`**（`evidenceDir=".qgate/evidence"`、`reportDir=".qgate/reports"`、`traceFile=".qgate/trace-matrix.json"`），属于上一条允许的**开发/调试改道**，因为 demo 是可独立运行的示例仓库、其产物不应混入本仓库的审计链。仓库内还存在 `.qgate/out/**`（引擎调试输出）。**这两种用法都不与「发布与 CI 必须落 `verification/**`」矛盾**：契约默认值不变，改道只是显式配置选择，且必须在发布/CI 场景下被覆盖回默认值。
4. 遵守 §7 的硬规则：**任何成员不得删除或清空 `verification/**`**（删除权限只属 captain），运行前先读目录清单。

### 8.3 本原型的能力边界（明确声明）

| 项 | 状态 |
|---|---|
| 确定性 provider 由**离线 fixture**驱动 | **是**：`provider.type="deterministic"` 默认值，无网络、无密钥、无模型调用，同一输入必得同一输出（REQ-014） |
| 真实 LLM provider | **非必需**：`type="llm"` 仅为接口占位；不可用时降级为 deterministic 并置 `provider.degraded=true`，**不影响门禁判定与退出码**（除仍可能为 1） |
| 网络访问 | **禁止（仅限其声明边界内）**：`SAFE_003` 断言「**被扫描面内**不存在网络调用面」；**边界外不属保证范围**（三类被排除的扫描面、注释、匹配器词汇之外的写法）——完整边界见 **§8.3.2** |
| API Key | **不需要（仅限其声明边界内）**：`SAFE_001` 断言「**被扫描面内**不存在密钥读取」；**边界外不属保证范围**（同上，另含硬链接身份链的覆盖范围与两侧不对称）——完整边界见 **§8.3.2** |
| `ocr` CLI | **可选**：缺失时适配层降级为本地实现并置 `degraded=true`，退出码仍为 0 |
| 未覆盖能力 | 模型语义级代码审查质量、跨仓大规模性能、UI/Dashboard、多 CI 平台、自动豁免机制（见 `docs/00-requirements.md` §5 非目标） |
| 适配层与契约的**字段名对齐** | **不做（已知缺口，显式记账）**：适配层保留 OCR 原生命名（含同产物内 snake_case/camelCase 混用）与 1 基 `priority`，与契约的 camelCase + 0 基 `priority` **不逐字一致**；权威映射与四项缺口见 **§6.2.2 / §6.2.3（GAP-1…GAP-4）**。跨侧消费必须先读映射表；偏差不阻塞原型交付，但不得被当作「已对齐」 |
| **跨 cwd 确定性** | **不完全成立（已知缺口，显式记账 → GAP-5 / GAP-6）**：适配层在未显式给出 `--root` 时以 `process.cwd()` 为锚解析规则层路径，`rules.layer_trace[].file` 随 cwd 变化（实测同一命令跨 cwd 仅此 1 个叶子键不同）；**引擎侧对固定的 `--config` 取值与 cwd 无关**（t22 更正：GAP-7 曾被记为 cwd 敏感，实为 `--config` 路径拼写差异）。**REQ-010 的「同输入同输出」不覆盖跨 cwd 意义**，不得据此声称跨 cwd 确定性成立。**已更正（t22）**：引擎 `check --json` 的门禁判定在全部实测 cwd × `--config` 组合下**完全一致**；唯一变化的 `/gates/2/checks/3/evidence/0/excerpt` **只随 `--config` 路径拼写变化、与 cwd 无关**，故它不属本行的 cwd 确定性缺口，另记 **GAP-7（输入回显类）**。状态：**待修，排期在 t24 复验之后**；在此之前跨 cwd 的字节级比对须排除 `layer_trace[].file` / `loaded_layers[].file`（引擎侧无需排除该 evidence 叶子，前提是 `--config` 取值相同）。详见 §6.2.3 GAP-5 / GAP-6 / GAP-7 |
| **证据 excerpt 的 `--config` 路径回显（引擎侧）** | **已知、可接受（显式记账 → GAP-7）**：引擎 `check --json` 的 `/gates/2/checks/3/evidence/0/excerpt`（`build-deterministic` 的 `no-bypass`，前缀 `CONTRACT_001`）把**被扫描配置文件的绝对路径**原样记入 `scannedConfig`，因此**随 `--config` 的路径拼写**变化（规范拼写 ⇒ `E:\\Desktop\\ai-quality-gate\\qgate.config.json`；junction 别名 ⇒ `E:\\ai-quality-gate\\qgate.config.json`）。**这不影响 cwd 确定性**：固定 `--config` 取值时从任意 cwd 运行，剔除运行时字段后**叶子差异 = 0**（t22 实测）。**不影响门禁判定**。跨 cwd 字节比对**无需**排除该叶子；仅在把不同**拼写**视为同一输入时才需先占位符归一化（**大小写变体只在大小写不敏感的文件系统上才属「另一种拼写」**；在区分大小写的平台上，大小写拼错的 `--config` 是 `exit 2` / `CONFIG_NOT_FOUND`，详见 §6.2.3 GAP-7 的 t61 补正）。修法：可随 GAP-5/GAP-6 的占位符机制一并归一化，或记为**不修、仅记账**（绝对路径对审计有价值）。详见 §6.2.3 GAP-7 |
| **契约↔schema↔测试冻结表的跨负责人一致性** | **已用文档纪律缓解（显式记账 → GAP-8）**：契约的可执行哨兵 `packages/qgate/test/schema-contract.test.mjs`（冻结字段表 + `_canonical-config.json`）在 **core-engineer 范围**，而 §5 字段表与 `schemas/**` 由 **architect** 独占 ⇒ 契约变更会使他人范围的套件转红，且**无自动守卫**。现行缓解：§5.1 的**契约变更同步纪律**（变更发起人必须请 core-engineer 当次同步并复跑到全绿，并给出确切一行修改）。**实例**：t17 给 `humanGate` 加可选 `gateId` ⇒ 测试报 `config:humanGate: surplus [gateId]`（t22 确认漂移仅此一条）。可选改进（未实现）：让测试从机器可读契约清单读取，或加 CI 同步守卫。详见 §6.2.3 GAP-8 |
| **夹具可移植性（内嵌绝对路径）** | **已知缺口（显式记账 → GAP-6）**：`adapters/opencodereview/test/fixtures/preview.default.json` 把仓库**绝对路径**固化为期望值（实测四处：L347 / L353 / L373 / L609），因此（a）**换盘符 / 换目录 / 换机器即失配**，（b）**任何非逐字相同的拼写即失配**（junction 别名、大小写、尾斜杠——同上，判据是**逐字比较**而非「能否解析到同一文件」）。**唯一全绿基线是仓库的规范路径** `E:\Desktop\ai-quality-gate`（实测 57 通过 / 0 失败；别名与 `E:\Desktop` 均为 54 通过 / 3 失败，失败项相同）。**与 GAP-5 分开记账但同批修复**：只修 GAP-5（源码 cwd 锚点）不够，夹具仍存绝对路径。修法：重录夹具时改用**仓库相对占位符**（`test/fixtures.test.mjs` L15-L31 的 `normalize()` / L33 的 `scrubText()` 已是现成先例，且需扩大其正则覆盖面以纳入项目级规则路径）。状态：**待修，已排期于 t18 完成之后**（修复范围见 t15）。详见 §6.2.3 GAP-6 |
| **证据链：抗篡改 vs 抗整链伪造** | **抗篡改 = 是；抗整链伪造 = 否（同域限制，显式记账，见 §5.3.2「能力边界（信任模型）」）**：`ledgers[].sha256` 复算 + `runIds`↔`ledgers` 同集合 + 拒绝未登记账本 ⇒ 能发现**意外 / 陈旧 / 局部篡改**（t29 实测三种各 exit 3 + `EVIDENCE_UNRESOLVED`）；**不能**发现"整条链被一致重铸"——校验依据（`sha256`、`ledger-index.json`）与被校验对象**同域**。保证强度是**完整性一致性**，**不是**抗恶意伪造。可选外部锚点（CI 产出清单 / 提交签名 / 哈希登记）**均未采用**，方向记录在 §5.3.2 |
| **审计边界：`covered=true` 的含义** | **不等于「根侧覆盖已闭环」**：`covered` 取「账本中出现的 testId」，而账本 id 由**引擎内置 `checkTestIds` 映射**产生 ⇒ 索引与账本**同源**，其一致属**夹具自洽**而非独立覆盖 ⇒ **不得据此宣称「根侧覆盖已闭环」**。完整论证见 **§8.3.1 GAP-9.b**（本节不重复）；另见 §8.3.2 末尾的同一条交叉引用 |

### 8.3.1 GAP-9 —— 文档点名的验证资产缺失（逐条判定，t27）

**t37 状态更新（2026-09-18）**：本节的 **REQ-007**（`T-QG-007`）与 **REQ-015 的 `T-QG-015` 一半**已**闭合**——两条需求现都有真实测试（`packages/qgate/test/evidence-resolution.test.mjs`、`packages/qgate/test/ci-template.test.mjs`，t30 交付、t37 独立复核为非空转），`docs/requirements-index.json` 的 `covered` 已随之由 `false` 翻为 `true`。原「尚未实现 / 延后」判定按**历史**保留在下面各行，闭合注记逐行附在末尾。仍然延后的只剩 **2 个 `verification/**` 制品**（REQ-009 的 `end-to-end.json`、REQ-015 的 `ci-parity.json`，由 t24 复验产出）。

| 文档点名但缺失的资产 | 判定 | 实测证据 / 等价路径 |
|---|---|---|
| `packages/qgate/test/checks.test.mjs`（REQ-003） | **已实现，路径写错** | 等价覆盖已并入 `packages/qgate/test/pipeline-and-checks.test.mjs`（含「all seven check types are registered」与七类各自的通过/失败用例） |
| `packages/qgate/test/run-result-shape.test.mjs`（REQ-004） | **已实现，路径写错** | 等价覆盖在 `config-and-run-result.test.mjs`（「RunResult key sets match the frozen schema exactly」）与 `robustness.test.mjs`（每个 `--stage` 结果都对 schema 校验） |
| `packages/qgate/gates/stage-order.json`（REQ-001） | **已实现，路径写错** | 五阶段顺序与人类门禁由 `packages/qgate/gates/contract.json` 提供（`stages` / `humanGates`），且 `qgate contract --check` 自检 |
| `adapters/opencodereview/bin/ocr-adapter.mjs`（REQ-012） | **已实现，路径写错** | 适配层 CLI 实际为 `adapters/opencodereview/bin/ocr-preview.mjs` |
| `packages/qgate/test/determinism.test.mjs`（REQ-005） | **已实现，路径写错** | 等价覆盖在 `pipeline-and-checks.test.mjs`（「two identical runs differ only in the runtime fields」「the demo run is identical from two different working directories」）与 `robustness.test.mjs`（ledger `durationMs` 不进入确定性面） |
| `packages/qgate/test/trace-matrix.test.mjs`（REQ-006） | **已实现，路径写错** | 等价覆盖在 `pipeline-and-checks.test.mjs`（`TRACE_GAP` 用例）与 `schema-contract.test.mjs`（trace-matrix schema 契约） |
| `packages/qgate/test/human-gate.test.mjs`（REQ-008） | **已实现，路径写错** | 等价覆盖在 `acceptance.test.mjs`（`HUMAN_GATE_NOT_APPROVED`、`rejected` 与 `missing` 区分） |
| `packages/qgate/test/human-gate-required.test.mjs`（REQ-016） | **已实现，路径写错** | 等价覆盖在 `acceptance.test.mjs`（「a required:false gate does not change overall_passed but reports approvalState」） |
| `packages/qgate/test/zero-dep.test.mjs`（REQ-010） | **已实现，路径写错** | 等价覆盖在 `acceptance.test.mjs`、`pipeline-and-checks.test.mjs`（「declares no runtime dependency and stays pure ESM」「no implementation file performs a network call」）与 `robustness.test.mjs` |
| `packages/qgate/test/cli.test.mjs`（REQ-011） | **已实现，路径写错** | 等价覆盖在 `acceptance.test.mjs`（退出码 2 / 3 的 CLI 用例、相对 `--config` 的 cwd 语义） |
| `packages/qgate/test/severity.test.mjs`（REQ-013） | **已实现，路径写错** | 等价覆盖在 `acceptance.test.mjs`（「only high-severity findings above the confidence threshold become blockers」）+ `packages/qgate/examples/severity-mix.json` 真实运行输出 |
| `packages/qgate/test/provider.test.mjs`（REQ-014） | **已实现，路径写错** | 等价覆盖在 `acceptance.test.mjs`（scripted provider 重放 fixture、llm/external 降级、`PROVIDER_FAILED`）与 `schema-contract.test.mjs`（provider 枚举） |
| `packages/qgate/test/evidence-resolution.test.mjs`（REQ-007） | **原判定（t27）：未实现（延后）→ t37 更新：已闭合** | **历史**：文件不存在，且无等价覆盖（`T-QG-007` 未被任何测试文件引用）。**t37 复核（实测，非采信自述）**：该文件已由 t30 交付（**12563 B**，sha256 `d07be40e81114e7bae06f6d7defa68d08d3883e10435fb5aa8bfc68886488d5e`），含 **7** 个 `test('T-QG-007 …')` 用例，直接调用 `src/evidence.mjs` 的 `resolveEvidence` / `auditEvidence`、`src/core.mjs` 的 `runPipeline` 与 CLI `explain`（L17-L19 的 import；用例起点 L57 / L75 / L103 / L148 / L174 / L197 / L221），其中 **L221-L236 是注入式反例** ⇒ **非空转**。REQ-007 的「验证方式」已据此由「尚未实现 / 延后」改为**已实现** |
| `verification/negative/*`（REQ-010 等的反向用例） | **已实现，路径写错** | `verification/negative/` 现不存在；反向用例实际位于 **`verification-t9/negative/`**（`A-control`、`A-missing-evidence`、`B1-missing-version`、`B2-bad-check-type`）——与 §7 的目录归属重构一致 |
| `verification/end-to-end.json`（REQ-009） | **延后（由 t24 复验产出）** | 契约与 CI 依赖的审计链制品，**归 verifier / captain**；已排期由 **t24 独立复验**产出。architect 不得创建（§7 硬规则） |
| `verification/ci-parity.json`（REQ-015） | **制品仍延后（t24 产出）；`T-QG-015` 一半已于 t37 闭合** | **制品**：`verification/ci-parity.json` 仍不存在，归 verifier / captain（§7 硬规则：architect 不创建），由 **t24** 独立复验产出。**原判定**「`T-QG-015` 目前无任何测试引用」**已被 t37 复核推翻**：该 testId 现由 `packages/qgate/test/ci-template.test.mjs`（t30 交付，**17885 B**，sha256 `666e9133b128ace8cbf0d0ea862092b443aadde8d99185d51037bba09fa8fd71`）真实引用——**4** 个 `test('T-QG-015 …')` 用例（L240 / L258 / L275 / L291），用严格分析器 + 变异检测判定 `.github/workflows/quality-gate.yml` 与可复用模板；**L291-L334 的 10 个变异 + 1 个步骤换序**逐一断言被检出 ⇒ **非空转**。REQ-015 的 testId 验证方式现已**实现**，只剩制品 |

**判定口径**：**以实际存在的资产为准修正文档，不为对齐文档而造文件**。判据来自实测（`Test-Path` + 目录清单 + 「哪个测试文件引用了该 `testId`」的交叉检索）。

**汇总 —— 实际未实现的验证方式（如实记账，不假装已实现）**：

1. **REQ-007**（`T-QG-007`）：**已于 t37 闭合**（原判定：尚未实现 / 延后）。文档点名的 `packages/qgate/test/evidence-resolution.test.mjs` 已由 t30 交付、t37 复核为**非空转**（7 用例，含 L221-L236 的注入式反例）⇒ REQ-007 的验证方式现为**已实现**。
2. **REQ-015**：**`T-QG-015` 一半已于 t37 闭合**（现由 `packages/qgate/test/ci-template.test.mjs` 真实引用，原判定「未被任何测试引用」已失效）；**仅剩**其验证制品 `verification/ci-parity.json` **延后由 t24 复验产出**。
3. **REQ-009 / REQ-015 的 `verification/**` 制品**：`verification/end-to-end.json`、`verification/ci-parity.json` 均**不存在**（t37 复核：二者**仍不存在**），**延后由 t24 独立复验产出**（产出者 = verifier，时机 = t24；architect 不创建，见 §7「任何成员不得删除或清空 `verification/**`」与目录归属）。

**为什么把这条记为 GAP-9（放在 §8.3，而不是 §6.2.3）**：§6.2.3 的 GAP-1…GAP-8 是**契约内部不自洽或跨侧映射/协作**问题；本条是**交付完备性**问题（文档承诺的验证资产尚不存在），性质属「能力边界 / 已知缺口」，与 §8.3 同族，故作为 §8.3.1 独立小节并列，而不混入 §6.2.3 的映射类台账。

**受影响需求数（t37 更新）**：16 条中**已无**「验证方式尚未实现」的需求——REQ-007 与 REQ-015 已于 t37 闭合（t27 的历史判定为 2 条，保留在上文）；仍缺的是 **2 个 `verification/**` 制品**（REQ-009 的 `end-to-end.json`、REQ-015 的 `ci-parity.json`，t24 产出）。其余 12 条文档点名的 11 个测试文件与 3 个其它路径经实测**均为「已实现、路径写错」**，已在 `docs/requirements-index.json` 与 §8.3.1 本表中修正为真实路径。

**已同步的机器可读清单（t37 更新）**：`docs/requirements-index.json` 中 REQ-007 / REQ-015 的 `covered` **已由 `false` 翻为 `true`** 并**删除** `uncoveredReason`（历史：t27 曾据当时事实置 `false`，理由为「测试不存在 / 无测试引用」）；其余条目的 `codePaths` 保持为真实存在的路径。翻转的**直接效果**：根配置 `check` 的 `TRACE_GAP` 消失、退出码由 1 回到 0（实测见本节末）。

**GAP-9.b —— demo fixture 曾声明无法被自身配置证据的 testId（t31 独立复核，已修正）**（复核在 t30 仍在进行时完成；为不与 t30 抢同一文件，本次**未改动** `docs/requirements-index.json` 与 `docs/00-requirements.md`，仅在本节记账）

**事实（实测）**：`demo/qgate.config.json` 共 **19** 个 check，其 `check.id` 经引擎内置的 `checkTestIds` 表（`packages/qgate/src/contract.mjs`）映射出**恰好 14 个**不同 testId：`T-QG-001,002,003,004,006,007,008,009,010,012,013,014,015,016`。demo 的需求索引**曾**声明 `T-QG-005` 与 `T-QG-011`——而这两个 id 在引擎映射中只由 `contract-fields-present`（→`T-QG-005`）与 `unit-tests` / `unit-tests-pass`（→`T-QG-011`）产生，**这些 check.id 在 demo 配置里都不存在**；覆盖 demo 其余 testId 的 check 也不产生它们。故这两个声明**不可能被 demo 自身的执行结果证据**。现已把 6 条 `REQ-DEMO-*` 的 `testIds` 收敛到那 14 个可证据的 id（收敛后索引与 trace-matrix 的 id 集合**逐项一致**，实测 `identical: true`）。

**为什么这不是「放宽」（净效果更严）**：`trace_matrix` 检查及 §5.3.3 一致性规则要求「声明的每个 testId 都必须出现在账本中」，即声明集合必须是**可证据集合的子集**。收敛前声明 **16** 个 id、其中 2 个**恒不可证据**（任何运行都无法满足）；收敛后声明 **14** 个、**每个都可被一次真实运行的账本证据**。声明集**缩小**而要求不变 ⇒ **净效果是更严，不是更松**。且门禁本身未改：`trace_matrix` 的 `enforce=strict` 语义（P0/P1 `covered=false` 即失败）与 `overall_passed` 公式都未动。

**同时如实记一条结构性限制（不是本次改动的后果，但必须写下来）**：`covered` 判定取「账本中出现的 testId」。账本的 `entries[].testId` 又是**由执行到的 `check.id` 经引擎内置 `checkTestIds` 表映射**得来（§5.1 的通用 check 字段表**没有** `testId` 字段，配置**不允许**自报 testId；t31 实测 19/19 个 demo check 均未声明 testId）。因此 demo 的 `covered=true` 证明的是「**该 testId 对应的 check.id 确实被这次运行执行了**」，而**不是**「根项目的 `T-QG-*` 测试真的存在并覆盖了该需求」——索引与账本的 id 集合都归纳自同一个引擎映射，二者的一致性属**夹具自洽**而非独立覆盖。真正的测试存在性由 `packages/qgate/test/**` 的用例与 GAP-9 的「尚未实现」清单分别记账，不能由 demo 的 `trace_matrix` 通过来替代。

**t37 闭合的独立复核（可复跑）**：`node packages/qgate/bin/qgate.mjs check --config qgate.config.json` ⇒ **退出码 0 / `overall_passed=true` / 5 门禁全绿**（翻转前：退出码 1，唯一 blocker 是 `verify-coverage` 的 `TRACE_GAP`，指名 `REQ-QUALITY-GATE-007` 与 `REQ-QUALITY-GATE-015`）。两个测试的**非空转**证据（文件:行）：`packages/qgate/test/evidence-resolution.test.mjs` **L221-L236**「the audit is not vacuous: an injected dangling reference is detected」（先证明健康运行可解析，再注入悬空引用并断言被检出）；`packages/qgate/test/ci-template.test.mjs` **L291-L334**「the analyzer is not vacuous: every contract defect is reported」（10 个变异 + 1 个步骤换序，逐一断言被检出）。

### 8.3.2 SAFE_001 / SAFE_003 的检测边界（t47 记账，与 `packages/qgate/gates/README.md` 的 Boundary 1–5 一致）

`SAFE_001`（不存在密钥读取）与 `SAFE_003`（不存在网络调用面）都是**文本级、确定性**的断言，作用在**一个被收窄的扫描面**与**一组有明确定义的匹配器**上。**§8.3 表里的「禁止 / 不需要」只在该边界内成立**；边界外的文本**不属保证范围**——这不影响门禁判定（判定只由这些断言的结果算出），但任何对外的「实现中不存在密钥读取 / 网络调用面」声称都必须与本节一起读。权威实现细节见 `packages/qgate/gates/README.md`（Boundary 1–5）；本节是契约侧的等价记账。

**边界清单（逐条，可复现）**：

1. **扫描面的三类排除（默认面）**：① **散文**（`.md` / `.txt` / `.rst` / `.adoc`）——文档只能「写出」某个构造，不能真的读密钥或开 socket；② **测试夹具**（`test/`、`tests/`、`__tests__/`、`fixtures/`、`*.test.*`、`*.spec.*`）——用哨兵密钥变量证明「代码没有用它」不是密钥读取；③ **生成物 / 证据目录**（`.git`、`node_modules`、`.qgate`、`verification`、`verification-t9`、`coverage`、`dist`、`build`、`artifacts`、`.cache`）——它们会**回显本策略自己的输出**，计入还会让指标依赖上一次运行（与 REQ-010 冲突），故**跳过且不计入**。**代价如实记**：`.md` 或夹具里**硬编码的真实密钥不会被发现**（`gates/README.md` 的 known blind spot）。
2. **`policy.expectedFiles` 可反向纳入**：该字段**逐字使用、绕过默认过滤**（既能收窄也能放宽）⇒ 上述三类不是「无法检测的盲区」，而是「默认不扫、可显式纳入」。实测：只含一个散文文件与一个夹具的临时树，默认 `violations=0, filesScanned=0`；加入 `expectedFiles: ["notes.md","fixture.test.mjs"]` 后 **`violations=2, filesScanned=2`**。**空扫描集是错误而不是通过**：过滤后为 0 个文件时 `SAFE_001`/`SAFE_003` 以 `no file was scanned … (empty scan set)` 失败。
3. **注释跳过，且两个曾致整行/整文件失明的分支已按 fail-closed 修掉（t46）**：
   - **注释语法被空白化**（`//` 与 `/* … */`；保留字节偏移与换行，故违规仍引用真实行号），因此**写在注释里**的 env 读取 / vault 引用 / 网络调用**不报告**（t34 Boundary 4）。`#` 注释行不被空白化（继续当代码，fail-closed）。
   - **未闭合 `/*`（R3-H2 → `gates/README.md` Boundary 4a）**：修复前会把该文件**从开启符到文件末尾整体空白化** ⇒ **整个文件对断言失明**（t36 评审实测：`path: /*/build` 之后的密钥读取、网络调用、vault 引用均 **NOT-DETECTED**，而同一内容去掉 `/*` 的对照 **DETECTED**；开启符自身包含的 `*/` 不算闭合标记）。**修复后**：只有当文件内**确实存在闭合 `*/`** 时才按注释空白化，否则 `/*` 按**普通文本**处理（fail-closed：宁可多报）。**t47 复核实测**（字节级副本 + 引擎 CLI）：`path: /*/build` 的下一行读取 ⇒ **DETECTED**。
   - **`://` 曾被误判为行注释（t46 同批修的 R3-H2 同族）**：修复前 `url: https://…` **同一行后面**的读取会被「空白到行尾」吞掉（NOT-DETECTED）——这比未闭合 `/*` 更普遍（任何含 URL 的代码行其后都失明）。**修复后**：URL scheme（字母数字等 scheme 字符 + `://`）按**文本**处理，只有真正的 `//` 才空白到行尾。**t47 复核实测**：`url: https://example.invalid/x const k = process.env.ANTHROPIC_API_KEY;` ⇒ **DETECTED**；而纯注释行 `// const k = …` 仍**不报告**（对照实测干净）。
   - **测量出处（如实标注）**：pre-fix 的 NOT-DETECTED 值取自 t36 评审的单文件函数调用与 t46 的 before/after 实测；architect 在 t47 无 VCS 可回到修复前版本，故**只独立复核了 post-fix 行为**（上面两条 DETECTED 即我的实测）。
4. **硬链接身份链：已覆盖，但两侧信号取舍不同（t46 / R3-H1）**：
   - **引擎侧**：选择管线（`preview` 与 `check` **共享同一条**，故两条路径**按构造**同时覆盖）收集**按名敏感**候选的身份（含已被名字规则排除的文件——别名正需要被排除文件的身份），**凡是 `nlink > 1` 且与敏感文件同源的候选都被排除**，即使它自己的名字无害（`notes.txt` → `.env`）。信号 = `ino:<dev>:<ino>`（同 inode）**或** `sha:<size>:<sha256>`（**与敏感文件逐字节相同**）；**两者都是精确判据**，第二个用于不共享 `st_dev`/`st_ino` 的平台与文件系统（Windows 上 inode 不可靠，实测踩过）。
   - **与适配层的【不对称】（如实呈现，不得写成「两侧实现相同」）**：适配层 `SAFETY-005-HARDLINK-ALIAS` 的第二信号是**内容呈密钥形态**（形状启发式：PEM 私钥块、`sk-…`/`ghp_…`/`AKIA…` 等高置信格式，并刻意排除占位符）；引擎侧的第二信号是**与敏感文件字节完全相同**（精确）。**两侧都覆盖「敏感文件的硬链接别名」**，但引擎**不覆盖**「内容像密钥、却没有敏感对照文件」的别名，而适配层多覆盖这一类（代价是形状启发式可能误报）。**任何「两侧等价」的声称都超出本记账。**
   - **口径变化（T46-2，消费者必须知道）**：`SAFE_002.metrics.secretPathsExcluded` **现计含别名**（同一敏感文件按名与按别名**各计一次**：`gates/README.md` 实测 3 个按名 + 3 个别名 ⇒ **3 → 6**；t47 单别名实测 = `2`），且别名与按名排除**共用冻结的 `reason=secret_path`**，靠**自由字段** `rule` 的前缀区分：`rule = alias:<sensitiveRuleId>:<via>`（例如 `alias:secret-env:same-inode-as-sensitive-path`）。适配层的等价词汇是 `reason=hardlink_secret_alias:<via>` + `ruleId=SAFETY-005-HARDLINK-ALIAS`。**本原型不新增 `reason` 或新字段**（captain 裁决）：新增 reason 属**契约面变更**（牵动 schema、GAP 台账与适配层映射表），收益小于契约漂移风险。
   - **旁观记账（t50 更新：该不一致**已由 t48 修复**；保留「发现 → 回报 → 修复」的链条）**：`adapters/opencodereview/README.md` **曾**对「哪个信号是主判据」有两处相反表述（S6 取舍段称「内容形态是主信号，inode 同源仅作补充」，t42 段称「以 `sensitiveInodes` 为第一判据，内容形态启发式仅作兜底」）——由 t47 在本文发现并回报 captain，**t48 已统一**：现行两处（README L374 与 L413）**同为**「**inode 同源是第一判据，内容形态只是兜底**」，旧反向句 grep **0 命中**（t50 复核）。本文仍只记录**两侧**信号的差异，**不裁定**适配层内部主次。
5. **`Boundary 5`：provider fixture 的 addressability ≠ replay capability**（t43）：显式给出的 `provider.fixture` 必须**可寻址**（存在、可解析、`recordings` 非空），否则**exit 3 / `PROVIDER_FAILED`**（指向 `/provider/fixture`）且**任何门禁都不执行**；但**可寻址 ≠ 能应答**——只有 `scripted` 分支要求探针录制，`deterministic`（从不重放请求）接受任何非空录制集，故「fixture 存在但答不出」仍是可能状态。**不写 `fixture` 键不是错误**：`deterministic` 照常运行，`llm`/`external` 仍降级为 deterministic（`degraded=true`）。规则禁止的是**声称一个读不到的基线**，不是移除降级路径。
6. **匹配器侧的 fail-closed 误报（R3-L1，low；t47 判定：接受并记账，不派单改代码）**：`SAFE_001`/`SAFE_003` 都是**文本子串 / 词汇匹配**，因此**字符串字面量**里的 token 会被命中——实测：`const s = "https.request";`、`const s = "axios.get(url)";`、JSON 值 `"fetch(url)"`、`"process.env.ANTHROPIC_API_KEY"` **均 DETECTED**；而**纯注释行与行尾注释不报告**（实测干净）⇒ 这**不是**「注释后的代码行被误判」，而是「字符串只按文本形态匹配」。取舍与 `gates/README.md` 的既有意图一致（SAFE_001 的字符串字面量命中已写明并由回归测试锁定）：**误报代价 = 一次改名 / 改写；漏报代价 = 静默的密钥读取或网络调用** ⇒ 保持 fail-closed。

> **免责口径（并入保证范围声明）**：`SAFE_001` / `SAFE_003` 的保证范围**以其声明边界为限**；跨出该边界时（注释内写出的读取 / 网络调用、三类被排除的扫描面、`expectedFiles` 未纳入的路径、非身份链可判的别名、匹配器词汇之外的同义写法）**不作为保证**——**不得**据此声称「实现中不存在任何密钥读取 / 网络调用面」。
>
> **审计边界（与 §8.3.1 GAP-9.b 同一件事，此处只做交叉引用）**：`covered=true` 只证明「**承载该 testId 的 check 被执行了**」，**不代表根项目里真的存在并运行了覆盖该需求的测试**（索引与账本 id 集合同源于引擎内置 `checkTestIds` 映射 ⇒ **夹具自洽**而非独立覆盖）⇒ **不得据此宣称「根侧覆盖已闭环」**。完整论证见 **§8.3.1 GAP-9.b**（`covered` 判定同源那一条），本节不重复。

### 8.4 分阶段交付里程碑

| 里程碑 | 交付物 | 完成判据 |
|---|---|---|
| M1 契约冻结 | `docs/00-requirements.md`、`docs/01-architecture.md`、`docs/requirements-index.json`、`schemas/*.schema.json` | 本任务验收通过 |
| M2 引擎可用 | `packages/qgate/**` + 七类 check + 六个核心命令与 `stage` 阶段审查命令 | `node --test packages/qgate/test` 全绿；双 cwd 复现一致 |
| M3 适配层与 CI | `adapters/opencodereview/**`、`.github/workflows/quality-gate.yml` | 安全不变量反向用例通过；workflow 无 `secrets.` |
| M4 手册 | `docs/02-playbook.md` | 五阶段各含 7 要素 + OCR 手法映射 |
| M5 独立验证 | **引擎审计链（路径冻结，不得更改）**：`verification/evidence/**`、`verification/reports/**`、`verification/trace-matrix.json`、`verification/approvals/**`；**verifier 私有取证（由 t24 认领；目录名沿用历史命名 `verification-t9`、可改名）**：`verification-t9/**`（`tools/`、`artifacts/`、`negative/`、`report.json`、`review.md`） | 端到端退出 0 + 反向用例 + 哈希复算一致 |
| M6 集成 | 根 `README.md`、一键验证入口 | 一条命令复现全部验证结论 |

---

## 9. 附录：辅助制品格式（契约的一部分）

### 9.1 `verification/approvals/<gateId>/approval.json`

```json
{
  "schemaVersion": "1.0",
  "gateId": "design-to-build",
  "role": "architect",
  "decision": "approved",
  "approvedBy": "architect",
  "approvedAt": "2026-05-04T09:00:00Z",
  "claims": [
    { "claimId": "interface-frozen", "statement": "qgate.config.json 字段名与类型已冻结，实现方不得重命名", "testIds": ["T-QG-004", "T-QG-011"] }
  ],
  "notes": "字段级契约见 docs/01-architecture.md §4-§6"
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `schemaVersion` | `string` | 是 | `"1.0"` |
| `gateId` | `string` | 是 | 必须与所在目录名及配置中的 gate id 一致 |
| `role` | `string` 枚举 | 是 | `product` \| `architect` \| `reviewer`；必须与 `humanGate.role` 一致 |
| `decision` | `string` 枚举 | 是 | `approved` \| `rejected` \| `revise` |
| `approvedBy` | `string \| null` | 是 | 与 `role` 语义相符的签署人；`decision="approved"` 时**必须为非空字符串**，未审批/缺失时为 `null`（与 §5.2 的 `gates[].humanGate.approvedBy: string \| null` 一致） |
| `approvedAt` | `string \| null` | 是 | 签署时间；`decision="approved"` 时**必须为非空 RFC3339 UTC 字符串**，未审批/缺失时为 `null`（与 §5.2 的 `approvedAt: string \| null` 一致） |
| `claims` | `array<object>` | 是 | `{claimId:string, statement:string, testIds:array<string>}`；`claimId` 唯一 |
| `notes` | `string` | 否 | `""` |

> **nullability 说明（captain 裁决 2）**：§9.1 原写「非空 / RFC3339 UTC」**过时**，以 §5.2 为准：`approvedBy` / `approvedAt` 为 `string \| null`。语义为：`decision="approved"` 时二者必须为非空字符串；未审批/缺失时为 `null`。二者含义不同——`null` 表示「尚未签署」，非空表示「已由该角色于该时间签署」。
>
> 该条件由**代码强制**：`packages/qgate/src/human-gate.mjs` 在 `decision !== "approved"` 时返回 `approvedBy: null, approvedAt: null`，在 `decision === "approved"` 时要求二者为非空字符串（否则 `approvalState="missing"` 并产生 `HUMAN_GATE_NOT_APPROVED` blocker）。此处刻意**不在 JSON Schema 的 `type` 层面**表达该条件：JSON Schema 无法无歧义地声明「某字段取值 ⇒ 另两个字段非空」的跨字段断言；schema 侧因此使用 `oneOf: [{type:"string"}, {type:"null"}]` 而非 `type:["string","null"]`——后者会让 `pattern`/`maxLength` 等字符串关键字静默失效（见 `schemas/README.md`）。

### 9.2 RunResult 判定算法（伪代码，等价于实现要求）

```text
run(config):
  validate(config)                       # 失败 ⇒ exit 2
  run_id = utcNow(ISO-ms) + "-" + randomHex8()
  for stage in [requirements, design, build, review, verify]:
    for gate in config.gates.where(g => g.stage == stage) ordered by config order:
      for check in gate.checks ordered by config order:
        result = executeCheck(check)     # 7 类之一；异常 ⇒ error.code=PROVIDER_FAILED/INTERNAL_ERROR ⇒ exit 3
        gate.checks.push(result)         # 全部检查都执行（除非 --fail-fast）
        if result.passed == false and check.required and check.onFail != "warn":
          gate.blockers.push({checkId, severity, message: prefix(result), evidence})
      if gate.humanGate:
        state = readApproval(gate.humanGate.approvalRecord, gate.humanGate.role)
        gate.humanGate = {..., approvalState: state}
        if state != "approved" and gate.required:
          gate.blockers.push({checkId: gate.id, severity: "blocker", message: "HUMAN_GATE_NOT_APPROVED: ...", evidence: [...]})
      gate.passed = (gate.blockers).length == 0        # required + onFail 决定；severity 不参与（t27 裁决）
  # gates[] 只含本次已运行的门禁（--stage 过滤时未运行者被省略，不占位）
  overall_passed = gates.where(g => g.required).all(g => g.passed)
  writeLedger(run_id, ...) ; updateLedgerIndex() ; emit(RunResult)
  exit overall_passed ? 0 : 1
```

> **`severity` 的用途（t27 裁决）**：上式中 `severity` **不出现**——它只决定**如何呈现与升级**（报告分级、排序、AI 修复预算的升级路径），**不决定门禁通过与否**。唯一免阻断通道是 `onFail="warn"`。详见 §5.2.1。

> **`--stage` 的诚实表达**：未运行的门禁**从 `gates[]` 省略**（既不写 `passed:false` 也不写 `true`），只由 **`--summary` 的两个输出面**列出——stdout 文本面的 `not-run <stage>/<gate>: <reason>` 行，与 **`--summary --out` 包络**的 `not_run_gates: [{id, stage, reason}]`（两面实测逐项一致）；否则 `overall_passed` 公式会把 `--stage` 恒判为 `false`（CI 四阶段全挂）或造成假通过。**结构化字段只在包络里，必须给 `--out` 才能取得**。详见 §5.2.1。
>
> **信任模型假设（t35 记账）**：本算法**假定** `writeLedger` / `updateLedgerIndex` 写下的就是本次运行的产物，**不校验**账本是否由本引擎生成、也不与任何外部锚点比对——`EVIDENCE_UNRESOLVED` 只能发现链**内部**不自洽（能发现意外 / 陈旧 / 局部篡改，**不能**发现整链伪造）。保证强度与可选外部锚点见 §5.3.2「能力边界（信任模型）」。

**blocker `message` 前缀枚举**（机器可读，冻结）：`CONFIG_INVALID`、`FILE_MISSING`、`FILE_PRESENT`、`REGEX_MISMATCH`、`COMMAND_FAILED`、`JSON_ASSERT_FAILED`、`TRACE_GAP`、`ORPHAN_TEST_ID`、`POLICY_VIOLATION_SAFE_001`、`POLICY_VIOLATION_SAFE_002`、`POLICY_VIOLATION_SAFE_003`、`POLICY_VIOLATION_CONTRACT_001`、`HUMAN_GATE_NOT_APPROVED`、`PROVIDER_FAILED`、`EVIDENCE_UNRESOLVED`。

### 9.3 契约自检（下游实现的最低门槛）

实现方必须在 `qgate contract --check` 中断言以下映射存在且一致，任一不一致退出 3（`CONTRACT_DRIFT`）：

- `stages` = §3.1 五阶段顺序；
- `humanGates` = §3.2 三处（含 role 与默认 approvalRecord）；
- `checkTypes` = §5.1 七类；
- `exitCodes` = §6.3 四值；
- `commands` = §6.2 六个核心命令及 `stage` 阶段审查命令的参数名。
