# 00 — 需求集合（AI 质检门禁流水线 qgate）

| 字段 | 值 |
|---|---|
| 文档 ID | `docs/00-requirements.md` |
| 版本 | `1.0.0`（契约冻结版） |
| 状态 | FROZEN（冻结后只能通过需求变更流程修改） |
| Owner | architect |
| 关联文档 | `docs/01-architecture.md`（接口规格）、`docs/02-playbook.md`（落地手册）、`verification/`（独立验证） |
| 项目根 | `E:\ai-quality-gate`（本仓库所有路径均为相对项目根的 POSIX 相对路径） |

> 契约冻结含义：`docs/01-architecture.md` 中给出的字段名、类型、枚举取值、退出码即为实现的验收基线。下游实现方（`packages/qgate/**`、`adapters/opencodereview/**`）不得重命名或增删基线字段；若发现契约自相矛盾，必须上报 captain 而不是自行发明。

---

## 1. 背景与设计依据

本流水线把两套已存在的公开工程实践融合为一个**离线可跑、机器可验证**的阶段质量门禁模型：

1. **确定性工程 × LLM Agent 的混合架构**（来源：`alibaba/open-code-review`，CLI 名 `ocr`）
   - 可工程化的步骤交给确定性代码：文件选择（`internal/agent/selection.go`，纯确定性、无副作用，因此 `--preview` 与真实执行使用同一套选择结果）、二进制 / 密钥路径 / 默认排除目录 / 扩展名过滤、文件分组（`FileGroup`，`maxFilesPerGroup=10`，超 token 预算降级为单文件组，LLM 分组失败回退 per-file）、规则匹配（`.opencodereview/rule.json`，优先级 `--rule` > 项目 > 用户 > 系统内置，第一条匹配生效）、行号定位与 re-tracking、reflection / suggestion validation（`CommentWorkerPool` 异步）、失败降级。
   - 安全不变量：密钥路径检查先于用户 `include`，内置敏感路径不可被 `include` 重新纳入。
   - 明确取舍：更高 Precision / F1，Token 约为通用 Claude Code Agent 方案的 1/9，但 Recall 更低（以牺牲召回换更少噪声）。
   - 还支持 Delegation Mode（不自己调 LLM，把筛选与规则解析结果交给 Host Agent）、JSON 输出与 CI 集成。
2. **AI-Native SDLC 的分阶段人审门禁模型**（来源：Anthropic AI-Native SDLC Playbook）
   - 生命周期划分为 Plan → Design → Build → Test → Deploy → Maintain；每个交接点设人类审批门禁，用**机器可验证的制品与证据**替代“信任模型输出”。

本项目的融合方式：把 (2) 的阶段交接点转译为 qgate 的 `gates`，并用 (1) 的确定性工程手法保证每个门禁的判定结果可复现、可审计、无网络依赖。

---

## 2. 术语与约定

| 术语 | 定义 |
|---|---|
| 门禁（gate） | 一次可判定通过/不通过的质量检查单元，对应一个 `stage`，必需时可挂一处人类门禁。 |
| 检查（check） | 门禁内部的原子判定项，类型取自固定枚举（`config.schema.json` 的 `check.type`）。 |
| 产品级通过（passed） | **该检查/门禁自身**判定为真。 |
| `overall_passed` | RunResult 顶层总判定，等于 `all(required gates passed)`。可选门禁（`required: false`）失败**不影响** `overall_passed`，但仍在报告中呈现。 |
| 硬失败（hard fail / blocker） | **必需检查失败即硬失败**：任一检查满足 `required===true && passed===false && onFail!=="warn"` ⇒ 该门禁失败；若该门禁 `required=true`，则 `overall_passed=false` ⇒ 退出码 1。**`severity` 不是阻断开关**，只决定呈现与升级；唯一显式免阻断通道是 `onFail="warn"`（见 `docs/01-architecture.md` §5.2.1）。 |
| 证据（evidence） | 支撑某个检查判定的机器可读制品，落盘位置见 `docs/01-architecture.md` §5。 |
| 证据账本（evidence ledger） | 一次运行的全部检查判定与证据引用的台账。 |
| 追踪矩阵（trace matrix） | `requirementId → testIds → codePaths → covered` 的映射凭证。 |
| 人类门禁（humanGate） | 一个必须由人签署 `approval.json` 才能通过的门禁；`required` 语义见 **REQ-QUALITY-GATE-016**（§3）。 |
| 确定性 provider | 由离线 fixture 驱动的 provider，无网络、无模型调用，同一输入必得同一输出。 |

---

## 3. 需求集合

需求 ID 规则：`REQ-QUALITY-GATE-NNN`，三位数字，从 `001` 起，**全文唯一且不可变**。优先级取值 `P0` / `P1` / `P2`；P0、P1 需求必须挂至少一个 `testId`。全部 16 条需求均为 P0/P1，因此**每条都挂了 testId**。

### REQ-QUALITY-GATE-001 — 门禁契约引擎必须按有序阶段执行

- **描述**：核心引擎 `qgate` 读取 `qgate.config.json`，按固定阶段顺序 `requirements → design → build → review → verify` 执行门禁；同一阶段内按 `checks` 数组顺序执行，同一阶段内出现失败不中断后续检查（全部检查都要产出判定），阶段级失败按 **`required` 与 `onFail`** 决定是否阻断 —— **`severity` 不参与阻断判定**（它只决定报告分级与升级路径；见 `docs/01-architecture.md` §5.2.1）。
- **可测验收标准**：对 `packages/qgate/examples/` 中的五阶段合法配置执行 `qgate check --config <path> --json`，stdout 可解析为 RunResult；`result.gates[*].stage` 去重后严格等于 `["requirements","design","build","review","verify"]`；任一必需门禁失败时 `overall_passed=false` 且退出码为 1。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/*.test.mjs` + 人工核对 `qgate check` 的真实 stdout 与 **`packages/qgate/gates/contract.json`** 中记录的 `stages` / `humanGates` 期望值一致（原文档点名的 `gates/stage-order.json` 不存在，已更正）。
- **优先级**：P0 ｜ **testId**：`T-QG-001`
- **追溯阶段**：全部 5 阶段

### REQ-QUALITY-GATE-002 — 配置 schema 必须被严格校验并以退出码 2 失败

- **描述**：`qgate` 必须在执行任何门禁前校验配置。校验项至少包含：`version === "1.0"`；`provider.type ∈ {deterministic, scripted, llm, external}`；`gates` 为非空数组；`gate.stage ∈ {requirements, design, build, review, verify}`；`check.type ∈ {file_exists, file_not_exists, regex, command, json_assert, trace_matrix, policy}`；每个 `check.id` 在一个门禁内唯一。违规时打印指向 `jsonPointer` 的结构化错误，不运行任何检查。
- **可测验收标准**：`packages/qgate/examples/invalid/` 下 6 个非法配置（未知 check.type、未知 stage、缺失 version、重复 check.id、provider.type 非法、gates 为空数组）逐个执行 `qgate check --config <path> --json`，每个都满足：退出码 `= 2`，stdout 是含 `error.code="CONFIG_INVALID"` 与 `error.details[0].jsonPointer` 的 JSON，且 stdout 中不出现任何 `run_id`（证明未开始运行）。
- **验证方式**：`node packages/qgate/bin/qgate.mjs check --config packages/qgate/examples/invalid/<name>.json --json; $LASTEXITCODE` 逐条核验，结果记入 `verification/reports/`.
- **优先级**：P0 ｜ **testId**：`T-QG-002`
- **追溯阶段**：build

### REQ-QUALITY-GATE-003 — 七类 check 语义必须完整且与字段表一致

- **描述**：`file_exists`、`file_not_exists`、`regex`、`command`、`json_assert`、`trace_matrix`、`policy` 七类检查必须全部实现，字段名、类型、默认值、失败语义与 `docs/01-architecture.md` **§5.1** 的字段表逐字一致。
- **可测验收标准**：`packages/qgate/test/checks.test.mjs` 中每类检查至少 1 个通过用例与 1 个失败用例（共 ≥14 个用例）全部通过；对每一类检查，构造“字段缺失”或“字段类型错误”的配置时退出码为 2 而非 3（证明类型校验而非崩溃）。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/pipeline-and-checks.test.mjs`（原点名 `checks.test.mjs` 不存在；七类 check 的通过/失败用例已并入该文件），输出用例名与字段表逐行对照。
- **优先级**：P0 ｜ **testId**：`T-QG-003`
- **追溯阶段**：build

### REQ-QUALITY-GATE-004 — RunResult 必须逐字段与冻结 schema 一致

- **描述**：RunResult 的字段名与类型必须与 `docs/01-architecture.md` **§5.2** 完全一致：`version:string`、`run_id:string`、`started_at:string(RFC3339)`、`overall_passed:boolean`、`gates[].id/stage/passed/required`、`gates[].blockers[].checkId/severity/message/evidence`、`gates[].checks[].id/type/passed/evidence`。
- **可测验收标准**：对 demo 仓库运行 `qgate check --config demo/qgate.config.json --json > out.json`，用一个独立断言脚本检查：五阶段运行后顶层键集合恰好为 `{version,run_id,started_at,overall_passed,gates,finished_at,provider,duration_ms}`；`gates[*]` 的键集合恰好为 `{id,stage,passed,required,blockers,checks,humanGate}`；`checks[*]` 的键集合恰好为 `{id,type,passed,evidence,severity}`；无多余字段、无缺失字段。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/config-and-run-result.test.mjs`（原点名 `run-result-shape.test.mjs` 不存在；键集合精确断言在该文件的「RunResult key sets match the frozen schema exactly」）（键集合精确比对，`deepStrictEqual(Object.keys(...))`）。
- **优先级**：P0 ｜ **testId**：`T-QG-004`
- **追溯阶段**：build

### REQ-QUALITY-GATE-005 — 证据账本必须只追加、可复算、可复现

- **描述**：每次运行必须写出 `verification/evidence/ledger-<run_id>.json`（只追加，同一 `run_id` 不得被覆盖），并原子更新 `verification/evidence/ledger-index.json`。`started_at` / `finished_at` / `run_id` / `duration_ms` 之外的字段必须完全由配置与被检仓库内容决定（互不依赖的检查可并行，因此账本中的 `checks` 若并行执行则必须按 `gateId`+`checkId` 排序后再写盘）。
- **可测验收标准**：对同一仓库、同一配置连续运行两次，两次 RunResult 在剔除 `run_id`、`started_at`、`finished_at`、`duration_ms` 后**深度相等**；`ledger-index.json` 的 `runIds` 长度为 2 且包含两次的 `run_id`；`sha256` 字段等于对应账本文件的真实 sha256。
- **验证方式**：`qgate check` 连跑两次 + `node --test --experimental-test-isolation=none packages/qgate/test/pipeline-and-checks.test.mjs`（原点名 `determinism.test.mjs` 不存在；两次运行仅运行时字段不同的断言已在其中）（比较两次输出的规范化 JSON 与真实文件哈希）。
- **优先级**：P0 ｜ **testId**：`T-QG-005`
- **追溯阶段**：verify

### REQ-QUALITY-GATE-006 — 追踪矩阵必须双向覆盖且无孤儿

- **描述**：`trace_matrix` 检查必须验证：每个 `requirementId` 在 `docs/trace-matrix.json` 中存在；P0/P1 需求的 `testIds` 非空；`evidence/ledger-index.json` 中出现过的 `testId` 必须被某个需求引用（无孤儿 testId）；当 `enforce=strict` 时 `covered=false` 的需求必须判定失败。
- **可测验收标准**：在 demo 仓库中人为删除 `REQ-DEMO-0002` 的一条 `testIds` 后运行 `qgate trace --json`，退出码为 0 且输出中该需求 `covered=false`；运行 `qgate check`（其 verify 阶段含 `trace_matrix` 检查）时该检查 `passed=false` 且产生 `severity="high"` 的 blocker；恢复后再次运行为 `passed=true`。
- **验证方式**：`node packages/qgate/bin/qgate.mjs trace --config demo/qgate.config.json --json`（篡改前/后各一次）+ `packages/qgate/test/pipeline-and-checks.test.mjs`（原点名 `trace-matrix.test.mjs` 不存在；`TRACE_GAP` 用例已在其中）。
- **优先级**：P0 ｜ **testId**：`T-QG-006`
- **追溯阶段**：verify

### REQ-QUALITY-GATE-007 — 证据链可审计：evidence 引用必须可解析

- **描述**：每个 `check.evidence` 是对象数组 `[{path, kind, excerpt}]`，`path` 为相对项目根的 POSIX 路径，`kind ∈ {file, stdout, json_pointer, ledger, trace}`。所有 `path` 必须真实存在（`ledger`/`trace` 类型必须能在 `ledger-index.json` 中解析到 `run_id`）。
- **可测验收标准**：`qgate check --json` 输出的每一个 `evidence.path`（非空者）通过文件存在性检查；人为把某个 evidence 指向不存在的文件后，`qgate explain` 对其报 `EVIDENCE_UNRESOLVED`（退出码 3 且 `error.code` 精确等于该值），从而证明引用被真实解析而不是被忽略。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/evidence-resolution.test.mjs`（**t30 交付、t37 独立复核闭合**；7 个 `T-QG-007` 用例覆盖三种悬空形态：`kind="file"` 指向不存在的路径、记录后被删除的制品、`ledger`/`trace` 指向不存在的路径或未列入索引的账本；另覆盖七类 check 的失败分支不留悬空引用、shipped demo 与根配置的引用全部可解析、CLI `explain` 的 `EVIDENCE_UNRESOLVED`（退出码 3）路径，以及 **L221-L236 的注入式反例**「the audit is not vacuous」）。**历史（t27 判定）**：该文件当时**不存在且无等价覆盖**，本需求的验证方式曾标记为「尚未实现 / 延后」，见 `docs/01-architecture.md` §8.3.1 GAP-9。
- **优先级**：P1 ｜ **testId**：`T-QG-007`
- **追溯阶段**：verify

### REQ-QUALITY-GATE-008 — 人类门禁必须是硬阻断且最多 3 处

- **描述**：人类门禁固定 3 处，且只能位于 `requirements → design`、`design → build`、`review → verify` 三个交接点。`humanGate.enforcement === "blocking"`（schema 中唯一允许取值）时，若 `approval.json` 缺失、`decision !== "approved"`、`approvedBy` 与 `role` 不符、或 `claimId` 未出现在 `approval.claims` 中，则该门禁判定 `passed=false` 且 `overall_passed=false`，`blockers[].severity="blocker"`。
- **可测验收标准**：删除 `verification/approvals/design-to-build/approval.json` 后运行，`overall_passed=false`、退出码 1、该门禁 `blockers[0].message` 含 `HUMAN_GATE_NOT_APPROVED`；写回 `decision:"approved"` 后同一配置 `overall_passed=true`、退出码 0；对含 0 处或 4 处 `humanGate` 的配置，行为与 `docs/01-architecture.md` §3 的冻结规则一致（非法位置 => 配置错误退出 2；缺失 => 允许但输出 `approvals_missing` 提示）。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/acceptance.test.mjs`（原点名 `human-gate.test.mjs` 不存在；人类门禁用例已并入其中） + `verification-t9/negative/` 中的反向用例（删除审批文件的脚本化复现；目录归属重构后的实际位置）。
- **优先级**：P0 ｜ **testId**：`T-QG-008`
- **追溯阶段**：requirements / design / review

### REQ-QUALITY-GATE-009 — 五阶段流水线必须被演示仓库端到端贯通

- **描述**：`demo/` 必须是一个可独立运行的最小仓库，其 `demo/qgate.config.json` 覆盖五个阶段、七类检查与三处人类门禁；`verification/end-to-end.json`（**延后**：由 t24 独立复验产出，architect 不创建） 必须由真实命令产出而非手写。
- **可测验收标准**：仅执行 `node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json`（不做任何手工准备）即可得到 `overall_passed=true`、退出码 0；该命令与 `qgate report` 的实际输出（含 `run_id`）被逐字记录进 `verification/end-to-end.json`（**延后**：由 t24 独立复验产出，architect 不创建）。
- **验证方式**：verifier 在干净 checkout 中执行上述命令；`verification/end-to-end.json`（**延后**：由 t24 独立复验产出，architect 不创建） 的 `commandsRun[].command` / `exitCode` 与实际一致。
- **优先级**：P0 ｜ **testId**：`T-QG-009`
- **追溯阶段**：全部 5 阶段

### REQ-QUALITY-GATE-010 — 零依赖、离线、确定性

- **描述**：`packages/qgate/**` 必须是纯 ESM、零运行时依赖（`dependencies` 为空对象或缺失；允许仅 `devDependencies` 为空）、不访问网络的实现；所有路径必须由 `import.meta.url` 推导，从任意 cwd 运行结果一致；不得依赖 `npm install`、全局命令或 PATH 中的外部工具（`command` 检查在测试中只使用 `node` 自身）。
- **可测验收标准**：从 `E:\ai-quality-gate` 与从 `C:\Windows\Temp` 两个不同 cwd 分别执行同一条 `qgate check` 命令，退出码与规范化后的 RunResult 深度相等；`packages/qgate/package.json` 的 `dependencies` 字段不存在或为空对象；`node --test` 在断网环境下全部通过。
- **验证方式**：双 cwd 执行对比 + `node --test --experimental-test-isolation=none packages/qgate/test/acceptance.test.mjs packages/qgate/test/pipeline-and-checks.test.mjs packages/qgate/test/robustness.test.mjs`（原点名 `zero-dep.test.mjs` 不存在）（读取 `package.json` 断言 + 尝试真实断网执行）。
- **优先级**：P0 ｜ **testId**：`T-QG-010`
- **追溯阶段**：build / verify

### REQ-QUALITY-GATE-011 — CLI 契约与退出码必须精确一致

- **描述**：必须实现 `contract`、`check`、`trace`、`preview`、`report`、`explain` 六个核心命令，以及阶段语义审查命令 `stage`；参数名、`--json` / `--summary` / `--quiet` 行为、退出码 `0=通过`、`1=门禁失败`、`2=配置错误`、`3=内部错误` 与 `docs/01-architecture.md` §6 表格逐字一致。`stage` 不新增 check.type，也不拥有最终通过判定权。
- **可测验收标准**：六个核心命令和 `stage` 阶段审查命令在 demo/临时仓库上各执行一次，退出码与 `--json` 输出符合对应契约；`qgate contract --json` 能作为契约自描述（返回 `configSchemaVersion`、`checkTypes[]`、`commands[]`、`exitCodes`）；未知命令与未知参数均退出 2 且 `error.code="CONFIG_INVALID"`；`qgate explain` 指向不存在 `gateId` 时退出 3 且 `error.code="INTERNAL_ERROR"`。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/acceptance.test.mjs`（原点名 `cli.test.mjs` 不存在；退出码与相对 `--config` 的 cwd 语义用例已并入其中）（对每个命令做退出码与 JSON 形状断言）+ `verification/` 中记录的真实命令输出。
- **优先级**：P0 ｜ **testId**：`T-QG-011`
- **追溯阶段**：build

### REQ-QUALITY-GATE-012 — OCR 适配层必须 100% 离线且不可重新纳入敏感路径

- **描述**：`adapters/opencodereview/` 负责文件选择、分组与规则匹配的确定性复刻，并在 `ocr` CLI 缺失时降级为本地实现；密钥路径（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`credentials*`、`secrets/**`）检查**先于**用户 `include`，且任何 `include` 模式都不得把内置敏感路径重新纳入；二进制文件、默认排除目录（`.git/**`、`node_modules/**`）、不支持扩展名必须始终排除；分组每组 ≤ 10 文件，超 token 预算降级为单文件组。
- **可测验收标准**：`node adapters/opencodereview/test/selection.test.mjs` 通过；对 `include: ["**/*"]` 的最宽泛配置，选择结果中不含任何 `secrets/**` 与 `.env*` 文件；`--preview` 与真实执行的选择结果 JSON 深度相等（同一次输入）；`ocr` 不在 PATH 时命令仍退出 0 并在输出中标注 `degraded:true`；全程无 `ANTHROPIC_API_KEY` / 任意 API key 环境变量亦可运行。
- **验证方式**：`node adapters/opencodereview/bin/ocr-preview.mjs --root demo --json`（该文件是适配层唯一 CLI；原点名 `ocr-adapter.mjs` 与 `select` 子命令**均不存在**，实际接口以 `--root`/`--diff`/`--rule` 等 flag 表达，见 `adapters/opencodereview/README.md` §1.1 参数表）与不带 `--root` 的等价调用输出比对 + 反向用例 `verification-t9/negative/`（目录归属重构后 verifier 私有反向用例的实际位置）。
- **优先级**：P0 ｜ **testId**：`T-QG-012`
- **追溯阶段**：design / build

### REQ-QUALITY-GATE-013 — 反馈闭环与 finding 分级必须可判定

- **描述**：源码门禁（`check`）与评审门禁（`review`）必须产出 `severity ∈ {blocker, high, medium, low}`；`blocker`/`high` 阻断相位推进，`medium` 记录为技术债，`low` 仅记录。AI 修复预算规则必须可执行：同一 finding 在环内最多 2 次自动修复尝试，第 3 次或涉及公共接口/安全不变量的 finding 必须升级到提交门禁后修复并请求人类裁决。
- **可测验收标准**：含 1 个 `high`、1 个 `medium`、1 个 `low` finding 的 fixture 运行后：`blockers` 中只出现 `high`（`medium`/`low` 出现在 `checks[].evidence` 而非 `blockers`）；对同一条 finding 连续执行 3 次修复尝试的模拟脚本，第 3 次输出 `escalate:true` 且 `reason` 精确包含 `FIX_BUDGET_EXCEEDED`。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/acceptance.test.mjs`（原点名 `severity.test.mjs` 不存在；severity/confidence 用例已并入其中） + `packages/qgate/examples/severity-mix.json` 的真实运行输出。
- **优先级**：P1 ｜ **testId**：`T-QG-013`
- **追溯阶段**：review

### REQ-QUALITY-GATE-014 — provider 可替换，确定性 provider 由离线 fixture 驱动

- **描述**：`provider` 必须支持四种 `type`：`deterministic`（默认，纯本地规则 + 离线 fixture，无网络）、`scripted`（用 `script` 指定本地 Node 模块，其 `run(context)` 返回 finding 数组）、`llm`（真实模型，**本原型可选且非必需**）、`external`（调用外部 CLI，如 `ocr`）。当 `type="llm"` 且缺少 key/网络时，必须降级为 `deterministic` 并设置 `provider.degraded=true`，**不得**导致门禁整体崩溃。
- **可测验收标准**：`provider.type="deterministic"` 的运行在离线环境（无网络、无任何 API key）下 `overall_passed=true` 且 `provider.degraded=false`；`provider.type="llm"` 在同一环境下仍退出 0/1（不出现 3），且 RunResult 中 `provider.degraded=true`；`scripted` provider 指向的 `script` 缺失或抛错时 `error.code="PROVIDER_FAILED"` 且退出码 3。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/acceptance.test.mjs`（原点名 `provider.test.mjs` 不存在；四种 provider 与降级用例已并入其中）（三种 provider 各 1 个用例 + 降级路径）。
- **优先级**：P1 ｜ **testId**：`T-QG-014`
- **追溯阶段**：build / verify

### REQ-QUALITY-GATE-015 — CI 模板必须可离线执行并映射到门禁

- **描述**：`.github/workflows/quality-gate.yml` 必须定义 `requirements`、`design`、`build`、`review`、`verify` 五个 job（或等价步骤），每个 job 调用对应 `qgate` 命令；不得引用任何需要密钥的 action；人类门禁以 approval 制品的存在性检查体现。
- **可测验收标准**：workflow 中不出现 `secrets.` 引用与非 `ubuntu-latest`/`windows-latest` 之外的外部 action（除 `actions/checkout`）；本地以 `qgate check --config demo/qgate.config.json` 复现 job 行为时退出码与 workflow 中记录的判据一致；`verification/ci-parity.json`（**延后**：由 t24 独立复验产出；`T-QG-015` 现已由 `packages/qgate/test/ci-template.test.mjs` 真实引用，见验证方式） 逐 job 记录“workflow 步骤 → 本地命令 → 退出码”。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/ci-template.test.mjs`（**t30 交付、t37 独立复核闭合**；4 个 `T-QG-015` 用例：五 job 与冻结阶段 1:1 + `needs` 链、前四 job 各跑 `check --stage <stage>`、`secrets.` 零引用、action 必须钉 40 位 commit SHA、权限上限 `contents:read` + `pull-requests:write`、离线 provider 声明、verify 的三段式顺序与人工审批步骤，并有 **L291-L334 的 10 个变异 + 1 个步骤换序**非空转断言）+ 静态检查（`Select-String` 扫描 `secrets.` 与 `uses:`）+ 逐 job 本地复现命令。
- **优先级**：P1 ｜ **testId**：`T-QG-015`
- **追溯阶段**：全部 5 阶段

### REQ-QUALITY-GATE-016 — 人类门禁的审批语义必须显式且可配置

- **描述**：`humanGate` 必须显式声明 `role`（`product` / `architect` / `reviewer`）、`approvalRecord`（默认 `verification/approvals/<gateId>/approval.json`）与 `enforcement`（`blocking`，schema 中唯一允许取值）。`humanGate.required` 与门禁 `required` 解耦：门禁 `required:false` 时，人类审批缺失只产生 `approvals_missing` 记录，**不影响** `overall_passed`；门禁 `required:true` 时审批缺失必须阻断。
- **可测验收标准**：同一审批缺失状态下，`required:true` 的门禁令 `overall_passed=false`、退出码 1、blocker 消息含 `HUMAN_GATE_NOT_APPROVED`；把该门禁改为 `required:false` 后 `overall_passed` 只由其他必需门禁决定，且 RunResult 中出现 `humanGate.approvalState="missing"` 与 `approvals_missing` 计数。
- **验证方式**：`node --test --experimental-test-isolation=none packages/qgate/test/acceptance.test.mjs`（原点名 `human-gate-required.test.mjs` 不存在；`required:false` 与 `approvalState` 用例已并入其中）（两种 `required` 取值的对照运行）。
- **优先级**：P1 ｜ **testId**：`T-QG-016`
- **追溯阶段**：requirements / design / review

---

## 4. 需求 → testId 汇总

| 需求 ID | 优先级 | testId | 主要追溯阶段 |
|---|---|---|---|
| REQ-QUALITY-GATE-001 | P0 | T-QG-001 | 全部 5 阶段 |
| REQ-QUALITY-GATE-002 | P0 | T-QG-002 | build |
| REQ-QUALITY-GATE-003 | P0 | T-QG-003 | build |
| REQ-QUALITY-GATE-004 | P0 | T-QG-004 | build |
| REQ-QUALITY-GATE-005 | P0 | T-QG-005 | verify |
| REQ-QUALITY-GATE-006 | P0 | T-QG-006 | verify |
| REQ-QUALITY-GATE-007 | P1 | T-QG-007 | verify |
| REQ-QUALITY-GATE-008 | P0 | T-QG-008 | requirements / design / review |
| REQ-QUALITY-GATE-009 | P0 | T-QG-009 | 全部 5 阶段 |
| REQ-QUALITY-GATE-010 | P0 | T-QG-010 | build / verify |
| REQ-QUALITY-GATE-011 | P0 | T-QG-011 | build |
| REQ-QUALITY-GATE-012 | P0 | T-QG-012 | design / build |
| REQ-QUALITY-GATE-013 | P1 | T-QG-013 | review |
| REQ-QUALITY-GATE-014 | P1 | T-QG-014 | build / verify |
| REQ-QUALITY-GATE-015 | P1 | T-QG-015 | 全部 5 阶段 |
| REQ-QUALITY-GATE-016 | P1 | T-QG-016 | requirements / design / review |

需求总数：**16**（全部 ≥12 的唯一 ID 要求满足）。testId 总数：**16**，与需求一一对应，无孤儿 testId。

---

## 5. 非目标（Non-Goals）

以下内容**明确不做**，任何实现若引入即视为超出范围（应作为新需求走变更流程）：

1. **不提供托管的模型服务**：不内置任何云端 LLM 调用；`provider.type="llm"` 仅保留接口与降级路径。
2. **不要求也不可能要求 API Key**：任何命令、任何 CI job、任何测试都必须能离线通过；需要密钥的能力不在验收范围内。
3. **不做代码自动修复的运行时**：引擎只判定与产出 finding，不修改被检仓库的源码（唯一的写操作限于 `verification/**` 与 `RunResult` 输出）。
4. **不做通用 CI/CD 平台适配**：只提供 GitHub Actions 模板；GitLab CI、Jenkins、Azure Pipelines 等不在范围内。
5. **不复刻 `ocr` 的 LLM 提示词与模型行为**：适配层只复刻其**确定性**部分（文件选择、分组、规则匹配、降级），不声称与 `ocr` 模型输出逐字等价。
6. **不做性能/规模基准**：不承诺大仓库吞吐量、并发上限或内存指标；`maxFilesPerGroup=10` 等常量是契约值而非性能承诺。
7. **不做多租户、鉴权、审计日志持久化服务**：无数据库、无服务端、无账号体系。
8. **不做 UI/Dashboard**：交付物是 CLI + JSON 制品 + Markdown 文档，不含 Web 界面。
9. **不做门禁的自动豁免机制**：不允许在配置或 CLI 中“跳过/忽略”某个必需检查以达到 `overall_passed=true`；放宽门禁只能通过修改配置并重新运行（留痕）。
10. **不实现 `ocr` 本体**：不 fork、不修改 `alibaba/open-code-review` 源码；仅提供调用与本地降级实现。

---

## 6. 风险与开放问题

| 编号 | 风险 | 影响 | 处置 |
|---|---|---|---|
| R-001 | 沙箱拒绝在 `E:\ai-quality-gate` 创建目录（访问被拒） | 制品可能落在映射路径 `E:\Desktop\ai-quality-gate` | 由 captain 决定最终落盘根；docs 内所有路径均为相对路径，迁移不影响契约 |
| R-002 | `command` 检查依赖外部可执行文件 | 跨机器不可复现 | 契约限定测试仅使用 `node`；实现须支持 `command` 在可执行文件缺失时按 `onFail` 语义判定而非崩溃 |
| R-003 | 人类门禁依赖人工签署的 `approval.json` | 无人值守流水线无法自动通过 | 已由 REQ-016 的 `required` 解耦规则覆盖；CI 中人类门禁以制品存在性检查呈现 |
| R-004 | OCR 的 Recall 更低 | 少报缺陷 | 已在架构文档 §4.2 记录取舍，采用“多角度互补检查 + 高置信 finding 才阻断”的降噪策略 |

---

## 7. 验收自检清单

- [x] 需求 ID 数量 ≥12 且全文唯一（16 条，见 §4）。
- [x] 每条需求含：描述 / 可测验收标准 / 验证方式 / 优先级 / ≥1 testId。
- [x] P0、P1 需求全部挂 testId（16/16）。
- [x] 显式非目标章节（§5，10 条）。
- [x] 五阶段每阶段 7 要素齐备（见 `docs/01-architecture.md` §3）。
- [x] config / RunResult / evidence / trace-matrix 均以 fenced code block 给出机器可读示例与字段名列表，字段规格逐项写明，未以指向实现的措辞替代（见 `docs/01-architecture.md` §4、§5）。
- [x] 明确确定性 provider 由离线 fixture 驱动、真实 LLM 非必需（REQ-014 + 架构文档 §8.3）。
