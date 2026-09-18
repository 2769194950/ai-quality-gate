# 02 — AI-Native SDLC 五阶段门禁落地手册（qgate × OpenCodeReview）

| 字段 | 值 |
|---|---|
| 文档 ID | `docs/02-playbook.md` |
| Owner | docs-engineer（t4） |
| 上游契约 | `docs/00-requirements.md`（REQ-QUALITY-GATE-001…016）、`docs/01-architecture.md`（FROZEN：config/RunResult/账本/trace/CLI 四组契约） |
| 落地对象 | `packages/qgate/**`（确定性门禁引擎与 CLI）、`adapters/opencodereview/**`（OCR 适配层）、`demo/**`（五阶段可运行示例）、`.github/workflows/quality-gate.yml`（CI） |
| 实测环境 | 仓库根 `E:\Desktop\ai-quality-gate`；Node **v24.19.0**；Windows + 受限沙箱（**禁止管道 stdio**）；无网络、无 API Key |
| 实测时间窗 | 本地 2026-09-18 02:32–02:40（UTC 2026-09-17T18:32–18:40Z）。**本仓库此刻有成员在并发改动**（见 §7.3 与 §8 台账中标注 mtime 的条目），凡标 `⚠并发` 的结论须由 verifier 复核 |
| 引用原则 | 本手册只写**真实存在的文件与可执行的命令**；所有命令均已在本机实际执行，输出片段为粘贴原文（仅截断长行、并用 `…` 标注截断） |

> **怎么读这份手册**
> - 想立刻跑通：直接看 §6 端到端演练（每条命令都可复制粘贴）。
> - 想知道"谁来签字、看什么、怎么驳回"：看 §1.2–§1.3。
> - 想知道每个阶段到底卡什么：看 §2 的五张门禁卡（字段统一：目的 / 角色分工 / 进入条件 / 必需证据制品 / 退出条件 / 阻断判据 / 失败后的下一步）。
> - 想知道 OCR 那些工程手法怎么变成门禁：看 §3 映射表。
> - 想知道哪些是吹的、哪些是真做的：看 §7 能力边界与 §8 已知偏差台账。

---

## 1. 全景图：AI 编码段与质检段如何衔接

### 1.1 一条流水线，两段工作

AI-Native SDLC 的自然分工是两段：**AI 编码段**（Plan → Design → Build，产出物）与**质检段**（Review → Verify，产出"能不能放行"的判定）。本原型的衔接机制只有三条，其余都是细节：

1. **阶段是固定的、有序的、不可配置的**：`requirements → design → build → review → verify`（`packages/qgate/src/contract.mjs` 的 `stageOrder`；`qgate contract --check` 会断言它没漂移）。
2. **每段的出口是一个门禁（gate）**，门禁由 `checks[]`（七类确定性检查）+ 可选 `humanGate` 组成；门禁与整轮的判定只由确定性代码算出（`overall_passed`），**模型只能产出 finding，不能产出"通过"**。
3. **两段共用一种"语言"：退出码 + 证据制品**。`0=通过 1=门禁失败 2=配置错误 3=内部错误`；一切判定必须带 `evidence` 引用（`{path, kind, excerpt}`），没有证据的判定视为无效判定。

```
AI 编码段（产出物）                              质检段（产出判定）
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ requirements │ → │    design    │ → │    build     │ → │    review    │ → │    verify    │
│ Plan：做什么 │   │ Design：接口 │   │ Build：实现  │   │ Test：对抗式 │   │ 复算 + 放行  │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │                  │                  │
   [人类门禁 1]       [人类门禁 2]         （无门禁）        [人类门禁 3]        （无门禁）
  req-to-design      design-to-build                       review-to-verify
   role=product       role=architect                        role=reviewer
       │                  │                  │                  │                  │
       ▼                  ▼                  ▼                  ▼                  ▼
   gate req-spec   gate interface-frozen  gate build-     gate review-       gate verify-
                                         deterministic    counterexample     coverage
       └──────────────────┴──────────────────┴──────────────────┴──────────────────┘
                                      ↓ 每轮写出
        RunResult（stdout，8 个顶层字段） + 账本 ledger-<run_id>.json + ledger-index.json
                                      ↓
        qgate trace --write → trace-matrix.json（需求 ⇄ 测试 ⇄ 证据） → qgate report → report-<run_id>.md
                                      ↓
        CI：.github/workflows/quality-gate.yml（5 个 job，needs 链式，失败判据=退出码 1）
```

**衔接的两个硬约束**（实测可复现）：

- **阶段前缀语义**：`qgate check --stage <name>` 会执行"该阶段（含）之前"的全部门禁，**未执行的门禁不出现在 `gates[]` 里**（既不是 `passed:false` 也不是 `passed:true`，RunResult 的键集合因此不增长）；`overall_passed` 只对已执行的 `required` 门禁求值，所以**该阶段全通过时退出码是 0**。未执行的门禁只在 `--summary` 里以 `not-run <stage>/<gate>: excluded by the --stage/--gate filter` 行逐条列出（实测 `node packages/qgate/bin/qgate.mjs check --stage build --config demo/qgate.config.json --summary`：只打印 requirements/design/build 三行 + 2 条 not-run 行，退出码 0）。这是 CI 每个 job 能用"退出码 1"当失败判据的前提。
- **人类门禁按 stage 判定，而不是按门禁 id 判定**：被检门禁可以叫任意合法 id（例如 demo 里叫 `req-spec`），只要它位于 `requirements` 出口，其交接身份就由 stage 推导为 `req-to-design`，签字角色必须是 `product`（`packages/qgate/src/config.mjs` 的 `handoverPositionForStage` + `packages/qgate/src/human-gate.mjs`）。

### 1.2 人类门禁恰好三处

合法位置**只有**下表三处（`docs/01-architecture.md` §3.2；`packages/qgate/src/contract.mjs` 的 `humanGates`）。其他位置出现 `humanGate` ⇒ 配置错误，退出码 2。

| # | 交接点 | 交接 id | 签字角色 | 签字制品（默认路径） | 看什么证据 | 驳回方式 |
|---|---|---|---|---|---|---|
| 1 | requirements → design | `req-to-design` | `product` | `verification/approvals/req-to-design/approval.json`（demo 实例：`demo/mini-service/.qgate/approvals/req-to-design/approval.json`） | 需求 ID 唯一性/数量、`testIds` 覆盖、非目标章节；`claims[]` 里每条 claim 挂 `testIds` | `decision:"rejected"` 或 `"revise"` |
| 2 | design → build | `design-to-build` | `architect` | `verification/approvals/design-to-build/approval.json`（demo 实例：`demo/mini-service/.qgate/approvals/design-to-build/approval.json`） | 接口字段名/类型齐备（demo：`openapi.yaml` 的 5 个冻结字段）、规则优先级冻结、schema 与文档一致 | 同上 |
| 3 | review → verify | `review-to-verify` | `reviewer` | `verification/approvals/review-to-verify/approval.json`（demo 实例：`demo/mini-service/.qgate/approvals/review-to-verify/approval.json`） | 反例是否真的退出 2、finding 是否按 severity/confidence 分级、是否存在绕过路径 | 同上 |

签字制品的字段是冻结的（`docs/01-architecture.md` §9.1）：`schemaVersion / gateId / role / decision / approvedBy / approvedAt / claims[] / notes?`。**上表第 4 列的根实例路径是契约默认值**（`approvalRecord` 的默认位置）——本仓库根的 `verification/approvals/**` 当前**不存在**（见 §7.2 与 §8 台账条目 10），三条有真实签字记录的都在 demo 夹具里：

- `req-to-design`：`approvedBy:"product-owner"`，claim `requirements-scope-frozen`（`testIds:["T-QG-001","T-QG-002","T-QG-003"]`）；
- `design-to-build`：`approvedBy:"architect"`，claim `interface-field-names-frozen`（`testIds:["T-QG-004","T-QG-016"]`）；
- `review-to-verify`：`approvedBy:"reviewer"`，claim `counterexamples-recorded`（`testIds:["T-QG-008","T-QG-012"]`）。

两条容易踩的规则：

- **`humanGate` 可以少于 3 处**：缺失处计入 `approvals_missing`（本仓库根配置没有人类门禁，实测 `approvals_missing: 3`）。渐进落地允许先从 1 处开始，**但 `verify` 阶段必须始终存在**。
- **`humanGate.required` 不存在**：门禁自身的 `required` 与人类门禁的 `enforcement`（枚举只有 `blocking`）语义解耦（REQ-016）。人类门禁未批准时产生 `severity:"blocker"` 的 blocker，与 `required` 无关。

### 1.3 每一处人类门禁的驳回与重做流程

流程本身很短，关键是**驳回必须留证**、**重做必须从被驳回的阶段重跑**：

```
① 门禁跑出 blocker（HUMAN_GATE_NOT_APPROVED: … state=missing|rejected|role_mismatch: …）⇒ overall_passed=false ⇒ 退出码 1
② 签字人把 decision 写成 rejected / revise（并写 approvedBy / approvedAt / claims / notes）
③ 责任 owner 依据 blocker.checkId + evidence 修制品；禁止用「跳过检查」消解 finding（docs/00-requirements.md 非目标 9）
④ 重跑该阶段及其之后：qgate check --stage <被驳回阶段> …（人类门禁通过后，后续阶段才会被判为可执行）
⑤ 终审角色重新签署：decision:"approved" + approvedBy + approvedAt ⇒ 该门禁 passed=true
⑥ 证据留档：新账本 ledger-<run_id>.json 追加进 ledger-index.json；驳回记录不得被删除
```

**实测（最小复现仓库，放在系统临时目录，不污染 demo）**：改 `decision` 三态各跑一次 `qgate check --config <tmp>/qgate.config.json --summary`：

| `decision` | `overall_passed` | `humanGate` | blockers | 退出码 |
|---|---|---|---|---|
| `rejected` | `false` | `"rejected"` | 1 | **1** |
| `revise` | `false` | `"rejected"` | 1 | **1** |
| `approved` | `true` | `"approved"` | 0 | **0** |

`rejected` 时的 blocker 原文（`--json` 输出，实测粘贴）：

```json
{
  "checkId": "req-spec",
  "severity": "blocker",
  "message": "HUMAN_GATE_NOT_APPROVED: gate \"req-spec\" requires role \"product\" to approve approvals/req-to-design/approval.json (state=rejected: approval decision is \"rejected\")",
  "evidence": [
    {
      "path": "approvals/req-to-design/approval.json",
      "kind": "file",
      "excerpt": "approvalState=rejected approvedBy=product-owner approvedAt=2026-05-04T09:00:00Z (approval decision is \"rejected\")"
    }
  ]
}
```

注意 `decision:"revise"` 的观测状态也是 `"rejected"`（枚举 `approvalStates = approved|missing|rejected|role_mismatch`，`revise` 归入 `rejected` 桶）——**驳回语义要在 `notes` 里写清是"改后重签"还是"彻底否掉"**，否则审计时两种驳回无法区分。

---

## 2. 逐阶段门禁卡（五张，字段统一）

卡片字段固定为七项：**目的 / 角色分工（人、确定性代码、AI）/ 进入条件 / 必需证据制品 / 退出条件 / 阻断判据 / 失败后的下一步**。

**读卡说明**：本原型有两套正在使用的实例——① **demo 实例** `demo/qgate.config.json`（被检仓库根 = `demo/mini-service/`，输出走 `.qgate/**`），② **本仓库根实例** `qgate.config.json`（被检仓库根 = 仓库根，输出走 `verification/**`）。下文 check id 与证据路径同时给出两套；完整对照见 §附录 A。

### 卡片 1 — `requirements`（Plan）

| 字段 | 内容 |
|---|---|
| **目的** | 冻结"做什么 / 不做什么"，让后面所有门禁都有一个可追溯的需求 ID 基准；把"接受标准是否可测"从人的印象变成可被正则与 JSON 断言读出的制品。 |
| **角色分工** | **人**（`product`）：签署 `req-to-design`，只对范围与优先级负责，不对实现方式负责。**确定性代码**：门禁 `req-spec` 的 `req-doc-exists` / `req-ids-present` / `req-index-valid`（demo：≥4 个唯一 `REQ-DEMO-\d{3}`；本仓库根：≥16 个唯一 `REQ-QUALITY-GATE-\d{3}`，且 `docs/requirements-index.json` 的 `/requirements/0/id` 必须匹配 `^REQ-QUALITY-GATE-\d{3}$`）。**AI**：只产出 finding（需求是否可测、措辞是否含糊、非目标是否缺失），不得产出通过。 |
| **进入条件** | 需求文档与机器可读索引已存在（demo：`demo/mini-service/REQUIREMENTS.md`、`demo/mini-service/.qgate/requirements-index.json`；本仓库根：`docs/00-requirements.md`、`docs/requirements-index.json`）；`provider` 可初始化（`deterministic`，或 `llm/external` 不可用时降级并置 `provider.degraded=true`）。 |
| **必需证据制品** | `demo/mini-service/REQUIREMENTS.md`（sha256 + 匹配行样本）｜`demo/mini-service/.qgate/requirements-index.json`（JSON Pointer 断言结果）｜`demo/mini-service/.qgate/approvals/req-to-design/approval.json`（签字记录）｜`demo/mini-service/.qgate/evidence/ledger-<run_id>.json` + `ledger-index.json`（本阶段每条 check 的账本条目）。本仓库根实例：`docs/00-requirements.md`、`docs/requirements-index.json`、`verification/evidence/ledger-<run_id>.json`。 |
| **退出条件** | `node packages/qgate/bin/qgate.mjs check --stage requirements --config demo/qgate.config.json --json` 退出码 0；`gates[0].passed=true`；`gates[0].humanGate.approvalState=="approved"`（实测上游 §6.2 全流水线输出中 `"humanGate": "approved"`）。 |
| **阻断判据** | `FILE_MISSING`（需求文档/索引缺失，demo 实测：`FILE_MISSING: docs/00-requirements.md matched 0 file(s), minCount=1`）｜`REGEX_MISMATCH`（唯一 ID 数 < `minMatches`）｜`JSON_ASSERT_FAILED`（`/schemaVersion != "1.0"`、`/requirements/0/id` 不匹配）｜`HUMAN_GATE_NOT_APPROVED`（`approvalState ∈ {missing,rejected,role_mismatch}`）。 |
| **失败后的下一步** | 按 `blocker.checkId` 定位到唯一制品 → 修制品（补 ID、补 `testIds`、修索引）→ 重跑 `--stage requirements` → `product` 在 `approval.json` 写入 `decision/approvedBy/approvedAt/claims` → 才能进入 design。**任何情况下不得通过"跳过检查"消解 finding**（`docs/00-requirements.md` 非目标 9）。 |

### 卡片 2 — `design`（Design）

| 字段 | 内容 |
|---|---|
| **目的** | 把需求转译为**可直接实现**的接口契约（字段名 + 类型 + 枚举 + 退出码）并冻结，使"实现有没有跑偏"成为机器可判定的问题。 |
| **角色分工** | **人**（`architect`）：签署 `design-to-build`，冻结接口字段名。**确定性代码**：门禁 `interface-frozen` 的 `interface-exists`（`openapi.yaml` 存在）/ `interface-fields`（5 个冻结字段名 `requestId|traceId|amount|currency|Idempotency-Key` 唯一命中 ≥5）/ `rule-file-exists`（`.opencodereview/rule.json` 存在）/ `no-loose-ends`（`TODO.md` 不存在，`required:false` ⇒ 只记录）；本仓库根实例另有 `contract-doc-exists` / `contract-fields-present` / `schemas-exist`（`schemas/*.schema.json` ≥4）。**AI**：契约歧义/不可实现 finding，不产出通过。 |
| **进入条件** | requirements 阶段门禁通过（含 `req-to-design` 已 `approved`）；被检仓库存在可冻结的接口描述文件。 |
| **必需证据制品** | `demo/mini-service/openapi.yaml`（sha256 + 字段名匹配行：实测 `L16:Idempotency-Key \| L45:requestId \| L67:requestId`）｜`demo/mini-service/.opencodereview/rule.json`｜`demo/mini-service/.qgate/approvals/design-to-build/approval.json`。本仓库根实例另有：`docs/01-architecture.md`、`schemas/config.schema.json`、`schemas/run-result.schema.json`、`schemas/evidence-ledger.schema.json`、`schemas/trace-matrix.schema.json`。 |
| **退出条件** | `node packages/qgate/bin/qgate.mjs check --stage design --config demo/qgate.config.json --json` 退出码 0；`interface-frozen.passed=true`；`humanGate.approvalState=="approved"`（实测四阶段命令退出码均为 0）。 |
| **阻断判据** | `FILE_MISSING`（接口/规则文件缺失）｜`REGEX_MISMATCH`（`uniqueMatches < minMatches=5`，demo 实测正常值 `uniqueMatches=5 totalMatches=21`）｜`HUMAN_GATE_NOT_APPROVED`。注意 `no-loose-ends` 是 `required:false` + `severity:"medium"` ⇒ **失败也不阻断**（`onFail` 默认 `fail`，但不进 `blockers`）。 |
| **失败后的下一步** | 字段改名属"公共接口变更" ⇒ **在环内自动修复次数为 0**（`docs/01-architecture.md` §4.3）：暂停流水线 → `architect` 决策（`decision:"revise"`）→ 同步改 `openapi.yaml` + 上游契约与 schema（本仓库根实例还要改 `docs/01-architecture.md` 与 `schemas/**`）→ **从 design 阶段重跑**（不允许只重跑 build 掩盖契约漂移）。 |

### 卡片 3 — `build`（Build）

| 字段 | 内容 |
|---|---|
| **目的** | 实现冻结契约，并证明"零依赖 / 离线 / 确定性"三条硬属性成立——把工程属性变成可复算的断言，而不是"我们说它是确定的"。 |
| **角色分工** | **人**：本阶段**没有人类门禁**，人只处理升级项（`docs/01-architecture.md` §4.3 三段式升级）。**确定性代码**：门禁 `build-deterministic` 的 `no-dep`（`/dependencies == {}`、`/type == "module"`）/ `command-smoke`（`node --version` 退出 0，`stdoutRegex:"^v\\d+\\."`）/ `test-results-threshold`（`.qgate/evidence/test-results.json` 的 `/passed == 42`、`/failed == 0`）/ `no-network-surface`（策略 `SAFE_003`）；本仓库根实例另有 `unit-tests`（≥4 个 `packages/qgate/test/*.test.mjs`）/ `contract-check`（`qgate contract --check` 必须打印 `contract self-check: OK`）/ `no-bypass`（`CONTRACT_001`）/ `no-secret-paths`（`SAFE_002`）。**AI**：可读性/异味 finding，只有 `high` 以上才阻断。 |
| **进入条件** | design 阶段门禁通过（含 `design-to-build` 已 `approved`）；`node` 可用且 ≥18（本仓库 `packages/qgate/package.json` 无 `dependencies`）。 |
| **必需证据制品** | `demo/mini-service/package.json`｜`demo/mini-service/.qgate/evidence/test-results.json`｜`packages/qgate/bin/qgate.mjs`｜`packages/qgate/test/*.test.mjs`（4 个套件）｜`demo/mini-service/.qgate/evidence/ledger-<run_id>.json` + `ledger-index.json`。 |
| **退出条件** | `node packages/qgate/bin/qgate.mjs check --stage build --config demo/qgate.config.json --json` 退出码 0；`build-deterministic.passed=true`；两个测试套件全绿（写稿首次实测：引擎 tests 60 / pass 60 / fail 0，适配层 tests 57 / pass 57 / fail 0；**最后一次复核时套件因成员并发改动转红，见 §6.12 与 §8**）。 |
| **阻断判据** | `FILE_MISSING`｜`COMMAND_FAILED`（`node --version` 非 0 或 stdout 不匹配 `^v\d+\.`）｜`JSON_ASSERT_FAILED`（`dependencies` 非空、`type != "module"`、测试结果非绿）｜`POLICY_VIOLATION_SAFE_003`（出现 `fetch(` / `net.` / `https.request` 等网络调用面）。 |
| **失败后的下一步** | 语法/格式/文档/证据路径类 ⇒ 在环内快修，同一 finding ≤2 次自动尝试；逻辑缺陷、测试缺失 ⇒ 在环内快修 ≤2 次，超预算升级为 `high` 并交人裁决（`fix-budget-in-loop.json` 实测：`F-0001` 两次尝试失败 ⇒ `escalate:true`，`reason:"FIX_BUDGET_EXCEEDED: logic defect survived 2 in-loop attempts"`，`nextPhase:"post-gate"`）；修完重跑 build 及其之后阶段。 |

### 卡片 4 — `review`（Test / 对抗式评审）

| 字段 | 内容 |
|---|---|
| **目的** | 用对抗式方法**推翻**前面阶段的结论：契约是否与实现一致、声称是否被代码强制、门禁能否被绕过。这一阶段的产出不是"更好看"，而是"哪里会漏"。 |
| **角色分工** | **人**（`reviewer`）：签署 `review-to-verify`，判断"是否允许进入验证"。**确定性代码**：门禁 `review-counterexample` 的 `negative-fixtures`（`.qgate/negative/*.json` ≥1）/ `invalid-must-fail`（`/exitCode == 2` 且 `/error/code == "CONFIG_INVALID"`）/ `severity-mix`（`.qgate/evidence/ocr-findings.json` 的 `/threshold == 0.7`、`/findings/0/severity == "high"`、`/findings/0/confidence == 0.86`）/ `no-bypass`（策略 `CONTRACT_001`）；本仓库根实例另有 `provider-fixtures`（离线 provider 录制文件存在）。**AI**：默认怀疑的找茬 finding；finding 必须带文件 + 行号，否则视为不可定位。 |
| **进入条件** | build 阶段门禁通过；`.qgate/negative/`（本仓库根实例：`packages/qgate/examples/invalid/`）里已有反例制品。 |
| **必需证据制品** | `demo/mini-service/.qgate/negative/unknown-check-type.result.json`｜`demo/mini-service/.qgate/negative/secret-include.result.json`｜`demo/mini-service/.qgate/evidence/ocr-findings.json`｜`demo/mini-service/.qgate/evidence/fix-budget-in-loop.json`｜`demo/mini-service/.qgate/evidence/fix-budget-post-gate.json`｜`demo/mini-service/.qgate/approvals/review-to-verify/approval.json`。 |
| **退出条件** | `node packages/qgate/bin/qgate.mjs check --stage review --config demo/qgate.config.json --json` 退出码 0；`review-counterexample.passed=true`；无未处置的 `blocker`/`high` finding；`humanGate.approvalState=="approved"`。 |
| **阻断判据** | `FILE_MISSING`（反例制品缺失）｜`JSON_ASSERT_FAILED`（非法配置没有以退出码 2 收场、finding 台账阈值被改）｜`POLICY_VIOLATION_CONTRACT_001`（check.type/stage/字段名漂出冻结枚举）｜`HUMAN_GATE_NOT_APPROVED`；任何"绕过路径"（例如把必需检查改成 `required:false` 来消解 finding）视为阻断。 |
| **失败后的下一步** | 判定为**误报** ⇒ 必须留下驳回记录（`findingId`、`rejectedBy`、`reason`、`evidence`），禁止静默忽略 ⇒ 门禁可继续；判定为**真缺陷**且属公共接口/安全不变量 ⇒ 禁止原地自动修复（0 次），暂停流水线 + 人类裁决（`decision:"revise"`）+ 从所属阶段重跑（`fix-budget-post-gate.json` 实测 `F-0004`：`"repair": "not applied: the security invariant must stay enforced…"`，`"status":"rejected"`）。 |

### 卡片 5 — `verify`（Test → 可发布性）

| 字段 | 内容 |
|---|---|
| **目的** | 在干净环境复跑，用**可复算的证据**证明交付物真实可用、可发布：账本哈希能复算、需求能追到测试、安全不变量仍成立。 |
| **角色分工** | **人**（`reviewer` 的 `review-to-verify` 是入场券；终审放行者还是人）：读 `verification/`（本仓库）或 `demo/mini-service/.qgate/reports/` 下的报告后放行。**确定性代码**：门禁 `verify-coverage` 的 `trace-complete`（`trace_matrix`, `enforce:"strict"`, `testIdSource:"ledger-index"`）/ `coverage-threshold`（`.qgate/evidence/coverage.json`：`/lineCoverage` 匹配 `^0\.9`、`/branches/covered` 存在）/ `no-secret-paths`（`SAFE_002`）/ `no-key-reads`（`SAFE_001`）。**AI**：只做风险归类说明，**不得把未验证项写成通过**。 |
| **进入条件** | review 阶段门禁通过（含 `review-to-verify` 已 `approved`）；账本与 trace 矩阵已生成（`qgate trace --write` 或 CI 三段式的前两步）。 |
| **必需证据制品** | `demo/mini-service/.qgate/trace-matrix.json`｜`demo/mini-service/.qgate/evidence/coverage.json`｜`demo/mini-service/.qgate/evidence/ledger-index.json`｜`demo/mini-service/.qgate/evidence/ledger-<run_id>.json`｜`demo/mini-service/.qgate/reports/report-<run_id>.md`。本仓库根实例：`verification/trace-matrix.json`、`verification/evidence/ledger-index.json`、`verification/evidence/ledger-<run_id>.json`。 |
| **退出条件** | `node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json` 退出码 0 且 `overall_passed=true`（5/5 门禁 passed）；`trace-complete` 的 `covered=6/6`（demo）/`covered=16/16`（本仓库根与 CI 实例，实测）；`ledger-index.json` 中 `ledgers[].sha256` 与该账本文件真实 sha256 一致。 |
| **阻断判据** | `TRACE_GAP`（trace 矩阵缺失/不可解析，或 P0/P1 需求 `covered=false`）｜`FILE_MISSING`｜`JSON_ASSERT_FAILED`（`lineCoverage < 0.9`）｜`POLICY_VIOLATION_SAFE_001` / `POLICY_VIOLATION_SAFE_002`｜`EVIDENCE_UNRESOLVED`（证据引用不可解析）。 |
| **失败后的下一步** | `TRACE_GAP` ⇒ **顺序不可颠倒**：先跑一次完整流水线把 16 个 testId 写进 `ledger-index.json`（这一步因 trace 缺失**预期失败、退出码 1**）→ `qgate trace --write`（此时才算出 `covered=16/16`）→ 再跑一次完整流水线作为权威判定（退出码 0）。实测反例：`--stage review` 预热只写满 15/16，`--stage build` 只写满 12/16。｜账本哈希不一致 ⇒ 重新生成制品并复算，不得手工改 `sha256`。｜出现无法离线验证的断言 ⇒ 记为 `blocked`，**不是通过**。 |

---

## 3. OCR 工程手法 → 阶段门禁映射表

来源：`docs/00-requirements.md` §"外部实践"与 `docs/01-architecture.md` §1（对 `alibaba/open-code-review` 的确定性命中项）。第三列是**逐字取自真实配置**的 check 片段（`demo/qgate.config.json` 或本仓库根 `qgate.config.json`），第五列如实标注强制强度——**没有对应 check 的手法不会被说成"已被门禁覆盖"**。

| # | OCR 手法（本原型复刻位置） | 命中阶段 / 门禁 | 对应 check 配置（真实） | 为什么能减少误报 | 强制强度 |
|---|---|---|---|---|---|
| 1 | 纯确定性文件选择（复刻 `internal/agent/selection.go`；`--preview` 与真实执行同源）—— `adapters/opencodereview/src/selection.mjs`、`packages/qgate/src/selection.mjs` | `verify` / `verify-coverage` | `{"id":"no-secret-paths","type":"policy","required":true,"severity":"high","policyId":"SAFE_002","onFail":"fail"}` | 选择结果可复算（实测同一命令两次运行输出 sha256 完全相同：`B3304EC0…E00F03`），被选集合不含密钥/二进制/默认排除目录 ⇒ 从源头消灭"密钥泄露""二进制乱码""构建产物过期"三类假缺陷；且 preview 与执行同源 ⇒ 不会出现"预览没看到、执行才报"的不一致结论（实测 `qgate preview` 跨 cwd 逐叶子比对 349/349 一致） | 间接（策略断言的是选择面不变量） |
| 2 | 密钥路径检查**先于**用户 `include`，且内置敏感路径**不可被 include 重新纳入**（`adapters/opencodereview/src/filters.mjs` 的 `classifyFile` step 0） | `verify` / `verify-coverage` | `{"id":"no-key-reads","type":"policy","required":true,"severity":"high","policyId":"SAFE_001","onFail":"fail"}` | 实测最宽泛 include（`--include '**/*' --include '.env*' --include 'secrets/**'`）下 `selected` 中密钥类路径 = **0** 条，`.env.production` 稳定落在 `selection.excluded`（`reason:"sensitive_path_never_included"`）⇒ 密钥永远不进评审上下文，因此不可能把"上下文里出现 key 字样"报成缺陷，也不会把安全不变量误判成"可自动修复" | 间接（策略断言选择面；实测适配层 `safety.no_sensitive_selected=true`） |
| 3 | `FileGroup` 分组，每组文件数 ≤ `MAX_FILES_PER_GROUP`（=10，硬钳制）—— `adapters/opencodereview/src/grouping.mjs`、`packages/qgate/src/grouping.mjs` | `review` / `review-counterexample` | `{"id":"severity-mix","type":"json_assert","required":true,"severity":"high","file":".qgate/evidence/ocr-findings.json","assertions":[{"pointer":"/threshold","equals":0.7},{"pointer":"/findings/0/severity","equals":"high"},{"pointer":"/findings/0/confidence","equals":0.86}]}` | 单次评审上下文被限制在 ≤10 文件，抑制长上下文导致的"泛化式"误报；同时 finding 台账的 `threshold/severity/confidence` 形状被门禁钉死 ⇒ 含糊结论无法通过门禁（实测 `--max-files 50` 仍被硬钳到 10，`grouping.invariant_ok=true`） | 间接（上下文规模）+ 直接（台账形状） |
| 4 | 超 token 预算整组**降级为单文件桶**、分组失败**回退 per-file**（不产生"半个结论"） | `review`（finding 台账）+ `build`（工具链前提） | `{"id":"command-smoke","type":"command","required":true,"severity":"high","run":["node","--version"],"expectExitCode":0,"timeoutMs":60000,"captureStdout":true,"stdoutRegex":"^v\\d+\\."}` | 降级/回退让"要么完整、要么显式留痕"（实测 `--token-budget 300` ⇒ 14 组中 12 组降级，`downgrade_reason:"token_budget_exceeded"`，`invariant_ok=true`），不会产生半截结论；build 的 `command-smoke` 是同一原则的机器化落地——工具链不可用就在 build 阶段显式失败，而不是让后续阶段靠猜 | 间接（同一原则，对象不同；`downgrade_reason` 目前**没有** check 断言） |
| 5 | 四层规则匹配，`.opencodereview/rule.json` 优先级 `--rule` > 项目 > 用户 > 内置，**第一条匹配生效**（`adapters/opencodereview/src/rules.mjs`、`packages/qgate/src/rules.mjs`） | `design` / `interface-frozen` | `{"id":"rule-file-exists","type":"file_exists","file":".opencodereview/rule.json","required":true,"severity":"high"}` | 判定规则确定化 ⇒ 同一文件不会因层间竞争得出两种结论（消除"同一文件一会通过一会不通过"的随机误报）；规则文件缺失是**显式失败**而不是"没命中任何规则"的静默降级（实测适配层输出 `rules.layer_trace` 四层 priority 1/2/3/4，命中层 `ruleSource:"cli:--rule"`，`priority:1`） | 间接（锚文件存在性 + 规则链确定序） |
| 6 | 行号定位（引擎实现：`regex` / `policy` 证据带 1-based 行号）；行号 **re-tracking**（OCR 原始语义） | `requirements` / `req-spec`；`review` / `review-counterexample` | `{"id":"req-ids-present","type":"regex","required":true,"severity":"high","files":["REQUIREMENTS.md"],"pattern":"REQ-DEMO-\\d{3}","flags":"gm","mode":"count","minMatches":4,"countMode":"unique"}` | 证据直接带行号与片段（实测证据原文：`REQUIREMENTS.md #file :: 7 match(es); L9:REQ-DEMO-001 \| L18:REQ-DEMO-002 \| L24:REQ-DEMO-002`）⇒ 人可一步复核，"报告位置错了"这类假缺陷当场被证伪。**但 re-tracking 本身未实现**（见 §7.2）：适配层没有定位模块，`reflection.mjs` 只把 `(file,line,message)` 当去重键 | 直接（引擎侧行号证据）；适配层侧 = **未实现** |
| 7 | reflection / suggestion validation（离线规则化复刻，`adapters/opencodereview/src/reflection.mjs`） | `review` / `review-counterexample` | 同 #3 的 `severity-mix`（消费 `.qgate/evidence/ocr-findings.json`） | 建议在产出前被独立复核：`R-VALID-PATH` / `R-FORBIDDEN-PATH` / `R-NONEMPTY-MESSAGE` / `R-EVIDENCE-REQUIRED` / `R-DEDUP` / `R-SEVERITY-ENUM` 六条规则任一不通过即丢弃 ⇒ 无法定位、无证据、重复的建议不会进入台账；夹具用 `confidence ≥ threshold(0.7)` 且 `severity ∈ {high, blocker}` 才升级为 blocker 复刻该语义（实测 `F-0003` confidence 0.55 ⇒ `downgradeReason:"confidence_below_threshold"`） | **未接线**：`reflection.mjs` 目前只被 `adapters/opencodereview/test/ocr-runner.test.mjs` 引用，未接入任何 CLI 路径；语义只在夹具与 `severity-mix` 上体现 |
| 8 | 失败降级：`ocr` 缺失 / 超时 / 非零退出 / 输出非 JSON ⇒ 降级为本地确定性实现并置 `degraded:true` + 原因枚举（`adapters/opencodereview/src/ocr-runner.mjs` 的 `DEGRADE_REASONS`） | `build` / `build-deterministic` | `{"id":"no-network-surface","type":"policy","required":true,"severity":"high","policyId":"SAFE_003","onFail":"fail"}` | 降级让"环境问题"表现为显式留痕而不是崩溃或静默跳过（实测 `degraded:true, degraded_reason:"OCR_CLI_NOT_FOUND", llm_called:false`）⇒ 不会把环境失败报成代码缺陷；`SAFE_003` 断言实现里没有网络调用面（实测 `metrics={"filesScanned":42,"violations":0,…}`）⇒ 排除"悄悄联网重试"这类不可复现路径 | 间接（策略）+ 直接（降级留痕） |
| 9 | Delegation Mode（不自己调 LLM，把筛选与规则解析结果交给 Host Agent） | `design` / `interface-frozen` | `{"id":"interface-fields","type":"regex","required":true,"severity":"high","files":["openapi.yaml"],"pattern":"requestId\|traceId\|amount\|currency\|Idempotency-Key","flags":"gm","mode":"count","minMatches":5,"countMode":"unique"}` | Delegation 的前提是"判定输入"本身就是字段名冻结、机器可读的产物；`interface-fields` 强制契约字段名齐备（实测 `uniqueMatches=5 totalMatches=21`）⇒ Host Agent 拿到的输入不会因字段缺失而被误读成缺陷 | **未接线**：本原型没有 `--delegation` 开关，只有 JSON 输出面（`qgate preview --json`、`ocr-preview --json`、`qgate contract --json`） |

**表外诚实说明**：映射表里 4/9 条标注了"未接线/未实现"。这不是偷懒的措辞，而是便于 verifier 直接对准缺口：`#4` 的降级留痕、`#6` 的 re-tracking、`#7` 的 reflection、`#9` 的 Delegation Mode 目前都**不能**由现有 check 端到端断言（详见 §7.2 与 §8）。

---

## 4. 反馈闭环与降噪

### 4.1 AI 修复预算：在环内快修 vs 门禁后修复

预算表取自 `docs/01-architecture.md` §4.3，落到本原型的**留痕文件**是 `demo/mini-service/.qgate/evidence/fix-budget-in-loop.json` 与 `fix-budget-post-gate.json`（字段：`policy.inLoopMaxAttempts / policy.postGateMaxAttempts / findings[].attempts[] / escalate / reason / nextPhase`）。

| finding 类别 | 修复时机 | 预算 | 超预算动作 | 留痕 |
|---|---|---|---|---|
| 语法/格式/文档错别字/证据路径 | 在环内快修（当次门禁内） | 同一 finding ≤2 次自动尝试 | 第 3 次 ⇒ `escalate:true`、`reason` 含 `FIX_BUDGET_EXCEEDED` | `fix-budget-in-loop.json` |
| 逻辑缺陷、测试缺失 | 在环内快修 | ≤2 次 | 升级为 `high` 并阻断相位推进，交人裁决 | 同上（实测 `F-0001`：两次尝试 `failed` ⇒ `nextPhase:"post-gate"`） |
| 公共接口字段名/类型变更、安全不变量（密钥路径、include 覆盖） | **禁止原地自动修复** | **0 次** | 暂停流水线，人类签署决策（`decision:"revise"`，记入 `approvals/<gateId>/approval.json` 与 `fix-budget-post-gate.json` 的 `authorizedBy/authorizedAt`），修复后**从所属阶段重跑** | `fix-budget-post-gate.json` |
| `blocker` 级且无法定位根因 | 提交门禁后人工介入 | 0 次 | 阻断并留证（`reports/`） | 同上 |

**核心原则**：**在环内快修的只有"改了不会改变契约"的东西**。一旦涉及公开接口或安全不变量，自动修复的期望收益小于它破坏既有结论的概率，所以预算是 0 而不是 2。

### 4.2 finding 分级与"真实缺陷"判据

| 级别 | 阻断相位推进 | 真实缺陷判据（必须**全部**满足） |
|---|---|---|
| `blocker` | 是 | 可复现步骤存在 + 违反冻结契约（字段名/类型/退出码/安全不变量）+ 证据路径可解析 |
| `high` | 是 | 可复现 + 影响验收标准成立（例如确定性被破坏、遥测发网）+ 证据可解析 |
| `medium` | 否（记技术债） | 影响可维护性/可读性，无法证明违反验收标准 |
| `low` | 否（仅记录） | 风格/措辞，无功能影响 |

落地方式：门禁通过与否只由**必需检查**决定——`required===true && passed===false && onFail!=='warn'` 才产生 blocker（`packages/qgate/src/core.mjs`）；`severity` **不参与**阻断判定，只决定 finding 的呈现顺序与升级路径（`docs/01-architecture.md` §5.1 裁决：**`required` 决定门禁通过与否，`severity` 只决定如何呈现与升级**），唯一的显式非阻断通道是 `onFail:"warn"`。`medium/low` 只出现在 `checks[]` 里，供技术债看板消费。**误报不等于缺陷**：不能复现的"缺陷"直接按 §4.4 处置，而不是降低判据。

### 4.3 升级政策（三段式）

```
auto-fix(≤2)  ──超预算/越界──▶  human-adjudication(阻断 + 签字)  ──仍无法收敛──▶  block-release(仅人类可解除)
```

- `auto-fix`：AI/工程师在环内修，最多 2 次，每次必须重跑所属阶段；
- `human-adjudication`：流水线暂停，对应角色（`product`/`architect`/`reviewer`）在签字制品里写决策；
- `block-release`：`overall_passed=false` 一直保持，除非人修改制品并重新签字。
- **红线**：任何阶段都不得用"跳过检查"（改 `required:false`、改 `onFail:"warn"`、删 check）来消解 finding —— 对应 `docs/00-requirements.md` 非目标 9 与 `CONTRACT_001` 策略检查。

### 4.4 误报申诉通道

任何被判定为误报的 finding 必须留下一条**驳回记录**，字段固定（`docs/01-architecture.md` §4.4）：`findingId`、`rejectedBy`、`reason`、`evidence`。

- 没有驳回记录的 finding 视为**未处置**，不因"人说了是误报"而消失；
- 驳回记录与 `fix-budget-post-gate.json` 的 `decision:"rejected"` 条目互为佐证（实测 `F-0004` 的 `"notes":"Recorded as a rejection record so the finding is not silently ignored"`）；
- 驳回动作本身要进度量（§5 指标 7：误报率），否则"降噪"无法被检验；
- 禁止静默忽略（`docs/01-architecture.md` §4.4 原文）。

---

## 5. 可度量指标与看板

口径原则：**能用现有制品算的才算"已实现"**；算不出来的写清缺什么，不用估算糊过去。取数文件均为真实路径。

| # | 指标 | 定义 | 计算口径（分子/分母 + 取数字段） | 当前可算性 |
|---|---|---|---|---|
| 1 | 门禁通过率 | 整轮流水线判定为通过的比例 | `passed_runs / total_runs`，其中 `passed_runs = |{r : ledgers[r].overall_passed == true}|`；取数 `demo/mini-service/.qgate/evidence/ledger-index.json` 或 `verification/evidence/ledger-index.json` 的 `ledgers[]` | **已实现**（`ledger-index.json` 已含 `overall_passed`） |
| 2 | 平均门禁时长 | 一轮五阶段端到端耗时均值（毫秒） | `mean(ledger.finished_at − ledger.started_at)`，或直接用 `RunResult.duration_ms`；取数 `ledger-<run_id>.json` 的 `started_at/finished_at` | **已实现（整轮 + 单 check）**：`ledger-<run_id>.json` 的 `entries[].durationMs` 实测取值集合为 `121 / 0 / 31 / 1 / 29 / 2` 毫秒（既非恒 0，也非每个 check 都非 0；`packages/qgate/src/core.mjs:236` 在每个 check 前后打点），整轮耗时用 `started_at/finished_at` 或 `RunResult.duration_ms` |
| 3 | 每 PR 的 token / 成本 | 一次变更集消耗的模型 token 与折算成本 | token 代理口径：`Σ groups[].tokens`（`qgate preview --json`）+ `Σ groups[].estimated_tokens`（`ocr-preview --json`）；成本 = `Σ tokens × 单价`（需 provider 侧记账） | **部分已实现**：本原型 `provider.type="deterministic"`，实测 `llm_called:false`、`degraded_reason:"OCR_CLI_NOT_FOUND"` ⇒ **真实 token/成本恒为 0 且不可测**；只有"预算占用"可算。真实成本需接 `llm` provider 并落账（§7.3） |
| 4 | blocker 中真阳性占比 | 阻断项里"真缺陷"的比例（降噪效果的核心指标） | `true_positive_blockers / all_blockers`；`all_blockers` 取 `RunResult.gates[].blockers[]`（记入账本 `entries[]`），真阳性按 §4.2 判据逐条判定 | **指标已定义，标注数据未实现**：需要 finding 台账的 `rejected` 记录（§4.4）来提供分母里的"误报"侧；当前只有 `fix-budget*.json` 的少量人工条目 |
| 5 | 逃逸缺陷数 | 放行后才发现、本应由门禁拦住的缺陷数 | `escaped / releases`；`releases` = `overall_passed=true` 的账本数；`escaped` = 其后新增的、指向已放行制品的 `blocker` 数（需人工标注"逃逸"标记） | **未实现**（缺"放行基线与事后告警"的关联字段，属设计项） |
| 6 | 修复回环次数 | 一个 finding 被修了几轮才收敛 | `attempts.length`（逐 finding）；均值 `mean(attempts.length)`；取数 `demo/mini-service/.qgate/evidence/fix-budget-in-loop.json` 的 `findings[].attempts[]` | **已实现（夹具口径）**：实测 `F-0001`=2、`F-0002`=1、`F-0004`=0 |
| 7 | 误报率 | 被判误报的 finding 占比 | `rejected_findings / all_findings`；分子来自驳回记录（§4.4），分母来自 `ocr-findings.json` 的 `findings[]` + `RunResult` 的 `checks[]` | **未实现**：驳回记录目前靠人手工写（`fix-budget-post-gate.json`），没有生成器 |
| 8 | 人类门禁等待时长 | 从上一阶段跑完到签字的时间 | `approval.approvedAt − 上一阶段 run.finished_at`；取数 `approvals/<handoverId>/approval.json` 的 `approvedAt` + 账本 `finished_at` | **已实现（可人工算）**：实测 demo 签字时间 `2026-05-04T09:00:00Z`/`09:30:00Z`/`10:00:00Z`，与运行时账本跨环境，需按实际运行重算 |
| 9 | 覆盖缺口数 | 需求追踪矩阵上的缺口 | `summary.uncovered` + `summary.orphanTestIds`；取数 `trace-matrix.json` 的 `summary` | **已实现**：demo 实测 `requirements=6 covered=6 uncovered=0 orphanTestIds=0 coverageRatio=1`；本仓库根与 CI 实例实测 `requirements=16 covered=16 uncovered=0 orphanTestIds=0` |

**看板建议（最小可用）**：把指标 1/2/6/9 直接规格化输出（都已在 JSON 里），指标 4/7 需要先落地"finding 台账 + 驳回记录生成器"，指标 3/5 需要 provider 记账与发布基线——**不要把未实现的指标画进看板**，否则看板会变成第二个误导源。

---

## 6. 端到端演练（`demo/mini-service`，命令均已实跑）

### 6.0 前置

```powershell
# 所有命令都在仓库根执行；本机 Node v24.19.0，无需 npm install（零依赖）
cd E:\Desktop\ai-quality-gate
node --version
```

实测输出：

```
v24.19.0
```

> 沙箱注意：本环境的**管道 stdio 被禁止**。因此 ① `node --test` 必须带 `--experimental-test-isolation=none`（否则 per-file isolation 会 `spawn EPERM`）；② `command` 类 check 首次用管道捕获子进程 stdout 会被环境拒绝（`EPERM`），引擎随后**回退到文件描述符重定向**（`packages/qgate/src/checks/command.mjs` 的 `spawnWithFileStdout`），证据里因此是真实 stdout 原文（见 §6.3 的 `stdout: v24.19.0`）。CI 在 ubuntu-latest 上不受此限制。

> **证据基线与"运行时字段"说明**：demo 的证据目录在仓库里的**出厂基线**是"有夹具、无账本"（`demo/mini-service/.qgate/evidence/ledger-index.json` 的 `runIds` 为空、`testIds` 为冻结的 14 个（`packages/qgate/scripts/reset-demo-evidence.mjs` 的 `TEST_IDS`）），由仓库自带脚本维护：`node packages/qgate/scripts/reset-demo-evidence.mjs`（"Run before committing demo changes"）。
> 因此本文粘贴的 `run_id` / `started_at` / `finished_at` / `duration_ms` 是**运行时字段**——每次运行都会变，无法也不应固定；可复现的是**退出码、门禁/check 的键集合与 passed 结果、blocker 的 message/evidence、以及事实性计数**（例如 `checks: 3/4/4/4/4`、`unchanged` 的分组数）。写稿完成后我已按脚本把 demo 证据重置回基线，并删除本轮生成的 `qgate.ci.config.json` 与 `.qgate/ci/**`（CI 每次运行自行生成）。（**t32 复核**：当前工作树里该证据目录已被写稿后的多次运行重新填充——实测 `runIds` 21 条、`testIds` 14 个——交付前应重跑该脚本复位。）

### 6.1 契约自检（每轮第一件事）

```powershell
node packages/qgate/bin/qgate.mjs contract --check
```

实测输出（退出码 0）：

```
contract self-check: OK
stages(5): requirements -> design -> build -> review -> verify
humanGates(3): req-to-design:product, design-to-build:architect, review-to-verify:reviewer
checkTypes(7): file_exists|file_not_exists|regex|command|json_assert|trace_matrix|policy
exitCodes: 0=passed, 1=gate_failed, 2=config_error, 3=internal_error
commands(6): contract, check, trace, preview, report, explain
```

### 6.2 五阶段全流水线（demo 实例）

```powershell
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --summary
```

实测输出（退出码 0，`gates[]` 共 5 项）：

```
stage        | gate                 | required | passed | blockers | checks
-------------|----------------------|----------|--------|----------|-------
requirements | req-spec             | true     | true   | 0        | 3
design       | interface-frozen     | true     | true   | 0        | 4
build        | build-deterministic  | true     | true   | 0        | 4
review       | review-counterexample | true     | true   | 0        | 4
verify       | verify-coverage      | true     | true   | 0        | 4

overall_passed=true run_id=2026-09-17T19-16-37.273Z-f86b3263 provider=deterministic
ledger=.qgate/evidence/ledger-2026-09-17T19-16-37.273Z-f86b3263.json
ledger-index=.qgate/evidence/ledger-index.json
```

（`review-counterexample` 比该列宽度长 1 个字符，所以那一行的 `|` 被顶开一格——原文如此。`run_id` / `ledger` 是运行时字段；`approvals_missing` 只在 >0 时打印，demo 为 0 故无该行。）

`stderr` 侧同时输出进度（`--quiet` 可抑制）：

```
qgate check: config=demo/qgate.config.json root=E:\Desktop\ai-quality-gate\demo\mini-service
qgate check: overall_passed=true run_id=2026-09-17T19-16-37.273Z-f86b3263
```

### 6.3 分阶段执行 + 单条 check 的真实证据

```powershell
node packages/qgate/bin/qgate.mjs check --stage build --config demo/qgate.config.json --summary
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json --out "$env:TEMP\demo-full.json"
```

阶段命令实测（**退出码 0**；未执行的门禁**不出现**在 `gates[]` 里，只在表后逐行列为 `not-run`）：

```
stage        | gate                 | required | passed | blockers | checks
-------------|----------------------|----------|--------|----------|-------
requirements | req-spec             | true     | true   | 0        | 3
design       | interface-frozen     | true     | true   | 0        | 4
build        | build-deterministic  | true     | true   | 0        | 4

overall_passed=true run_id=2026-09-17T19-16-38.225Z-22b67302 provider=deterministic
  not-run review/review-counterexample: excluded by the --stage/--gate filter
  not-run verify/verify-coverage: excluded by the --stage/--gate filter
ledger=.qgate/evidence/ledger-2026-09-17T19-16-38.225Z-22b67302.json
ledger-index=.qgate/evidence/ledger-index.json
```

全流水线 `--json --out` 落盘后，抽取的 check 与证据（**粘贴原文**，`overall_passed=true`、`duration_ms=240`、`run_id=2026-09-17T19-16-37.788Z-a3e67ed0`）：

```
req-spec/req-doc-exists [file_exists,high] passed=true
    REQUIREMENTS.md #file :: sha256:25415ce90c074379226e6562183820637782fff5d337b21133ca25ae7f0de97e
    REQUIREMENTS.md #file :: matchedFiles=1 minCount=1
req-spec/req-ids-present [regex,high] passed=true
    REQUIREMENTS.md #file :: 7 match(es); L9:REQ-DEMO-001 | L18:REQ-DEMO-002 | L24:REQ-DEMO-002
    REQUIREMENTS.md #json_pointer :: pattern=REQ-DEMO-\d{3} mode=count countMode=unique totalMatches=7 uniqueMatches=6 minMatches=4
interface-frozen/interface-fields [regex,high] passed=true
    openapi.yaml #file :: 21 match(es); L16:Idempotency-Key | L45:requestId | L67:requestId
    openapi.yaml #json_pointer :: pattern=requestId|traceId|amount|currency|Idempotency-Key mode=count countMode=unique totalMatches=21 uniqueMatches=5 minMatches=5
build-deterministic/command-smoke [command,high] passed=true
    qgate.config.json #stdout :: command=node --version cwd=. exitCode=0 expected=0
    qgate.config.json #stdout :: stdout: v24.19.0
review-counterexample/invalid-must-fail [json_assert,high] passed=true
    .qgate/negative/unknown-check-type.result.json #json_pointer :: /exitCode -> equals=2 expected=2
    .qgate/negative/unknown-check-type.result.json #json_pointer :: /error/code -> equals="CONFIG_INVALID" expected="CONFIG_INVALID"
verify-coverage/trace-complete [trace_matrix,high] passed=true
    .qgate/requirements-index.json #json_pointer :: /requirements (length=6)
    .qgate/trace-matrix.json #trace :: /summary (covered=6, uncovered=0)
    .qgate/evidence/ledger-index.json #ledger :: testIdSource=ledger-index testIds=14
verify-coverage/no-secret-paths [policy,high] passed=true
    qgate.config.json #json_pointer :: SAFE_002 metrics={"selected":14,"secretPathsExcluded":3,"secretPathRules":["secret-env","secret-pem","secret-key","secret-rsa","secret-credentials",…
verify-coverage/no-key-reads [policy,high] passed=true
    qgate.config.json #json_pointer :: SAFE_001 metrics={"filesScanned":42,"violations":0,"tokens":["apiKey (identifier)","apikey (identifier)","APIKEY (environment read)",…
```

**注意 `command` 那一行**：沙箱禁止管道 stdio，引擎回退到**文件描述符重定向**（`spawnWithFileStdout`），实测证据是 `stdout: v24.19.0` ⇒ 配置的 `stdoutRegex` **真的被评估过**（demo 的 `^v\d+\.` 命中的就是这一行）。若两级重定向都被环境拒绝，证据会改写成 `stdout not captured (<reason>); the configured stdout assertion /…/ was NOT evaluated`——**那种情况下**不得宣称 `stdoutRegex` 已被验证。

### 6.4 追踪矩阵

```powershell
node packages/qgate/bin/qgate.mjs trace --config demo/qgate.config.json --summary       # 只算不落盘
node packages/qgate/bin/qgate.mjs trace --config demo/qgate.config.json --write        # 落盘 .qgate/trace-matrix.json
```

实测输出（退出码 0）：

```
wrote .qgate/trace-matrix.json (requirements: .qgate/requirements-index.json)
requirementId            | priority | testIds        | covered
-------------------------|----------|----------------|--------
REQ-DEMO-001             | P0       | T-QG-001,T-QG-016 | true
REQ-DEMO-002             | P0       | T-QG-004,T-QG-014,T-QG-015 | true
REQ-DEMO-003             | P0       | T-QG-006,T-QG-007 | true
REQ-DEMO-004             | P0       | T-QG-002,T-QG-010,T-QG-013 | true
REQ-DEMO-005             | P1       | T-QG-008,T-QG-012 | true
REQ-DEMO-006             | P0       | T-QG-003,T-QG-009 | true

summary: requirements=6 covered=6 uncovered=0 orphanTestIds=0 coverageRatio=1
```

本仓库根实例（16 条需求）：`summary: requirements=16 covered=16 uncovered=0 orphanTestIds=0 coverageRatio=1`。
（**口径提示（t35 记账）**：该数字是 `verification/trace-matrix.json` 这个**制品**的实测值；"某需求是否被覆盖"的**权威来源是 `docs/requirements-index.json`**，两者的口径差异与处置见 `docs/01-architecture.md` §8.3.1 GAP-9。）

### 6.5 确定性预览（引擎侧）

```powershell
node packages/qgate/bin/qgate.mjs preview --config demo/qgate.config.json --summary
```

实测输出（退出码 0）：

```
root=E:\Desktop\ai-quality-gate\demo\mini-service
included=13 excluded=31 groups=2 maxFilesPerGroup=10
  excluded[default_excluded_path]=28
  excluded[secret_path]=3
  g1 files=10 downgraded=false tokens=3865
  g2 files=3 downgraded=false tokens=1048
secretPathsSelected=0 (must be 0)
```

要点：`--root` 可省略（省略时取"配置文件所在目录"推导出的 root）；`--summary` 打印上面 7 行**人类可读文本**，机器可读面要加 `--json`——实测 `--json` 顶层**恰好 8 个键**（`ok` / `degraded` / `root` / `selection` / `groups` / `ruleMatch` / `rules` / `invariants`），其中 `rules.sources` 实测为 `[{"source":"project","path":".opencodereview/rule.json","pathKind":"file","rules":4},{"source":"builtin","path":"builtin:qgate","pathKind":"pseudo","rules":5}]`；`invariants.secretPathsSelected` 必须是**空数组**（`--summary` 里以 `secretPathsSelected=0` 呈现）。`pathKind:"pseudo"` 明示内置层不是文件路径（`packages/qgate/src/rules.mjs` 的 `BUILTIN_RULE_PATH = 'builtin:qgate'`），故 §8 台账条目 14 的顾虑已由自描述消除；`ruleMatch[]` 是逐文件数组（7 字段，映射见 `docs/01-architecture.md` §6.2.2.1）。

**选择计数是运行时字段**：`included` / `excluded` 会随证据目录内容变化——写账本会新增被默认排除的 `.qgate/evidence/ledger-*.json`，`excluded` 只增不减；实测连跑 9 次写盘命令后 `included` 仍是**同一个 13 项集合**（集合完全相等）。

### 6.6 解释（为什么通过/失败）

```powershell
node packages/qgate/bin/qgate.mjs explain --gate build-deterministic --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs explain --check coverage-threshold --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs explain --requirement REQ-DEMO-003 --config demo/qgate.config.json --json
```

实测输出（退出码均为 0，节选）：

```json
{ "ok": true, "subject": { "kind": "gate", "id": "build-deterministic" }, "passed": true,
  "reason": "gate \"build-deterministic\" (stage=build) passed: 4 check(s), no human gate",
  "evidence": [
    { "path": "package.json", "kind": "json_pointer", "excerpt": "/dependencies -> equals={} expected={}" },
    { "path": "package.json", "kind": "json_pointer", "excerpt": "/type -> equals=\"module\" expected=\"module\"" },
    { "path": "qgate.config.json", "kind": "stdout", "excerpt": "command=node --version cwd=. exitCode=0 expected=0" }
  ],
  "relatedRequirements": [ { "testId": "T-QG-010" }, { "testId": "T-QG-016" }, { "testId": "T-QG-007" }, { "testId": "T-QG-014" } ] }
```

```json
{ "ok": true, "subject": { "kind": "requirement", "id": "REQ-DEMO-003" }, "passed": true,
  "reason": "every testId (T-QG-006, T-QG-007) appears in .qgate/evidence/ledger-index.json",
  "evidence": [ { "path": ".qgate/evidence/ledger-index.json", "kind": "ledger", "excerpt": "T-QG-006,T-QG-007" } ],
  "relatedRequirements": [ { "checkId": "schemas-exist", "testId": "T-QG-006" }, { "checkId": "contract-check", "testId": "T-QG-007" },
    { "checkId": "test-results-threshold", "testId": "T-QG-007" }, { "checkId": "coverage-threshold", "testId": "T-QG-007" },
    { "checkId": "trace-complete", "testId": "T-QG-006" }, { "checkId": "trace-covered", "testId": "T-QG-006" } ] }
```

> 已知噪声（t32 复核）：`explain` 会真的跑一遍流水线，但 `writeLedger:false`，**不写账本**；无 `--json/--summary` 时 stdout 是人类可读两行（`<id> passed=true` + 原因），实测**没有**裸 `v24.19.0` 混入。见 §8 台账条目 9。

### 6.7 报告（由账本生成）

```powershell
node packages/qgate/bin/qgate.mjs report --config demo/qgate.config.json --json
```

实测输出（退出码 0）：

```json
{ "ok": true, "reports": [ { "run_id": "2026-09-17T19-16-38.576Z-fff22ba3", "overall_passed": true,
  "path": ".qgate/reports/report-2026-09-17T19-16-38.576Z-fff22ba3.md" } ] }
```

**基线状态下会先失败**（实测，退出码 **2**）：在"从未跑过 `qgate check`"的干净 demo 上直接跑 `report`，因为账本是空的：

```json
{ "ok": false, "error": { "code": "CONFIG_NOT_FOUND",
  "message": "no ledger found under .qgate/evidence; run \"qgate check\" first",
  "jsonPointer": "",
  "details": [ { "jsonPointer": "", "expected": ".qgate/evidence/ledger-index.json with entries", "actual": ".qgate/evidence",
                 "message": "ledger index is empty or missing" } ] } }
```

正确顺序始终是：**先 `check`（写账本）→ 再 `report`/`trace`**。

### 6.8 反向用例：非法配置必须退出 2

```powershell
node packages/qgate/bin/qgate.mjs check --config packages/qgate/examples/invalid/unknown-check-type.json --json
```

实测（**退出码 2**，粘贴原文）：

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_INVALID",
    "message": "configuration is not valid: check.type \"file_exist\" is not allowed",
    "jsonPointer": "/gates/0/checks/0/type",
    "details": [
      { "jsonPointer": "/gates/0/checks/0/type",
        "expected": "file_exists|file_not_exists|regex|command|json_assert|trace_matrix|policy",
        "actual": "file_exist",
        "message": "check.type \"file_exist\" is not allowed" }
    ]
  }
}
```

### 6.9 阻断演练：删掉一件证据会发生什么（含恢复）

```powershell
# 1) 备份并删除一件必需证据
Copy-Item demo\mini-service\.qgate\evidence\coverage.json "$env:TEMP\coverage.backup.json" -Force
(Get-FileHash demo\mini-service\.qgate\evidence\coverage.json -Algorithm SHA256).Hash
Remove-Item demo\mini-service\.qgate\evidence\coverage.json -Force
# 2) 跑全流水线
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json
# 3) 恢复并复核
Copy-Item "$env:TEMP\coverage.backup.json" demo\mini-service\.qgate\evidence\coverage.json -Force
(Get-FileHash demo\mini-service\.qgate\evidence\coverage.json -Algorithm SHA256).Hash
```

实测结果：

| 步骤 | 观测 |
|---|---|
| 删除前 sha256 | `93A15B8F59C819E5B0DD4E7FA4D56D30F3823A566D09568AE56A68F1BA7CF30F` |
| 删除后跑流水线 | **退出码 1**，`overall_passed=false`，blocker：`coverage-threshold \| FILE_MISSING: .qgate/evidence/coverage.json does not exist (json_assert requires a single JSON file)` |
| 恢复后 sha256 | `93A15B8F59C819E5B0DD4E7FA4D56D30F3823A566D09568AE56A68F1BA7CF30F`（`restored_identical=True`） |
| 恢复后重跑 | **退出码 0**，`overall_passed=true` |

这就是"门禁有牙齿"的最小证明：**删证据 = 退出 1 + 精确指向缺失路径**，且门禁不会因为"文件缺失"而把检查标成通过。

### 6.10 人类门禁驳回演练（在临时根上做，不污染 demo）

因为签字制品的路径是相对被检仓库根的，可以用一个最小临时仓库复现三态（本仓库根**没有** `verification/approvals/**`，所以不要在仓库根直接试）：

```powershell
# 建最小被检仓库：只有一份需求文档 + 一个 requirements 门禁（挂 req-to-design 人类门禁）
$r = "$env:TEMP\hgroot"                       # 目录结构：qgate.config.json / REQUIREMENTS.md / approvals/req-to-design/approval.json
node E:\Desktop\ai-quality-gate\packages\qgate\bin\qgate.mjs check --config "$r\qgate.config.json" --summary
```

实测三态（`decision` 依次为 `rejected` / `revise` / `approved`）：

```
rejected → requirements | req-spec | required=true | passed=false | blockers=1 | checks=1 ；overall_passed=false approvals_missing=2  EXIT=1
             blocker[blocker] req-spec: HUMAN_GATE_NOT_APPROVED: gate "req-spec" requires role "product" to approve approvals/req-to-design/approval.json (state=rejected: approval decision is "rejected")
revise   → requirements | req-spec | required=true | passed=false | blockers=1 | checks=1 ；overall_passed=false approvals_missing=2  EXIT=1
             blocker 原文同上，结尾文案为 (state=rejected: approval decision is "revise")——`revise` 同样归入 `rejected` 桶
approved → requirements | req-spec | required=true | passed=true  | blockers=0 | checks=1 ；overall_passed=true  approvals_missing=2  EXIT=0
```

（`approvals_missing: 2` 是因为该最小仓库只配了 3 处交接里的 1 处——这正是"允许渐进落地"的实测表现。）

### 6.11 OCR 适配层：选择 / 分组 / 安全不变量 / 确定性

```powershell
node adapters/opencodereview/bin/ocr-preview.mjs --diff adapters/opencodereview/demo/diff.json --rule adapters/opencodereview/demo/rule.json --json
node adapters/opencodereview/bin/ocr-preview.mjs --diff adapters/opencodereview/demo/diff.json --rule adapters/opencodereview/demo/rule.json --token-budget 300 --json
node adapters/opencodereview/bin/ocr-preview.mjs --diff adapters/opencodereview/demo/diff.json --rule adapters/opencodereview/demo/rule.json --max-files 50 --json
node adapters/opencodereview/bin/ocr-preview.mjs --diff adapters/opencodereview/demo/diff.json --rule adapters/opencodereview/demo/rule.json --include '**/*' --include '.env*' --include 'secrets/**' --json
```

实测汇总（全部退出码 0）：

| 场景 | 观测 |
|---|---|
| 默认 | `counts`: candidates 23 / selected 14 / excluded 9 / groups 4；`degraded:true`，`degraded_reason:"OCR_CLI_NOT_FOUND"`，`llm_called:false`；`safety.no_sensitive_selected:true`；`grouping.invariant_ok:true` |
| `--token-budget 300` | `groups=14`，`downgraded=12`，`single_file=12`，`invariant_ok=true`，`budget=300`，首组 `{"downgrade_reason":"token_budget_exceeded","downgraded":true,…,"id":"per-file:src/chain/user-handler.mjs"}` |
| `--max-files 50` | 请求被硬钳制：`grouping.max_files_per_group=10`，`invariant_ok=true` |
| 最宽泛 include（含 `.env*`、`secrets/**`） | `selected=14`，`secret_like_in_selected=0`，`no_sensitive_selected=true`；`.env.production` 只在 `excluded`，`reason:"sensitive_path_never_included"`，`rule_source:"SAFETY_INVARIANT"` |

确定性实测：同一命令连跑两次，`--out` 产物 sha256 完全相同：

```
sha256 run1=B3304EC0C7447EC6BEA88C534F2CD365335A99865A156481DC6703C782E00F03
sha256 run2=B3304EC0C7447EC6BEA88C534F2CD365335A99865A156481DC6703C782E00F03
identical=True
```

跨 cwd 实测（**含一个真实缺口**，详见 §8 条目 3）：

| 命令 | 跨 cwd 差异叶子键（UTC 18:34Z 首次实测） | 跨 cwd 差异叶子键（UTC 18:42Z 复核） |
|---|---|---|
| `qgate check --config <绝对路径>` （剔除运行时字段后逐叶子比对） | **0**（235/235 叶子一致） | —— |
| `qgate preview --config <绝对路径>`（背靠背两次，中间不跑 check） | **0**（349/349 叶子一致） | —— |
| `ocr-preview --diff <绝对路径> --rule <绝对路径>`（无 `--root`） | **1**：`$.rules.layer_trace[1].file` = 仓库根下的规则路径 vs cwd 下的规则路径 | **0**（444/444 叶子一致）——该缺口在写稿期间被修复 |

### 6.12 测试套件（两个套件都实跑）

```powershell
node --test --experimental-test-isolation=none packages/qgate/test/config-and-run-result.test.mjs packages/qgate/test/pipeline-and-checks.test.mjs packages/qgate/test/acceptance.test.mjs packages/qgate/test/schema-contract.test.mjs
node adapters/opencodereview/tools/run-tests.mjs
```

实测（**两个时刻，都如实记录**）：

| 时刻 | 引擎套件 | 适配层套件 | 备注 |
|---|---|---|---|
| 写稿首次（UTC 18:33Z / 18:40Z） | `tests 60 / pass 60 / fail 0 / skipped 0 / duration_ms 4658.327`（退出码 0） | `tests 57 / pass 57 / fail 0 / skipped 0 / duration_ms 748.2659`（退出码 0） | 两个套件全绿 |
| 最后一次复核（UTC 18:42Z 前后） | `tests 62 / pass 61 / fail 1`（退出码 1） | `tests 60 / pass 56 / fail 4`（退出码 1） | ⚠并发：成员正在改 CI/夹具/schema，失败项为 `the four schemas cover every frozen §5 field-table entry and nothing surplus`（引擎）与 4 条适配层用例（3 条 CI workflow 断言 + `fixtures: selection.default.md …`） |

**结论**：测试套件是**验收入口**而不是本手册的结论——写稿时刻的全绿证明"当时可用"，最后一次复核转红说明"此刻不可放行"。任何放行判定必须以**运行当时的**套件结果为准；转红期间不得给出 `verify` 通过结论（这正是 §2 卡片 3 / 卡片 5 的退出条件在起作用）。

### 6.13 CI 一致性（`workflow` 头部命令逐条本地复现）

CI 的判据是"每个 job 一条命令 + 退出码 1 = 失败"。按 `.github/workflows/quality-gate.yml` 头部「本地等价复现」执行（该文件要求先在仓库根生成输出改道的 `qgate.ci.config.json`）：

```powershell
# 1) 生成 CI 配置（唯一事实来源是仓库根 qgate.config.json，只改 3 个输出路径）
node "$env:TEMP\gen-ci-config.cjs"     # 等价于 workflow 里的 node -e 一行（PowerShell 直传单引号会被吞，故落成脚本执行）
# 2) 四个阶段 job
node packages/qgate/bin/qgate.mjs check --stage requirements --config qgate.ci.config.json --json
node packages/qgate/bin/qgate.mjs check --stage design       --config qgate.ci.config.json --json
node packages/qgate/bin/qgate.mjs check --stage build        --config qgate.ci.config.json --json
node packages/qgate/bin/qgate.mjs check --stage review       --config qgate.ci.config.json --json
# 3) verify job（三段式，顺序不可颠倒）
node packages/qgate/bin/qgate.mjs check --config qgate.ci.config.json --json   # 预期失败：退出码 1（TRACE_GAP）
node packages/qgate/bin/qgate.mjs trace --config qgate.ci.config.json --write
node packages/qgate/bin/qgate.mjs check --config qgate.ci.config.json --json   # 权威判定：退出码 0
```

实测结果：

| 步骤 | 退出码 | 关键输出 |
|---|---|---|
| 生成配置 | 0 | `generated qgate.ci.config.json gates=req-spec,interface-frozen,build-deterministic,review-counterexample,verify-coverage` |
| `--stage requirements` | 0 | — |
| `--stage design` | 0 | — |
| `--stage build` | 0 | — |
| `--stage review` | 0 | — |
| verify 第 1 步（warm-up） | **1** | `overall=false`，唯一 blocker：`trace-complete \| TRACE_GAP: trace matrix is missing or not parseable JSON` |
| verify 第 2 步（`trace --write`） | 0 | `summary: requirements=16 covered=16 uncovered=0 orphanTestIds=0 coverageRatio=1` |
| verify 第 3 步（权威判定） | **0** | `overall=true gates=req-spec:true,interface-frozen:true,build-deterministic:true,review-counterexample:true,verify-coverage:true run_id=2026-09-17T18-39-11.579Z-9111e2ef` |

产物落点（`policy.evidenceDir=.qgate/ci/evidence`、`traceFile=.qgate/ci/trace-matrix.json`，与 workflow 的 artifact 上传路径逐一对应）：

```
.qgate\ci\trace-matrix.json
.qgate\ci\evidence\ledger-2026-09-17T18-39-08.967Z-55118529.json
.qgate\ci\evidence\ledger-2026-09-17T18-39-09.168Z-c6772247.json
.qgate\ci\evidence\ledger-2026-09-17T18-39-09.384Z-ac75403a.json
.qgate\ci\evidence\ledger-2026-09-17T18-39-09.876Z-ce2fd118.json
.qgate\ci\evidence\ledger-2026-09-17T18-39-10.363Z-1e361475.json
.qgate\ci\evidence\ledger-2026-09-17T18-39-11.579Z-9111e2ef.json
.qgate\ci\evidence\ledger-index.json
```

**⚠并发（写稿时的真实插曲，保留作为经验）**：在 02:36–02:38 之间，CI 一度把配置放在 `adapters/opencodereview/ci/qgate.ci.config.json` 并由 workflow 直接 `--config` 引用。实测该版本**整体失败**：`check` 退出码 1，13 条 blocker 全是 `FILE_MISSING`（`docs/00-requirements.md`、`schemas/*.schema.json`、`packages/qgate/package.json` …），根因是**引擎按"配置文件所在目录"解析相对路径**（`packages/qgate/src/config.mjs` 的 `inferRootFromConfig`），配置放在 `adapters/opencodereview/ci/` 时输出会落到 `adapters/opencodereview/ci/.qgate/ci/**`；随后该配置被删除，workflow 改为"在仓库根生成配置"。**当前版本（workflow mtime 02:38:26）本地复现已全绿**（上表）。这条经验应写进任何"配置放哪"的讨论：**配置文件的位置就是 root**。

**CI 的人类门禁步骤**：`verify` job 里有一个"检查签字制品存在性 + 角色匹配"的诊断步骤，读的是仓库根的 `verification/approvals/<gateId>/approval.json`。实测该路径**当前不存在**（`verification/approvals` 目录不会由本仓库产生），因此该步骤会打印 3 行 `MISSING …` 与 `HUMAN_GATE_NOT_APPROVED: 3 record(s) missing or mismatched`，但它**恒以 `process.exit(0)` 结束**（不阻断 job）。demo 的签字制品在 `demo/mini-service/.qgate/approvals/**`，并由 demo 配置的人类门禁真正强制。**结论：CI 的这一步目前是"报告"，不是"门禁"；真正的门禁强制发生在 `qgate check` 内部。**

---

## 7. 能力边界

### 7.1 本原型已实现（可离线跑、可复现验证）

| 能力 | 证据 |
|---|---|
| 五阶段有序门禁引擎 + 七类 check（`file_exists`/`file_not_exists`/`regex`/`command`/`json_assert`/`trace_matrix`/`policy`） | `packages/qgate/src/checks/*.mjs`；`qgate contract --check` 打印 `checkTypes(7)`；§6.2/6.3 实测 |
| 冻结契约自检（stages / humanGates / checkTypes / exitCodes / commands） | `qgate contract --check` 退出 0 + `contract self-check: OK` |
| RunResult v1.0（8 个顶层字段）+ 退出码 0/1/2/3 | §6.2/6.3/6.8/6.9 实测；`schemas/run-result.schema.json` 校验全流水线输出 `valid=true` |
| 证据账本（只追加）+ sha256 + `ledger-index.json` | `.qgate/evidence/ledger-<run_id>.json`、`ledger-index.json`；`file_exists` 证据为 `sha256:<hex>` |
| 追踪矩阵 + 一致性规则（双向覆盖、孤儿 testId、strict 模式） | §6.4 实测 `covered=6/6`；`trace-complete` 检查 |
| 人类门禁固定 3 处 + `blocking` + 驳回状态机 | `packages/qgate/src/human-gate.mjs`；§1.3/§6.10 三态实测 |
| 确定性 provider 由离线 fixture 驱动（无网络、无密钥、无 LLM） | 实测 `provider.detail="offline-fixture"`、`degraded:false`；`SAFE_001/SAFE_003` 检查通过 |
| OCR 确定性选择 / 过滤 / 分组 / 四层规则（+ 安全不变量） | §6.11 实测；适配层 57/57 测试通过 |
| 零依赖、纯 ESM、离线 | `packages/qgate/package.json` 无 `dependencies`；`no-dep` 检查通过；两个测试套件在**写稿首次测量时**于无网络环境全绿（60/60 与 57/57），复核时刻因并发改动转红（§6.12） |
| CI 五 job 映射 + 三段式 verify | §6.13 实测 8 步退出码全部符合预期 |

### 7.2 仅设计未实现（有契约/文档/夹具，但没有可执行路径）

| 项 | 现状 | 缺什么 |
|---|---|---|
| 行号 **re-tracking** | 无实现。引擎侧只有"行号证据"（`packages/qgate/src/checks/regex.mjs` 产出 `L<line>:<片段>`）；适配层**没有**定位模块（`docs/01-architecture.md` §4.1 写的"适配层定位模块"目前指不到任何文件） | 一个把"模型报告的 (file,line)"重新对齐到当前文件内容的模块 + 对应 check |
| reflection / suggestion validation 接线 | `adapters/opencodereview/src/reflection.mjs` 实现了 6 条复核规则，但**只被测试引用**，未接入 CLI/流水线 | 在 `ocr-pipeline.mjs`/`ocr-preview.mjs` 的产出路径上调用 `reflectSuggestions`，并让 `severity-mix` 断言复核后的台账 |
| Delegation Mode | 无 `--delegation` 开关；只有 JSON 输出面（`qgate preview --json` / `ocr-preview --json` / `qgate contract --json`） | Host Agent 交接协议 + 开关 + 契约 |
| 降级留痕的门禁化 | `groups[].downgrade_reason` / `downgraded` 已产出，但**没有任何 check 断言它** | 一条 `json_assert`（例如断言超预算时 `downgraded=true` 且 `file_count==1`） |
| 误报率 / 真阳性占比 / 逃逸缺陷 三个指标 | 只有定义与人工留痕（`fix-budget-*.json`） | finding 台账生成器 + 驳回记录生成器 + 发布基线 |
| 单 check 耗时 | `ledger entries[].durationMs` 恒为 0（`packages/qgate/src/core.mjs`） | 在 `executeCheck` 前后打点并写入账本 |
| `verification/approvals/**`（本仓库根） | 目录不存在；demo 的签字制品在 `demo/mini-service/.qgate/approvals/**` | 若要在 CI verify job 里真正强制本仓库的人类门禁，需要有人签字并落盘 |

### 7.3 需要真实 LLM / 外部系统（本原型刻意不依赖）

| 项 | 本原型的处理 | 接上之后的注意事项 |
|---|---|---|
| LLM provider（`provider.type="llm"`） | 契约里有 `model`/`endpoint` 字段，离线不可用时**降级为 deterministic** 并置 `provider.degraded=true`，**不影响门禁判定与退出码** | 一旦真实可用，"模型只能产出 finding"这条不能破：`overall_passed` 仍必须由确定性 check 算出 |
| 真实 `ocr` CLI | 可选；缺失时适配层降级为本地实现（`degraded:true` + `degraded_reason`），退出码仍为 0 | 接入后要重录 `adapters/opencodereview/test/fixtures/**` 三个夹具，并复核跨 cwd 的层轨迹留痕 |
| 真实 token / 成本记账 | 不测（零 LLM 调用，实测 `llm_called:false`） | 需要 provider 侧记录 prompt/completion token 与单价；否则 §5 指标 3 永远是 0 |
| 模型语义级代码审查质量、跨仓大规模性能、UI/Dashboard、多 CI 平台、自动豁免机制 | 明确列为非目标（`docs/00-requirements.md` §5） | 不要用本原型的测试结果去外推这些能力 |

---

## 8. 已知偏差与缺口台账（含责任建议）

写稿时逐条实测；**标 ⚠并发 的条目所在文件在本轮被并发改动**，请 verifier 在 t24 复核。**t32 复核补充见 §8.1**：原表第 1/2/7/8/9/14 条所述缺口在当前树上已不复现；其余条目本次亦逐条核对，未发现变化。

| # | 缺口 | 实测证据 | 影响 | 建议责任 |
|---|---|---|---|---|
| 1 | `--stage` 过滤时 `gates[]` 会多出 `skipped` / `skipReason` 两个键，不在 §5.2 冻结字段表内（**t32 复核：已不复现，见 §8.1**） | 用仓库自带的零依赖校验器逐份校验：全流水线输出 `valid=true errors=0`；`--stage build` 输出 `valid=false errors=4`（4 条 `additionalProperties: unknown property "skipped"/"skipReason" is not part of the frozen field table`，`packages/qgate/test/helpers/json-schema.mjs` + `schemas/run-result.schema.json`） | 阶段命令的 RunResult 不满足自己的冻结 schema；消费者若用 schema 校验阶段输出会误判 | core-engineer（二选一：把 `skipped`/`skipReason` 补进契约与 schema，或在序列化时不输出） |
| 2 | 配置文件带 UTF-8 BOM 时被拒（**t32 复核：已不复现，见 §8.1**） | 用 PowerShell 默认 `-Encoding utf8` 写出的 `qgate.config.json` ⇒ `{"code":"CONFIG_INVALID","message":"configuration file is not parseable JSON: … Unexpected token '\ufeff'…"}`，退出码 2；而验证侧脚本反而显式 `replace(/^\uFEFF/,'')` 剥离 BOM（写稿时该文件在 `verification/tools/schema-eval.mjs`（该目录现已不存在），复核时已随验证目录调整到 `verification-t9/tools/schema-eval.mjs`） | Windows 用户手写配置容易踩坑，且报错指向"JSON 不可解析"而非"有 BOM" | core-engineer（`loadConfig` 读入时剥离 BOM） |
| 3 | 适配层跨 cwd 不确定 → **写稿期间已修复** | 首次实测（18:34Z）：`ocr-preview --diff <绝对> --rule <绝对>`（无 `--root`）在两个 cwd 下 444 个叶子中差异 **1** 个 = `$.rules.layer_trace[1].file`；复核（18:42Z，`adapters/opencodereview/src/ocr-pipeline.mjs` 于 18:41Z 被改）后同一命令差异 **0**（444/444 一致） | 修复前把适配层产物当字节级证据做审计/diff 会误判漂移；修复后该顾虑消除 | 已由 adapter-engineer 修复；**verifier 需在 t24 确认修复与重录夹具（`adapters/opencodereview/test/fixtures/**` 于 18:41Z 重录）一致** |
| 4 | 行号 re-tracking 无实现 | 全仓库 grep `re-track|retrack` 只命中 `docs/00-requirements.md` 与 `docs/01-architecture.md` 的描述；`adapters/opencodereview/src/` 无定位模块 | §3 映射表 #6 只能标注"未实现"；OCR 降噪链条缺一环 | adapter-engineer（实现或把该手法从"已复刻"降级为"未复刻"） |
| 5 | reflection 未接线 | `reflection.mjs` 的 `reflectSuggestions` 只被 `adapters/opencodereview/test/ocr-runner.test.mjs` 引用 | 6 条复核规则在生产路径上不生效 | adapter-engineer |
| 6 | Delegation Mode 未实现 | 适配层/引擎都没有该开关（`adapters/opencodereview/bin/ocr-preview.mjs` 的 `--help` 参数表全列，无 delegation 项） | 只能通过 JSON 输出面近似达成 | 需求方决定是否排期 |
| 7 | 账本 `entries[].durationMs` 恒为 0（**t32 复核：已不复现，见 §8.1**） | `packages/qgate/src/core.mjs` 里写入 `durationMs: 0` | 单 check 耗时不可得，§5 指标 2 只能算整轮 | core-engineer |
| 8 | 账本写入会改变 `qgate preview` 的被选集合（**t32 复核：已不复现，见 §8.1**） | demo 配置的 `selection.defaultExcludedPaths` 覆盖了契约默认值（契约默认含 `.qgate/evidence`、`verification/evidence`，demo 只写了 `[".git","node_modules","dist","build","coverage"]`）；我连跑时同一命令的 `selection.included` 因为新增账本文件而位移 | "同输入同输出"在"输出本身改变输入"时不成立；preview 结果随运行历史漂移 | core-engineer（把证据目录加回 `defaultExcludedPaths`，或在 demo 配置补回） |
| 9 | `command` check 在受限沙箱下无法管道捕获 stdout（**t32 复核：已不复现，见 §8.1**） | 证据原文 `stdout not captured: piped stdio unavailable, command ran with inherited stdio`；非 `--json` 场景下子进程 stdout 还会混进父进程 stdout（实测裸 `v24.19.0` 一行） | 本环境不能宣称 `stdoutRegex` 被验证；非 JSON 输出的 stdout 不是纯净文本 | 环境限制（记录即可）；CI/ubuntu 不受影响 |
| 10 | CI verify job 的人类门禁步骤读的路径不存在 | `Test-Path verification/approvals` = `False`；该步骤会打印 3 行 `MISSING …` 但恒 `exit 0` | 该步骤是报告而非门禁，容易被误读成"CI 已校验人类门禁" | adapter-engineer（要么改为读 `demo/mini-service/.qgate/approvals/**`，要么把 `verification/approvals/**` 建起来并让它真的阻断） |
| 11 | 夹具/文档里的路径与真实目录不一致 | `demo/mini-service/.qgate/approvals/README.md` 写的是 `.qgate/approvals/req-spec/approval.json`（真实目录是 `req-to-design/`、`design-to-build/`、`review-to-verify/`）；`fix-budget-in-loop.json` 引用 `.qgate/approvals/interface-frozen/approval.json`、`fix-budget-post-gate.json` 引用 `.qgate/approvals/review-counterexample/approval.json`，两个路径都不存在；`SELECTION-NOTES.md` 列的 `secrets/payments.pem`、`bundle.zip` 也不在树里 | 审计时按图索骥会找不到签字/证据制品 | core-engineer（改夹具与说明，或把路径补真） |
| 12 | 适配层与契约的字段命名缺口 GAP-1…GAP-4 | 见 `docs/01-architecture.md` §6.2.2 / §6.2.3（权威映射表 + 四处缺口：`priority` 1 基 vs 0 基、同产物内 snake_case/camelCase 混用、适配层独有键、`severity` 同名异义） | 跨侧消费必须先读映射表；本项目裁决为"保留 OCR 原生命名，不做重命名" | 已裁决（无需修），但**不得声称"已对齐"** |
| 13 | ⚠并发：测试套件在复核时刻转红 | 复核（18:42Z）：引擎 `tests 62 / pass 61 / fail 1`，适配层 `tests 60 / pass 56 / fail 4`；失败项见 §6.12 | 该时刻不得给出 `verify` 通过结论 | verifier（t24）跑最终一套；engine/adapter owner 修到绿 |
| 14 | ⚠并发：`qgate preview` 报出的 builtin 规则层路径在磁盘上不存在（**t32 复核：已不复现，见 §8.1**） | `qgate preview --config demo/qgate.config.json --json` 输出 `rules.sources[1] = {"source":"builtin","path":"packages/qgate/gates/builtin-rule.json","rules":5}`，该常量定义在 `packages/qgate/src/rules.mjs`（`BUILTIN_RULE_PATH = 'packages/qgate/gates/builtin-rule.json'`），但 `packages/qgate/gates/` 当前只有 `contract.json` 与 `README.md`（`Test-Path` 为 False） | 该路径是"声明值"而非真实文件；把它当可解析证据（例如写进台账再复算哈希）会失败 | core-engineer（要么落盘该文件，要么让自描述指向内置常量的真实来源） |

### 8.1 t32 复核：原表中已不复现的缺口（原表保留为历史实测，其文字未改）

复核时间窗：本地 2026-09-18 03:23:26（UTC 2026-09-17T19:23:26.474Z）。复核方式：**会写盘的命令在仓库的字节级副本上跑**（`check` / `trace --write` / `report` 会写 demo 夹具），只读命令（`contract --check` / `preview` / `explain`）直接跑真树。抄本**在建立时**与真树 382/382 文件 SHA256 完全一致（此后其他成员仍有并发改动，不影响本表的观测）。

| 原表条目 | 复核命令 / 取数位置（cwd = 仓库根） | 观测（实测） | 结论 |
|---|---|---|---|
| 1 `--stage` 多出 `skipped` / `skipReason` | `node packages/qgate/bin/qgate.mjs check --stage build --config demo/qgate.config.json --summary` | 退出码 0；`gates[]` **只有 3 行**（requirements / design / build），review 与 verify **不出现**；表后只有两条 `not-run review/review-counterexample: excluded by the --stage/--gate filter` 与 `not-run verify/verify-coverage: …` | 已修复：未运行的门禁被省略，RunResult 键集合不再增长 |
| 2 配置带 BOM 被拒 | `packages/qgate/src/config.mjs` 的 `raw = parseJsonText(text)`（复核时 L603）+ `packages/qgate/src/util/fsx.mjs` 的 `stripBom` / `parseJsonText`（L24-L32） | 配置解析走 `parseJsonText`，只剥离首部 `\uFEFF`；真正畸形的 JSON 仍以 `CONFIG_INVALID` 退出 2（`readJsonFile` 同样走 `stripBom`） | 已修复：BOM 不再是拒绝理由 |
| 7 `entries[].durationMs` 恒为 0 | `demo/mini-service/.qgate/evidence/ledger-2026-09-17T19-15-42.208Z-5aac57d9.json` 的 `entries[].durationMs` | 实测取值集合：`121 / 0 / 31 / 1 / 29 / 2` 毫秒（同一账本 19 条 entry，既非恒 0 也非全非 0；`packages/qgate/src/core.mjs:236` 在每个 check 前后打点） | 已修复：单 check 耗时可用 |
| 8 写账本会移动 `preview` 的被选集合 | 连跑 9 次写盘命令后再跑 `preview --config demo/qgate.config.json --json` | `selection.included` 与写盘前**逐项相同**（13 项，集合完全相等）；只有 `selection.excluded` 增长（31 → 40，新增项全是 `.qgate/evidence/ledger-*.json`，`reason:"default_excluded_path"`） | 已修复：demo 配置的 `defaultExcludedPaths` 已含 `.qgate/evidence`，账本不再进入 `included` |
| 9 `command` check 无法捕获 stdout | `check --config demo/qgate.config.json --json` 落盘后取 `command-smoke` 的证据 | 证据原文为 `qgate.config.json #stdout :: stdout: v24.19.0`（旧文案 `stdout not captured: piped stdio unavailable…` 已不在引擎里）；管道被拒后回退**文件描述符重定向**（`packages/qgate/src/checks/command.mjs` 的 `spawnWithFileStdout`） | 已修复：`stdoutRegex` 在本沙箱内真的被评估（demo 的 `^v\d+\.` 命中该行） |
| 14 `preview` 报出的 builtin 规则层路径不存在 | `preview --config demo/qgate.config.json --json` 的 `rules.sources[1]` | 实测 `{"source":"builtin","path":"builtin:qgate","pathKind":"pseudo","rules":5}`（`packages/qgate/src/rules.mjs:19` 的 `BUILTIN_RULE_PATH = 'builtin:qgate'`）；`rules.note` 说明 `pathKind="pseudo"` 不是可解析位置 | 已修复：内置层不再伪装成文件路径 |

**本次复核未发现变化的条目**：3（适配层跨 cwd 是写稿期已修复项）、4（行号 re-tracking 仍无实现）、5（`reflectSuggestions` 仍只被 `adapters/opencodereview/test/ocr-runner.test.mjs` 引用——全仓命中 `reflection.mjs:30` 与测试 3 处，无生产路径引用）、6（仍无 `--delegation` 开关）、10（`Test-Path verification/approvals` 仍为 `False`）、11（`demo/mini-service/.qgate/approvals/README.md` 第 6-8 行仍在写 `.qgate/approvals/` 下三个**不存在**的目录名 `req-spec` / `interface-frozen` / `review-counterexample`；`fix-budget-in-loop.json:31`、`fix-budget-post-gate.json:5`、`SELECTION-NOTES.md:11,15` 同）、12（GAP-1…4 命名缺口照旧）、13（并发期测试转红属历史记录，放行判定仍以运行当时结果为准）。

**本任务未复跑的段落**：§6.13 的 CI 八步（需先按 workflow 生成 `qgate.ci.config.json`，且根配置的 verify job 正在被 t30 改动）。该表「关键输出」列是**转述**而非逐字输出（例如 `overall=true gates=req-spec:true,…` 这种形态并不存在于当前 `--summary` / `--json` 输出中），建议 verifier 在 t24 复跑时校正。

---

## 附录 A — 两套实例的门禁/check 对照（真实配置）

| 阶段 | demo 实例 `demo/qgate.config.json`（root = `demo/mini-service/`） | 本仓库根 `qgate.config.json`（root = 仓库根） |
|---|---|---|
| requirements | `req-spec`：`req-doc-exists`(file_exists `REQUIREMENTS.md`)、`req-ids-present`(regex `REQ-DEMO-\d{3}` ≥4 unique)、`req-index-valid`(json_assert `.qgate/requirements-index.json`)；humanGate `product` → `.qgate/approvals/req-to-design/approval.json` | `req-spec`：`req-doc-exists`、`req-ids-present`(regex `REQ-QUALITY-GATE-\d{3}` ≥16 unique over `docs/00-requirements.md`)、`req-index-valid`、`interface-fields`(regex `humanGate\|approvalRecord\|enforcement`)；**无 humanGate** |
| design | `interface-frozen`：`interface-exists`(`openapi.yaml`)、`interface-fields`(5 字段 unique ≥5)、`rule-file-exists`(`.opencodereview/rule.json`)、`no-loose-ends`(`TODO.md`, `required:false`)；humanGate `architect` | `interface-frozen`：`contract-doc-exists`、`contract-fields-present`、`schemas-exist`(`schemas/*.schema.json` ≥4)、`no-loose-ends`(`docs/TODO.md`, `required:false`)；**无 humanGate** |
| build | `build-deterministic`：`no-dep`、`command-smoke`、`test-results-threshold`、`no-network-surface`(SAFE_003) | `build-deterministic`：`no-dep`、`unit-tests`(≥4 套件)、`contract-check`(命令 + `stdoutRegex "contract self-check: OK"`)、`no-bypass`(CONTRACT_001)、`no-secret-paths`(SAFE_002) |
| review | `review-counterexample`：`negative-fixtures`(≥1)、`invalid-must-fail`、`severity-mix`、`no-bypass`(CONTRACT_001)；humanGate `reviewer` | `review-counterexample`：`negative-fixtures`(≥6)、`severity-mix`、`provider-fixtures`；**无 humanGate** |
| verify | `verify-coverage`：`trace-complete`、`coverage-threshold`、`no-secret-paths`(SAFE_002)、`no-key-reads`(SAFE_001) | `verify-coverage`：`trace-complete`(`requirementsFile: docs/requirements-index.json`, `traceFile: verification/trace-matrix.json`)、`invalid-must-fail`(命令期望退出 2) |
| 输出路径 | `policy.evidenceDir=".qgate/evidence"`、`reportDir=".qgate/reports"`、`projectRoot="mini-service"` | `policy.evidenceDir="verification/evidence"`、`reportDir="verification/reports"` |
| 实测判定 | `check --config demo/qgate.config.json` ⇒ 退出 0，5/5 门禁 passed，`approvals_missing=0` | `check --config qgate.config.json` ⇒ 退出 0，5/5 门禁 passed，`approvals_missing=3` |

## 附录 B — 命令速查

| 目的 | 命令 |
|---|---|
| 契约自检 | `node packages/qgate/bin/qgate.mjs contract --check` |
| 五阶段全流水线 | `node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json` |
| 单阶段（含更早阶段） | `node packages/qgate/bin/qgate.mjs check --stage review --config demo/qgate.config.json --json` |
| 单门禁 | `node packages/qgate/bin/qgate.mjs check --gate review-counterexample --config demo/qgate.config.json --json` |
| 生成/查看追踪矩阵 | `node packages/qgate/bin/qgate.mjs trace --config demo/qgate.config.json --write` |
| 确定性预览 | `node packages/qgate/bin/qgate.mjs preview --config demo/qgate.config.json --summary` |
| 生成报告 | `node packages/qgate/bin/qgate.mjs report --config demo/qgate.config.json --summary` |
| 解释判定 | `node packages/qgate/bin/qgate.mjs explain --gate build-deterministic --config demo/qgate.config.json --summary` |
| OCR 适配层预览 | `node adapters/opencodereview/bin/ocr-preview.mjs --diff adapters/opencodereview/demo/diff.json --rule adapters/opencodereview/demo/rule.json --json` |
| 引擎测试 | `node --test --experimental-test-isolation=none packages/qgate/test/{config-and-run-result,pipeline-and-checks,acceptance,schema-contract}.test.mjs` |
| 适配层测试 | `node adapters/opencodereview/tools/run-tests.mjs` |
| 重置 demo 证据基线 | `node packages/qgate/scripts/reset-demo-evidence.mjs` |

## 附录 C — 证据路径速查（真实存在）

| 阶段 | demo 实例（root = `demo/mini-service/`） | 本仓库根（root = 仓库根） |
|---|---|---|
| requirements | `REQUIREMENTS.md`、`.qgate/requirements-index.json`、`.qgate/approvals/req-to-design/approval.json` | `docs/00-requirements.md`、`docs/requirements-index.json` |
| design | `openapi.yaml`、`.opencodereview/rule.json`、`.qgate/approvals/design-to-build/approval.json` | `docs/01-architecture.md`、`schemas/*.schema.json` |
| build | `package.json`、`.qgate/evidence/test-results.json` | `packages/qgate/package.json`、`packages/qgate/test/*.test.mjs`、`packages/qgate/gates/contract.json` |
| review | `.qgate/negative/unknown-check-type.result.json`、`.qgate/negative/secret-include.result.json`、`.qgate/evidence/ocr-findings.json`、`.qgate/evidence/fix-budget-in-loop.json`、`.qgate/evidence/fix-budget-post-gate.json`、`.qgate/approvals/review-to-verify/approval.json` | `packages/qgate/examples/invalid/*.json`、`packages/qgate/examples/severity-mix.json`、`packages/qgate/examples/fixtures/provider-recordings.json` |
| verify | `.qgate/trace-matrix.json`、`.qgate/evidence/coverage.json`、`.qgate/evidence/ledger-index.json`、`.qgate/evidence/ledger-<run_id>.json`、`.qgate/reports/report-<run_id>.md` | `verification/trace-matrix.json`、`verification/evidence/ledger-index.json`、`verification/evidence/ledger-<run_id>.json` |
