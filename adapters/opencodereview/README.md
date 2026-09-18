# OpenCodeReview 适配层（adapters/opencodereview）

## 阶段审查接入

qgate 通过 `stage` 命令接收阶段化 OCR 结果。qgate 核心不继承模型密钥；真实 OCR 由显式的外部边界命令执行，再将 JSON 导入：

```text
node adapters/opencodereview/bin/ocr-stage-review.mjs \
  --stage review --root . --out .qgate/ocr/review.json
node packages/qgate/bin/qgate.mjs \
  stage review ingest --result .qgate/ocr/review.json --json
```

无模型环境使用 qgate 的离线路径：

```text
node packages/qgate/bin/qgate.mjs stage review review --mode offline --json
```

导入后的规范化证据位于 `.qgate/evidence/ai/<stage>.json`，AI finding 默认只告警；证据缺失或格式错误会 fail-closed。

把 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（CLI `ocr`）的
**确定性工程**部分复刻为可离线运行、零依赖、无需 API Key 的适配层，并在 `ocr` CLI
缺失或失败时**降级到本地实现**，为 `qgate` 门禁提供「选择 → 分组 → 规则命中」的
可复现输入。契约来源：`docs/00-requirements.md` REQ-QUALITY-GATE-012 与
`docs/01-architecture.md` §4.1 / §6.2 / §8.2。

> 本目录 **不修改** `packages/qgate/**`（core-engineer 的范围），也 **不 import** 其内部模块；
> 需要引擎能力时只通过冻结的 CLI 契约调用。

---

## 1. 集成方式

### 1.1 作为 CLI 使用（推荐，CI 与本地一致）

```bash
# 预览某个变更集的选择/分组结果（确定性、不调用 LLM）
node adapters/opencodereview/bin/ocr-preview.mjs \
  --diff adapters/opencodereview/demo/diff.json \
  --rule adapters/opencodereview/demo/rule.json --json

# 扫描整个目录（无 diff 时）
node adapters/opencodereview/bin/ocr-preview.mjs --root path/to/repo --json

# 输出 selection.md 风格三列表格
node adapters/opencodereview/bin/ocr-preview.mjs --root path/to/repo --md

# 落盘（stdout 只打印一行摘要，适合 CI 静默场景）
node adapters/opencodereview/bin/ocr-preview.mjs \
  --diff changes.json --rule rule.json --json \
  --out verification/evidence/ocr-selection-preview.json
```

**相对路径锚点**：`--diff` 中的相对路径以 `--root`（省略时为本进程 cwd）为锚。
`demo/diff.json` 的路径以 `adapters/opencodereview/demo` 为锚，因此可直接配合
`--root adapters/opencodereview/demo` 使用（`--diff` 与 `--root` 可同时给出：前者提供
变更集，后者提供规则发现锚点与文件大小解析根）。

参数表：

| 参数 | 说明 |
|---|---|
| `--diff <path>` | 变更集 JSON（字符串数组或 `{files:[{path,status,binary?}]}`） |
| `--root <dir>` | 单独使用时枚举目录；与 `--diff` 同时给出时作为**规则发现锚点**与文件大小解析根 |
| `--rule <path>` | 最高优先规则文件（`--rule` > 项目 > 用户 > 内置） |
| `--project-rule` / `--user-rule` / `--home` | 显式覆盖项目级/用户级规则路径与家目录（测试与多仓库场景） |
| `--include <glob>` / `--exclude <glob>` | 追加到**最高层**的模式（可重复；**不能**救回密钥路径） |
| `--max-files <n>` | 每组文件数上限（硬上限 `10`，调大无效） |
| `--token-budget <n>` | 每组 token 预算（超预算降级为单文件桶） |
| `--group-mode auto\|single\|per-file` | 分组模式 |
| `--explain <path>` | 只解释指定路径的最终命中规则（可重复），结果在 `ruleMatch[]` |
| `--ocr-bin <path>` / `--use-ocr` / `--no-ocr` | ocr 可执行文件 / 允许调用 ocr / 强制本地 |
| `--json` / `--md` | 互斥；分别输出 JSON 与 Markdown 表格 |
| `--out <p>` / `--print-selection-md <p>` | 额外原子写盘（JSON / Markdown） |
| `--quiet` | 抑制 stderr 进度日志 |

退出码（与 `qgate` 契约一致）：`0` 成功（**ocr 缺失时仍为 0**）｜`2` 配置错误
（参数非法、diff/规则不可解析，`error.code="CONFIG_INVALID"`）｜`3` 内部错误。

### 1.2 作为模块使用

```js
import { createPreview, renderMarkdown } from '@ai-quality-gate/ocr-adapter';
// 或： import { createPreview } from './adapters/opencodereview/src/ocr-pipeline.mjs'

const { payload } = createPreview({ diff: 'changes.json', cliRulePath: 'rule.json', maxFilesPerGroup: 10 });
if (!payload.safety.no_sensitive_selected) throw new Error('SAFETY_VIOLATION');
// payload.groups → 每个 ≤ 10 文件、超预算已降级、可直接喂给评审 prompt
```

导出的子模块：`selection.mjs`、`grouping.mjs`、`rules.mjs`、`filters.mjs`、
`ocr-runner.mjs`、`reflection.mjs`（见 §7 目录结构）。

> **与契约 §6.2.1 的形状关系（如实记录现状，含未解决的字段名不一致）**
>
> `docs/01-architecture.md` §6.2.1 现已把 `qgate preview --json` 的 `ruleMatch`
> 冻结为**逐文件数组**（不是单个对象）；本适配层的 `ruleMatch` 同样是**逐文件数组**，
> 且满足契约的两条形状规则：长度等于被选中文件数、第 *i* 项 `file` 与 `selection.included[i]`
> 一一对应。**形状已一致。**
>
> **字段名集合不一致，本节不声称任何「兼容保留」。** 逐字段映射的**唯一权威出处**是
> **`docs/01-architecture.md` §6.2.2「适配层 `ocr-preview` 与 `qgate preview` 的字段名映射（冻结）」**，
> 名下的已知偏差记账在 **§6.2.3「字段名对齐缺口」**（GAP-1…GAP-4）。本 README 不再复写映射表，
> 以免两份文档各写一套而漂移；此处只保留本层的结论与读法：
>
> - **保留本层 OCR 原生命名**（captain 裁决，t12）：本层刻意贴近 `ocr` 的真实 JSON 输出形状以保持互操作，
>   重命名会破坏这种保真度并牵连 `test/fixtures/*.json` 的字节级回归，因此**不做字段名对齐**。
> - 本层 `ruleMatch[]` 输出 `{decision, file, pattern, priority, reason, ruleId, ruleSource}`；
>   契约 §6.2.1 冻结 `{file, ruleSource, ruleId, match, severity, category, priority}`。
>   等价关系：`pattern ≡ match`；`severity`/`category` 本层未输出；`decision`/`reason` 为本层额外字段。
> - 本层 `groups[]` 输出 `{id, files, downgraded, estimated_tokens, file_count, downgrade_reason}`；
>   契约冻结 `{id, files, downgraded, tokens}`，等价关系：`estimated_tokens ≡ tokens`。
> - 本层 `selected[]` / `excluded[]` 使用 **snake_case**（`rule_id`、`rule_source`、`decided_by`，
>   另有 `size`、`tokens`、`severity`），与同一份产物内 `ruleMatch[]` 的 **camelCase** 不一致；
>   完整对应关系与「同一产物两套命名风格」的风险说明见 §6.2.2 与 §6.2.3 GAP-2。
> - **命名分层的设计理据（对 §6.2.3 GAP-2 的补充解释）**：GAP-2 记录的是「同一产物里有两套命名风格」
>   这个**事实**；本节补充它**为什么不是漂移**。实测规律（数据取自 `test/fixtures/preview.default.json`
>   的真实输出，四个集合逐键清点）：
>
>   | 输出集合 | camelCase（默认风格） | snake_case |
>   |---|---|---|
>   | `selected[]` | `path`、`pattern`、`reason`、`size`、`tokens`（均为**本层独有**） | `rule_id`、`rule_source`、`decided_by`（本层独有） |
>   | `excluded[]` | `path`、`pattern`、`reason`（本层独有）、`severity`（与引擎同名） | `rule_id`、`rule_source`、`decided_by`（本层独有） |
>   | `ruleMatch[]` | `file`、`ruleSource`、`ruleId`、`priority`（**与引擎同名**）、`pattern`、`reason`、`decision`（本层独有） | —（无） |
>   | `groups[]` | `id`、`files`、`downgraded`（与引擎同名）、`file_count`、`downgrade_reason`（本层独有） | `estimated_tokens`（→ 引擎 `tokens`） |
>
>   **精确规律（一条单向蕴含）**：**snake_case 只用于「适配层自造、引擎侧没有同名概念」的字段**
>   （`decided_by`、`rule_id`、`rule_source`、`estimated_tokens`、`file_count`、`downgrade_reason`
>   ——实测 9 个 snake_case 键**全部**是适配层独有，**零例外**）；**camelCase 是默认风格**，
>   既用于与引擎同名的交集字段，也用于本层自造的大多数字段（`path`、`reason`、`size`、`tokens`…）。
>   因此 **`snake_case` 是可靠的信号（出现即意味着「本层自造」），`camelCase` 不是**
>   ——看到 camelCase 不能推断该字段引擎也有。
>   **关键反证（说明这是刻意分区而非历史遗留）**：若属遗留漂移，`ruleMatch[].ruleId` /
>   `ruleSource` 早该与 `selected[].rule_id` / `rule_source` 一起统一成 snake_case；
>   二者**同值同义**却**刻意不同名**，且在 `ruleMatch[]` 内与同样源自引擎的 `file` / `priority`
>   保持同一风格——这正是「按来源分区」的证据。注：上表里 `groups[]` 的 camelCase 字段
>   （`downgraded`、`files`、`id`）与 snake_case 字段（`file_count`、`downgrade_reason`）
>   **混用在同一集合内**，说明分区判据是**逐字段的来源**而不是「整个集合用一套风格」；
>   §6.2.3 GAP-2 把 `groups[]` 计入「混用」与此实测一致，两者不冲突。
> - **`severity` 是同名异义（下游不得直接比较）**：两侧都有 `severity` 这个名字，但**语义来源完全不同**：
>   - **引擎侧**（`packages/qgate/src/rules.mjs` 的 `BUILTIN_RULES` 带 `{id, match, severity, category}`）：
>     `severity` 表示**规则条目声明的严重度**——是「这条规则有多重要」。
>   - **适配层**：`severity` 表示**过滤判定类别**——是「这个文件为什么被剪掉」。
>     由 `src/filters.mjs` 的 `classifyFile()` 产出：敏感路径 = `blocker`（安全不变量），
>     其余排除原因 = `info`（默认目录 / 二进制 / 扩展名 / 规则层命中）。
>   - 两者**同名、同型（string），但取值域与含义都不同 ⇒ 不可直接比较或聚合**；
>     若下游把本层的 `blocker`/`info` 当作引擎的 `blocker`/`high`/`medium`/`low` 使用，
>     会立刻得出错误结论（本层永远不会出现 `high`/`medium`/`low`）。详见 §6.2.2 与 §6.2.3 GAP-4。
>   - **管道现状（已知能力缺口，本轮不修代码）**：`classifyFile()` 确实为每个分支产出 severity
>     （`src/filters.mjs` L175 敏感路径 `blocker`；L187/L199/L210/L224 其余 `info`），
>     但 `src/rules.mjs` 的 `explainFile()`（L208-221）**没有把 `classification.severity` 传出去**
>     （该函数返回体里没有 severity），因此 **`ruleMatch[]` 与 `selected[]` 都看不到它**；
>     当前**唯一对外泄露处**是 `src/ocr-pipeline.mjs` L148 的 `excluded[].severity`
>     （安全层写 `safety-invariant`，其余写 `info`）。
>     即：**有模型、有取值、无管道**——属已记账的能力缺口；是否补输出由 captain 决定
>     （captain 已裁决本轮不补：若沿用 `severity` 这个名字塞进 `ruleMatch[]`，
>     会与引擎的 severity **同名并置**而产生新的语义碰撞，净负）。
> - `category` **是引擎侧独有，本层不存在**（不是「未输出」而是「无此概念」）：本层 `src/*.mjs`
>   与 `bin/*.mjs` 中 `category` 出现 **0 次**，规则文件条目语义只有 `{id, pattern, reason}`，
>   没有分类槽位；而引擎的规则条目带 `category`（如 `tests`/`config`）。详见 §6.2.2 与 §6.2.3 GAP-4。
> - `selection.included[]` 与 `selection.excluded[{path,reason}]` 与契约逐字一致（camelCase），
>   是 `selected[]` / `excluded[]` 的投影视图（见 §6.2.2.4）。
> - **`priority` 基准是语义级差异，不是命名差异**：本层 `ruleMatch[].priority` 为 **1 基**，
>   引擎为 `RULE_SOURCES.indexOf` 的 **0 基**；跨侧比较/排序会得到错误结果。详见 §6.2.3 GAP-1。
>   跨侧取值前必须归一化：**`engine_priority = adapter_priority - 1`**（即 `adapter_priority = engine_priority + 1`）。
>   worked example：同一文件命中 `--rule` 层时，本层报 `priority = 1`，引擎报 `priority = 0`
>   （引擎 `RULE_SOURCES = ['--rule','project','user','builtin']`，`indexOf('--rule') === 0`）；
>   本层还多一个 `cli:flags` 覆盖层取 `priority = 0`（运行期叠加、不占固定层号），
>   该类条目在引擎侧不存在对应层，**不可用该公式换算**。
>
> 面向消费者的兼容读法：单文件诉求取 `ruleMatch[0]`；跨侧取值前先读 §6.2.2 的映射表，
> 记住 `pattern ≡ match`、`estimated_tokens ≡ tokens`，且 `priority` 不可跨侧直接比较。
>
> 校验方法：`ruleMatch.length === selection.included.length`（实测两者均为 14，
> 见 §2 与 `test/fixtures/preview.default.json`）。

### 1.3 接入 qgate 门禁

| 对接点 | 说明 |
|---|---|
| `qgate preview` | 语义等价：`--root` → `selection.included/excluded`、`groups[]`、`ruleMatch[]`；其中 `ruleMatch` 与修订后的 `docs/01-architecture.md` §6.2.1 **同为逐文件数组**（旧契约曾描述为单个对象，现已由 §6.2.1 更正，本适配层无需迁就对象形状），`selection.included[]` 与 `selection.excluded[{path,reason}]` 与契约逐字一致；**字段名映射与已知偏差以 §6.2.2 / §6.2.3 为准**（本层保留 OCR 原生命名，`pattern ≡ match`、`estimated_tokens ≡ tokens`，`priority` 基准不同）。同一份 `src/selection.mjs` + `src/grouping.mjs` 同时驱动预览与真实执行 ⇒ 预览即执行。 |
| `qgate check`（provider `external`） | 本适配层产出的 `groups[]` 与 `files[]` 作为外部 provider 的输入（`provider.type="external"`），调用方式按冻结契约走 CLI，不 import 引擎内部模块。 |
| `policy` 类 check | 直接用 `payload.safety.no_sensitive_selected` / `violations[]` / `grouping.invariant_ok` 做断言（零密钥、密钥路径不可被 include 纳入、分组不变量）。 |
| 证据制品 | `--out verification/evidence/ocr-selection-preview.json` 作为可复核证据；`.github/workflows/quality-gate.yml` 的 build job 会上传它。 |
| CI | `.github/workflows/quality-gate.yml`（本目录 `ci/github-actions.yml` 为可复用模板，输入参数见文件头注释）：恰好 5 个 job，每个阶段一条 `qgate check --stage <stage>`，`verify` 跑完整流水线并校验 3 个人类门禁审批制品。 |

---

## 2. 预览输出样例（**真实运行结果**）

命令（在本仓库根执行，`ocr` 不在 PATH 上）：

```bash
node adapters/opencodereview/bin/ocr-preview.mjs \
  --diff adapters/opencodereview/demo/diff.json \
  --rule adapters/opencodereview/demo/rule.json --json
```

> 完整输出已存档为 `test/fixtures/preview.default.json`（由真实运行生成，
> 并由 `test/fixtures.test.mjs` 在每个测试轮次重新运行比对，见 §4）。
> 下面只摘录关键片段，**未做任何手工美化**。

```json
{
  "mode": "preview",
  "schema_version": "1.0.0",
  "llm_called": false,
  "degraded": true,
  "degraded_reason": "OCR_CLI_NOT_FOUND",
  "provider": {
    "name": "local",
    "requested": "auto",
    "ocr_available": false,
    "ocr_bin": null,
    "degraded": true,
    "degraded_reason": "OCR_CLI_NOT_FOUND",
    "llm_called": false,
    "note": "preview 走本地确定性实现（与执行同源），不调用 ocr，也不调用 LLM"
  },
  "counts": {
    "candidates": 23, "selected": 14, "excluded": 9, "groups": 4,
    "downgraded_groups": 0, "single_file_groups": 0,
    "excluded_sensitive": 5, "excluded_binary": 1, "excluded_dir": 2, "excluded_extension": 1
  },
  "selectedPaths": [
    "src/chain/chain.test.mjs",
    "src/chain/user-handler.mjs",
    "src/chain/user-mapper.mjs",
    "src/chain/user-repository.mjs",
    "src/chain/user-service.mjs",
    "src/reader/reader-part-1.mjs",
    "…",
    "src/util/format.mjs"
  ],
  "excludedPaths": [
    ".env.production",
    ".opencodereview/secrets/db-password.txt",
    "assets/logo.png",
    "config/service-account.json",
    "config/tls/server.pem",
    "dist/bundle.js",
    "node_modules/left-pad/index.js",
    "src/chain/id_rsa",
    "src/chain/user-handler.mjs.bak"
  ],
  "groups": [
    { "id": "bucket:injection-chain", "file_count": 4, "estimated_tokens": 306, "downgraded": false,
      "files": ["src/chain/user-handler.mjs", "src/chain/user-mapper.mjs", "src/chain/user-repository.mjs", "src/chain/user-service.mjs"] },
    { "id": "src/chain", "file_count": 1, "estimated_tokens": 104, "downgraded": false,
      "files": ["src/chain/chain.test.mjs"] },
    { "id": "src/reader", "file_count": 8, "estimated_tokens": 672, "downgraded": false,
      "files": ["src/reader/reader-part-1.mjs", "…", "src/reader/reader-part-8.mjs"] },
    { "id": "src/util", "file_count": 1, "estimated_tokens": 20, "downgraded": false,
      "files": ["src/util/format.mjs"] }
  ],
  "safety": {
    "no_sensitive_selected": true,
    "violations": [],
    "rule": "SAFETY-001: selected 列表不得包含密钥/凭证路径、二进制、默认排除目录、不支持扩展名",
    "sensitive_paths_never_reincludable": true,
    "grouping_invariants_ok": true,
    "grouping_violations": []
  }
}
```

**读取要点**：

- `mode="preview"`、`llm_called=false` —— 预览永远不触发模型调用。
- `degraded=true` / `degraded_reason="OCR_CLI_NOT_FOUND"` —— 本机没有 `ocr`，已降级为本地实现，命令仍退出 `0`。
- `.env.production` **只出现在** `excludedPaths`，`reason="sensitive_path_never_included"`，
  `rule_source="SAFETY_INVARIANT"`（`selected` 中不含任何密钥/凭证路径）。
- `bucket:injection-chain` 把 `handler → service → repository → mapper` 四文件放进**同一组**，
  保证跨文件注入调用链的上下文不被打断（`src/chain/chain.test.mjs` 不在该组内，因为它未被显式分桶规则收录）。

同一命令的 `--md` 输出（存档于 `test/fixtures/selection.default.md`）：

```markdown
# OpenCodeReview 选择预览（selection.md）

- provider: `local` ｜ degraded: `true` ｜ degraded_reason: `OCR_CLI_NOT_FOUND`
- llm_called: `false`
- 候选 23 ｜ 选中 14 ｜ 排除 9 ｜ 分组 4（降级 0）
- 安全不变量: 敏感路径进入 selected = 0 条违规（必须为 0）

## 文件 / 决策 / 原因

| 文件 | 决策 | 原因 | 规则来源 | 模式 |
|---|---|---|---|---|
| `.env.production` | excluded | `sensitive_path_never_included` | SAFETY_INVARIANT | — |
| `assets/logo.png` | excluded | `binary_file:extension` | SAFETY_INVARIANT | — |
| `dist/bundle.js` | excluded | `default_excluded_dir:dist` | SAFETY_INVARIANT | — |
| `src/chain/user-handler.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/chain/user-service.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/chain/user-repository.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/chain/user-mapper.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/chain/user-handler.mjs.bak` | excluded | `unsupported_extension:.bak` | SAFETY_INVARIANT | — |
```

---

## 3. 降级行为（ocr 缺失/失败，实测）

探测与调用由 `src/ocr-runner.mjs` 负责：

1. **探测**：按 `PATH` 找 `ocr`（Windows 还会尝试 `.cmd/.exe/.bat/.ps1`），执行 `ocr --version`；
   `--ocr-bin` 可显式指定。
2. **调用**（仅当显式 `--use-ocr` 且探测成功）：`ocr review --format json [--diff …] [--rule …]`
   并解析 stdout。
3. **降级**：探测失败、超时、非零退出、输出不可解析 —— 任一情况都回落到本地
   `src/selection.mjs` + `src/grouping.mjs`（与 `qgate preview` 同源），并在输出中标注
   `degraded:true` + `degraded_reason`，**命令仍退出 0**。

| `degraded_reason` | 触发条件 |
|---|---|
| `OCR_CLI_NOT_FOUND` | PATH 中找不到可执行的 `ocr` |
| `OCR_SKIPPED_BY_FLAG` | 显式 `--no-ocr` |
| `OCR_DISABLED_BY_ENV` | 环境变量 `OCR_DISABLE=1` |
| `OCR_EXIT_NONZERO` | `ocr review` 返回非 0 |
| `OCR_TIMEOUT` | 超过 `timeoutMs`（默认 60s） |
| `OCR_OUTPUT_NOT_JSON` | stdout 既非 JSON 也无法截取出 JSON 对象 |
| `OCR_SPAWN_FAILED` | 进程无法启动 |

**实测证据（本机 `ocr` 不在 PATH 上）**：

```console
$ node adapters/opencodereview/bin/ocr-preview.mjs --diff adapters/opencodereview/demo/diff.json \
    --rule adapters/opencodereview/demo/rule.json --json
$ echo $?
0
```

```json
{ "degraded": true, "degraded_reason": "OCR_CLI_NOT_FOUND",
  "provider": { "name": "local", "ocr_available": false },
  "counts": { "selected": 14, "excluded": 9, "groups": 4 } }
```

```console
$ node adapters/opencodereview/bin/ocr-preview.mjs --diff adapters/opencodereview/demo/diff.json \
    --ocr-bin adapters/opencodereview/demo/definitely-missing-ocr.exe --json
$ echo $?
0
```

`--ocr-bin` 指向不存在的文件同样降级（`OCR_CLI_NOT_FOUND`），退出码仍为 `0`；
`--no-ocr` 得到 `OCR_SKIPPED_BY_FLAG`；`OCR_DISABLE=1` 得到 `OCR_DISABLED_BY_ENV`。
三者的断言见 `test/ocr-runner.test.mjs`。

### 3.1 零密钥保证（可断言）

- 子进程环境是**白名单**：只透传 `PATH / Path / SystemRoot / windir / ComSpec / PATHEXT / TEMP / TMP`，
  并强制写入 `OCR_PROVIDER=deterministic`、`OCR_OFFLINE=1`、`OCR_NO_TELEMETRY=1`、`OCR_NO_API_KEY=1`；
  任何 `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` 都**不会**进入子进程（`buildChildEnv()`）。
- 适配层源码**不读取**任何密钥环境变量；`assertNoApiKeyRequirement()` 逐行扫描
  `src/`、`bin/` 的可执行代码并在测试中断言零违规。
- 测试会在进程内注入哨兵密钥（`ANTHROPIC_API_KEY=sk-sentinel-…`）后重跑，断言输出与无密钥时
  **字节级一致**且输出中不含该哨兵值。
- `demo/ocr-review.sample.json` 是**夹具（fixture）**，不是真实 ocr 调用结果，文件内 `_fixture:true` 与
  `_note` 已显式声明。

---

## 4. 安全不变量（由代码强制，不由提示词约束）

| 编号 | 不变量 | 落点 | 反向用例 |
|---|---|---|---|
| **S1** | 密钥/凭证路径检查**先于**任何用户 `include`，且任何 `include` 模式都无法把它重新纳入 | `filters.classifyFile()` step 0（命中即 `return excluded`，**根本不进入规则引擎**） | `test/selection.test.mjs`「最宽泛 include（`**/*`、`**/.*`、`secrets/**`）也无法把敏感路径重新纳入」 |
| **S2** | 二进制文件始终排除（扩展名 + 魔数空字节） | `filters.isBinaryFile()` | 同上「二进制文件始终排除」 |
| **S3** | 默认排除目录始终排除（`.git/`、`node_modules/`、`dist/`、`build/` …） | `filters.DEFAULT_EXCLUDE_DIRS` + `isInDefaultExcludedDir()` | 同上「默认排除目录始终排除」 |
| **S4** | 不支持的扩展名始终排除（白名单） | `filters.SUPPORTED_EXTENSIONS` | 同上「不支持的扩展名始终排除」 |
| **G1** | 每组文件数 ≤ `MAX_FILES_PER_GROUP = 10`（硬上限，调用方调不大） | `grouping.MAX_FILES_PER_GROUP` | `test/grouping-rules.test.mjs`「显式 maxFilesPerGroup 无法突破硬上限 10」 |
| **G2** | 组内估算 token 超预算 ⇒ 该组降级为**单文件桶** | `grouping.groupFiles()` + `perFileBuckets('token_budget_exceeded')` | `preview.token-budget-300.json` 回归 + 单元测试 |
| **G3** | 分组失败 ⇒ 回退逐文件桶，绝不产生「半个结论」 | `groupBy` 外层 `try/catch` + `grouping_failed` | 单元测试注入排序异常 |
| **G4** | 同输入两次运行结果**字节级一致**（顺序、键序、分组全部确定） | `util.sortPaths` / `stableStringify`；输入顺序打乱不影响输出 | 「同输入两次运行」「输入顺序打乱后结果不变」两条测试 |
| **S5** | 敏感路径/排除目录/密钥扩展名的匹配**大小写不敏感** | `filters.isSensitivePath()` / `isInDefaultExcludedDir()` / `isSensitiveExtension()` 先做 `toLowerCase()` 归一化；glob 侧 `globToRegExp(..., {caseInsensitive:true})` | `test/security-bypass.test.mjs` 的 B1 组（`Credentials.json`、`Secrets/db.txt`、`.ENV`、`ID_RSA`、`CONFIG/TLS/SERVER.PEM`） |
| **S6** | 硬链接别名不得静默纳入（`docs.txt` → `.env`） | `filters.detectHardlinkSecret()`：`nlink > 1` 且（与敏感 inode 同源 **或** 内容呈密钥形态）⇒ `reason=hardlink_secret_alias:*`、`ruleId=SAFETY-005-HARDLINK-ALIAS`、`severity=blocker` | `test/security-bypass.test.mjs` 的 H2 组 |
| **S7** | 适配层自带扫描器（SAFE_001 密钥读取面 / SAFE_003 网络调用面）**大小写不敏感**，且覆盖 import 别名；**导入网络模块本身即违规**（无需调用点）；**命名网络客户端调用**（`axios.get(url)`）亦违规 | `ocr-runner.mjs` 的 `assertNoApiKeyRequirement()`（`KEY_READ_PATTERNS` 全 `i` 标志）、`scanNetworkSurface()` + `extractNetworkAliases()` + `isNetworkModuleImport()` + `NET_CLIENT_CALL_RE` | `test/security-bypass.test.mjs` 的 H3 组（8 种 env 写法 + 4 种网络写法，含静态命名空间 import 别名）；`test/network-import.test.mjs`（导入面 4 形态 + 边界不放宽，见 §4.1/§4.2）；`test/network-vocab.test.mjs`（模块词表，见 §4.3）；`test/network-client.test.mjs`（客户端调用面 + 良性对照零误报，见 §4.4） |

**S5 的影响面（为什么是 blocker 级）**：CI 的 diff 常由**大小写敏感的 Linux/Ubuntu** 生成，
而排除清单按小写书写 —— 大小写敏感匹配下 `Credentials.json` / `Secrets/db.txt` 会被**静默纳入**
（凭证文件因此进入评审上下文，也就是会被送进模型），而 `safety.no_sensitive_selected` 仍报 `true`
（**假保证**）。现已在路径、目录、扩展名三处统一为大小写不敏感。

**S6 的判据次序（唯一说法，与实现一致）：身份链优先、内容形态兜底。**

依据是代码本身，不是本节措辞（t48 核对）：
`src/filters.mjs` 的 `detectHardlinkSecret()` 先在 `nlink > 1` 的文件上比
**`(dev:ino)` 同源**（L229-L233，返回 `via: same-inode-as-sensitive-path`），
只有该信号未命中时才读文件头做**内容形态**判断（L234-L239，返回 `via: secret-content-in-hardlinked-file`）。
`sensitiveInodes` 由 `src/selection.mjs` 从**按名判定的敏感候选**收集（含已被名字规则排除的那些，
因为别名需要被排除文件的身份）⇒ **inode 同源是第一判据，内容形态只是兜底**。

因此「Windows 上 inode 不可靠」这条取舍落在**兜底侧**：`st_dev`/`st_ino` 对硬链接可能给出不同值
（实测踩过，故不把身份链当唯一保证）；在那些文件系统上，
**正确性由内容形态兜底承担**，而内容形态是**启发式**——它按密钥形态（PEM 私钥块、
`sk-…`/`ghp_…`/`AKIA…`、`敏感名 = 实值`）判断，**不能保证召回**；
内容刻意不可判形态的密钥因此只在身份链可用时才会被拦住。
内容判定同时刻意区分**真密钥**与**占位符**（`PLACEHOLDER-NOT-A-REAL-KEY`、`your-api-key-here`、
`${…}`、`process.env.X` 取值等不命中），避免把演示夹具与文档误判为密钥材料。
（该内容扫描只作用于 `nlink > 1` 的**少数**文件，普通单链接文件零开销。）

**与引擎侧（`packages/qgate`）的不对称——如实记录**：两侧的**主判据相同**（都以 inode 同源为第一信号，
引擎侧注释也把 inode 标为 primary），**差异在兜底信号的性质**：

| | 主判据 | 兜底信号 | 性质 |
|---|---|---|---|
| 引擎 `packages/qgate` | `ino:<dev>:<ino>` 同源 | `sha:<size>:<sha256>` **与敏感文件字节完全相同** | **精确**（硬链接按定义就是字节相同） |
| 本适配层 | `(dev:ino)` 同源 | **内容形态**（PEM / `sk-…` / `敏感名 = 实值`） | **启发式**，不保证召回 |

⇒ 两侧不是「同一套判据」，也**不是**「一侧有身份链、另一侧只看内容」；
准确说法是**同一个主判据 + 性质不同的兜底**（精确 vs 形状启发式）。这是本适配层
相对引擎侧的**已知能力差距**：在 inode 不可靠的文件系统上，引擎靠字节相等仍能精确判定，
本层只能靠形态启发式。

硬链接别名以机器可读字段随输出给出：`safety.hardlink_aliases[]`（每项含 `path` / `via` / `nlink` / `patterns`）；
`selection.assertNoSensitiveSelected()` 也会**独立复检**该情形（不依赖路径判定的正确性），
即使路径过滤被回归破坏，断言仍会失败而不是给出假保证。

**S6 必须在 `--diff` 与 `--root` 两条路径都生效（t42 / blocker F1 的教训）**：
身份链依赖「根」，根错了身份集就为空。早期 `inferDiffRoots()` 只在
「diff 所在目录 / cwd 及其祖先」里找根，因此在两种**真实布局**下失手：

| 布局 | 早期行为 | 现在 |
|---|---|---|
| `<base>/diff.json` + `<base>/repo/…`（diff 与仓库并列，CI 常见） | 找不到 `repo/` ⇒ `sizeRoot=null` ⇒ **身份链失效** | `scanChildren(dir)` 覆盖 |
| `<base>/artifacts/diff.json` + `<base>/repo/…`（diff 落在子目录，仓库是其**父目录的兄弟**） | 同上 | `scanChildren(path.dirname(dir))` 覆盖 |
| diff 含大量已删除/未物化路径（命中率 < 50%，真实 diff 常态） | **直接丢弃根** ⇒ 身份集为空 | 低命中率仍返回根（只读锚点），并暴露 `lowConfidence` |

两条路径现在走**同一条判据链**（次序见上：身份链优先、内容形态兜底）：`--diff` 与 `--root` 都以
`sensitiveInodes`（敏感文件 `(dev:ino)` 集合）为第一判据，只有身份未命中才退到内容形态兜底。
回归测试：`test/hardlink-diff.test.mjs`（三类别名 × 三种布局 + 低命中率 diff + 无害硬链接不得误排除）。

**S7 区别于引擎侧 policy**：`packages/qgate` 有它自己的 SAFE_001/SAFE_003 实现（属引擎范围）；
本适配层的 `assertNoApiKeyRequirement()` 是**自带简化扫描器**，只对本层负责、不 import 引擎内部实现。
两侧同族问题分别由各自 owner 处理（引擎侧见 t34）。该扫描器同时用于 self-scan：
适配层自身 `src/`、`bin/` 必须零命中（`test/security-bypass.test.mjs` 的 self-scan 用例）。

### 4.1 SAFE_003 网络面：识别哪些形态、边界在哪（t54 / R3-L3）

**结论先说**：**导入网络模块这件事本身就构成网络面**，不要求在文件里出现调用点。
`import https from 'node:https';` 单独出现（不调用）即违规，`via='network-module-import'`。

修复前的缺陷（R3-L3）：适配层只在「别名被调用」时才报（`aliasRe` 匹配 `h.request(...)` 这类调用点），
而引擎侧 SAFE_003 的 matcher 本来就带 `network module import/require (network import surface)` 标签。
于是**同一个 SAFE_003 断言在两侧保证强度不同** —— 引擎报、适配层不报，
用户无法判断该信哪一侧。现对齐为「导入即命中」。

**识别的形态（都报，`via='network-module-import'`）**：

| 形态 | 示例 | `via` |
|---|---|---|
| 静态默认导入 | `import https from 'node:https';` | `network-module-import` |
| 静态命名空间导入 | `import * as h from 'node:http';` | `network-module-import` |
| 静态命名成员导入 | `import { request } from 'node:https';` | `network-module-import` |
| 动态导入（不绑定） | `await import("node:https");` | `network-module-import` |
| 动态导入（绑定） | `const m = await import("node:https");` | `network-module-import` |
| `require` | `const h = require('node:http');` | `network-module-import` |
| 导入**后调用**（原有判定不变） | `import https from 'node:https';` + `https.request('…')` | 导入行 `network-module-import`，调用行 `imported-module-alias` |
| 直接模块成员调用（原有判定不变） | `https.get('https://x');` | `module-member-call` |
| 全局网络函数（原有判定不变） | `fetch('https://x');` | `global-network-call` |
| 解构出的成员函数调用（原有判定不变） | `const { request } = await import('node:http');` + `request('…')` | `destructured-network-call` |
| 命名网络客户端调用（**t58 新增**） | `axios.get(url)`、`client.get(url)`（**文件里没有 import**） | `named-network-client-call`（见 §4.4） |

网络模块清单（`NET_MODULES`，匹配时同时接受带/不带 `node:` 前缀）：
`node:http|http`、`node:https|https`、`node:net|net`、`node:dns|dns`、`node:tls|tls`、
`node:dgram|dgram`、`node:undici|undici`。

> **两侧同判有三个维度，别把结论混用（t54 / t56 / t58）**：
> * **语法形态**（t54 / R3-L3）：导入行为本身即违规，`import … from` / `import()` / `require()` 三形态都判。
>   t54 的 12 例确实全部同判 —— 但**那批样本只用了 http/https/net/dgram/tls，没有 dns/undici**，
>   所以那条结论**覆盖不到词表维度**，不能当作「整个 SAFE_003 已同判」。
> * **模块词表**（t56 / F12）：引擎词表含 `dns` 与 `undici`，适配层早期漏了这两个 ⇒
>   `import 'node:dns'` / `require('undici')` 这类导入面**引擎报、适配层不报**（verifier 的 22 格扫描 4 格不同判）。
>   现已补齐，并加了一条**漂移自检**（见 §4.3）。
> * **客户端调用面**（t58 / F14）：引擎有「客户端包名 + HTTP-ish 成员」的名字启发式，适配层早期**完全没有** ⇒
>   `axios.get(url)` / `client.get(url)` 等 **10 格** engine=true / adapter=false。现已新增该面（见 §4.4）。
>
> 三条并存不矛盾：词表齐全之后，t54 的形态判定才能在每个网络模块上真正生效；
> 而「没有 import 的包名直呼」既不属于形态维度、也不属于模块词表维度，必须单列一面。

**刻意不报的（边界，不得放宽）**：

| 情形 | 示例 | 为什么不报 |
|---|---|---|
| 非网络模块 | `import fs from 'node:fs';`、`const p = require('node:path');`、`import os from 'os';` | 不在 `NET_MODULES` 内，不是网络面 |
| 注释行内的导入写法 | `// import https from "node:https";`、`/* require("node:https") */` | `isCommentLine()` 跳过，否则会把文档判成违规 |
| 显式否定行 | `// never require("node:https") — offline only` | `isNegatedLine()` 跳过 |
| **纯模块名字符串字面量** | `const s = 'node:https';`、`const s = \`net\`;` | 只有真实导入语法才算，单写字面量不构成导入 |
| 同上但**字面量内含导入语法** | `const s = "require('node:https')";`、`const s = 'import https from "node:https"';` | **报**——与引擎同判（实测：引擎对这类文本同样报）。这是文本级同形边界，两侧一致 |

**已知边界（如实列出，不声称已解决）**：

1. **文本级匹配，不做 AST/词法剥离**：判定靠正则 + 逐行过滤，因此「字符串字面量里**内嵌**完整导入语法」
   与真实导入无法区分（上表最后一行为两侧**同判**的一致性，而非本层独有缺陷）。
   若要根治需要真正的词法解析，属接入 OCR AST 能力的范围，本层不做。
2. **未闭合的块注释**（t64/F16 已修，此处保留描述以免误读旧版）：
   早期逐行扫描没有块注释状态机，`/*` 未闭合时其后紧跟的行会被判为代码；
   现已改为**显式状态机**（仅当确有开启符且尚未闭合时按注释处理）——见 §4.5。
   方向仍是**偏严**（可能多报、不会漏报）。
3. **跨行形态**（t64/F15）：被折行的链式调用已由「逻辑单元拼接」覆盖（§4.5）。
   仍未覆盖的是**跨行折叠的非调用形态**（例如别名与成员被拆到相隔多个无关语句的两行），
   以及**跨行字符串拼接**；这些属文本级匹配的固有边界。
4. **扫描范围两侧本就不同（不是判定差异）**：本层 `assertNoApiKeyRequirement()` 只遍历
   `.mjs/.js/.cjs/.json/.yml/.yaml`，且递归所有子目录。
   引擎侧 `scanSurface` 会**跳过** `prose`/`fixtures` 类路径与 `.git`、`node_modules`、`.qgate`、`coverage`、
   `dist`、`build`、`.cache`、`verification`、`verification-t9`、`artifacts` 等目录。
   于是「引擎在某个仓库根上扫出的文件集」与「适配层扫出的文件集」可以不同 ——
   这是**扫描范围**差异，**不是同一样本的判定差异**。可比的是**同一个 in-scope 样本上的判定**。

### 4.2 引擎 vs 适配层：同一批样本的判定对照（t54 实测）

做法：为每个样本单独建目录、写入一个 `sample.mjs`，分别调用引擎 `policySafe003(<dir>)`
（判定 = `passed === false`，即 `violations.length > 0`）与适配层 `assertNoApiKeyRequirement(<dir>)`
（判定 = `networkViolations.length > 0`）。**修复前**（适配层只在调用点报）：

| # | 样本（`sample.mjs` 内容） | 引擎 | 适配层（修复前） | 同判 |
|---|---|---|---|---|
| 1 | `await import("node:https");`（裸动态导入） | 报 | **不报** | ❌ |
| 2 | `const m = await import("node:https");`（绑定但从不调用） | 报 | **不报** | ❌ |
| 3 | `import https from 'node:https';` + `https.request('https://x');` | 报 | 报 | ✅ |
| 4 | `import https from 'node:https';`（不调用） | 报 | **不报** | ❌ |
| 5 | `const h = require('node:http');` + `h.request('http://x');` | 报 | 报 | ✅ |
| 6 | `const h = require('node:http');`（不调用） | 报 | **不报** | ❌ |
| 7 | `import * as h from 'node:http';` + `h.request('http://x');` | 报 | 报 | ✅ |
| 8 | `fetch('https://x');` | 报 | 报 | ✅ |
| 9 | `import fs from 'node:fs';` + `fs.readFileSync('x');` | 不报 | 不报 | ✅ |
| 10 | `const p = require('node:path');` | 不报 | 不报 | ✅ |
| 11 | `// see node:https for details` | 不报 | 不报 | ✅ |
| 12 | `const s = 'node:https';` | 不报 | 不报 | ✅ |

**修复前**：12 项中 4 项不同判（#1 #2 #4 #6），全部是「导入但不调用」——即 R3-L3。
**修复后**：12 项 **全部同判**（再次实测，差异项为空）。

修复后仍**保留**的不对称只有上面「已知边界」第 1、2、3 条：
第 1 条（字面量内嵌导入语法）是两侧**同判**的文本级共性；第 2 条方向偏严；
第 3 条是**扫描范围**差异，不改变同一样本上的判定。
除此之外，本层不再存在「同一断言强度不同」的情形。

回归用例：`test/network-import.test.mjs`（7 组）。
自证：把 `scanNetworkSurface()` 里的 `if (isNetworkModuleImport(line)) {…}` 分支临时删除后，
该文件 **4 组失败 / 3 组仍绿**（失败的是导入面与同判用例，仍绿的是「非网络模块/注释/纯字面量不报」的边界用例——
正好证明修复没有把边界放宽）；恢复后全绿。

### 4.3 词表维度：模块清单对齐与漂移自检（t56 / F12）

**词表对齐实测（41 格，覆盖「模块名 × 形态」与调用面族）**。
判定口径与 §4.2 相同（引擎 = `policySafe003(dir).passed === false`；适配层 = 目录级 `networkViolations.length > 0`）。
**修复前** 17/41 不同判，**修复后**降到 12/41；把「模块导入面」这一族单独拎出来看：

| 族 | t56 修复前不同判 | t56 修复后不同判 | 说明 |
|---|---|---|---|
| **模块名 × {import_from, require}**（22 格：http/https/net/tls/dgram/dns/http2/undici/axios/node-fetch/got） | **4**（`dns`、`undici` 各 2 形态） | **0** | ✅ t56/F12 的修复目标 |
| 命名网络客户端调用（`axios.get()`、`ky.get()`…） | 10 | 10 → **t58 已修，见 §4.4** | ✅ t58/F14 |
| 全局网络名（`XMLHttpRequest()`、`WebSocket()`） | 2 | 2 | ⚠ 本层比引擎**更严**，**刻意保留**（见下） |
| 网络模块成员调用（`dns.resolve4()`） | 1 | 1 | ⚠ 已知不对称，未改（见下） |

22 格中 `http2`/`axios`/`node-fetch`/`got` 这 4 个模块名**两侧都不报**（引擎的词表只到
`https?|net|dns|tls|dgram|undici`），所以「22 格全部同判」的准确说法是：
**引擎词表内的 7 个模块 × 2 形态 = 14 格全部同判（都报），其余 8 格也全部同判（都不报）。**

**漂移自检（防下次再漂移）**：`test/network-vocab.test.mjs` 有一条用例从**引擎源码文本**里
解析 `NET_MODULE_NAMES` 字面量（只读，不 import），断言**适配层词表 ⊇ 引擎词表**。
自检实测（构造「缺一项」）：删掉副本里 `dns` 两项后，自检报
`适配层 NET_MODULES 缺少引擎词表项 ["dns"]；引擎原字面量 = ["https?","net","dns","tls","dgram","undici"]，适配层 = ["dgram","http","https","net","tls","undici"]`。
另有「解析失败必须响亮失败」与「自检本身有效（不是永远通过的摆设）」两条用例。
（t58 对客户端名单/成员表用了同一套做法，见 §4.4。）

**为什么用「读文本 + 自检」而不是「从引擎单一来源导出」**（captain 在 t56 里点名要的说明）：
适配层与引擎之间只允许**经 CLI 契约**对接。直接 `import` 引擎的 `policy.mjs` 会把本层绑到
引擎内部实现上（引擎重构内部结构即会连带打破本层），破坏分层；而把它做成运行时依赖，
就相当于承认「适配层不是独立可跑的」。因此选择「补词表 + 测试期漂移自检」：
不破坏分层，又能让下一次漂移**直接失败**而不是静默通过。
该自检读取路径可用环境变量 `OCR_ENGINE_POLICY_PATH` 覆盖（供临时隔离副本的自证使用）。

**仍然存在的已知不对称（如实登记，避免误以为已全部同判）**：

| 不对称 | 引擎 | 适配层 | 为什么不改 |
|---|---|---|---|
| 网络模块成员调用 `dns.resolve4(...)` | 报 | 不报 | `dns` 进词表后其**导入面**已同判；成员调用面需要另加成员词表（属另一条，未派单） |
| 全局 `XMLHttpRequest()` / `WebSocket()` 直接调用 | 不报 | **报** | 本层**偏严**（fail-closed 方向）：Node 里两者都是全局网络名，多报的代价是改名，漏报的代价是静默联网。**改成更松是安全倒退，故刻意保留**（t58 明确要求不动，并已用 `test/network-client.test.mjs` 锁死） |

即：第一条是「本层更松」，第二条是「本层更严」——方向相反，读者不应把它们当成同一类问题。

### 4.4 命名网络客户端调用面（t58 / F14）

**本层新增了这一面**。早期本层完全没有它 ⇒ `axios.get(url)`、`client.get(url)`、`ky.get(url)` 等
**10 格**与引擎不同判（engine=true, adapter=false），与 t54（语法形态）、t56（模块词表）同类：
**同一 SAFE_003 断言两侧保证强度不同**。

**为什么需要独立一面**：这类写法**文件里没有 import**，绑定无法从文本恢复，
只能靠「客户端包名 + HTTP-ish 成员」这一组合判断（引擎侧 `NET_CLIENT_NAMES` × `NET_CALL_MEMBERS`）。

**识别规则（与引擎逐项对齐的精确组合，不是粗放 `*.get()`）**：

* 客户端名（12）：`axios`、`got`、`superagent`、`needle`、`undici`、`ky`、`node-fetch`、
  `request`、`client`、`httpClient`、`apiClient`、`httpAgent`
* 成员（14）：`request`、`get`、`head`、`post`、`put`、`patch`、`delete`、`options`、
  `send`、`connect`、`createServer`、`createConnection`、`Socket`、`Server`、`bind`
* 命中形态：`<客户端名>.<成员>(` ，报出 `via='named-network-client-call'`

**良性对照零误报 —— 机制说明**：`cache.get(key)`、`headers.get('x')`、`new Map().get(k)`、
`config.get()`、`store.get()`、`session.get()`、`params.get()`、`query.get()` … 之所以**不报**，
**不是因为维护了一份「排除名单」，而是因为这些名字根本不在客户端名单里**。
（这与「粗放匹配 `*.get()` 会把 22 条良性写法全打成违规」是同一件事的两面。）
实测良性集 **22 条 0 误报**（含引擎自带对照 `cache.get` / `headers.get` / `new Map()`；
t36/t45 提到的「11 条」没有落成持久产物，本次自建了更大且等价的集合，并以**引擎实测**为准）。
另有 6 条「客户端名 + **非** HTTP 成员」（`axios.toString()`、`axios.all()`、`client.close()`、
`ky.config()`、`got.defaults`、`client.count`）也**不报**——成员必须在成员表内。

**实测对照（72 格，引擎 vs 适配层同判情况）**：

| 族 | 格数 | 同判 | 说明 |
|---|---|---|---|
| 命名网络客户端调用（12 名字 × 3 成员） | 36 | **36** | 修复后全部同判（都报） |
| 良性对照（非网络语义对象） | 22 | **22** | 全部同判（都不报），**0 误报** |
| 客户端名 + 非 HTTP 成员 | 4 | **4** | 全部同判（都不报） |
| 名字碰撞（见下） | 7 | **7** | 全部同判（都报） |
| 全局网络名（`XMLHttpRequest`/`WebSocket`/`fetch`） | 3 | 1 | 2 格本层更严，**刻意保留** |

合计 **70/72 同判**，仅剩的 2 格是本层**更严**的 `XMLHttpRequest()` / `WebSocket()`（下述）。

**这一面的代价：名字碰撞（如实登记，不假装零成本）**。
`request` 与 `client` 同时是客户端名，因此**从非网络对象绑定同名后再调用也会被报**，例如
`const request = require('node:fs'); request.get(url);`、`const client = makeCache(); client.get(key);`、
`function f(client) { return client.get(key); }`。**引擎对这类形态同样报**（本次实测 7/7 都报），
所以本层照搬以保持两侧同判。这是引擎既有的 fail-closed 取舍
（**多报的代价是改名，漏报的代价是静默联网**），并非本层新增的缺陷——
但它**确实会把 `client.get(...)` 这类在缓存/映射客户端语义下常见的写法判为违规**，
使用者在引入 `client` 这个名字前应知晓。若引擎将来收紧这一面，本层应同步收紧
（`test/network-client.test.mjs` 的「名字碰撞两侧都报」用例会随之调整并留下记录）。

**刻意保留的两条「本层更严」（不得为「同判」而改成更松）**：
`XMLHttpRequest()` 与 `WebSocket()` 的**直接调用**，本层报、引擎不报。理由是方向：
在 Node 里两者都是可用的全局网络名，**多报的代价是改名，漏报的代价是静默联网**，
所以这是 fail-closed 方向；把它改成更松是**安全倒退**。
`test/network-client.test.mjs` 有一条用例**专门锁死**这一点，防止后人以「两侧同判」为名删掉它。

回归用例：`test/network-client.test.mjs`（10 组）。自证：删掉 `scanNetworkSurface()` 里
`if (NET_CLIENT_CALL_RE.test(line)) {…}` 分支后，该文件 **5 组失败 / 5 组仍绿**
（失败的是「必须报」类；仍绿的是良性对照与两条边界类 —— 证明缺陷被捕获、
且修复不是靠放宽边界换来的）；恢复后全绿。

### 4.5 跨行链式调用与块注释状态机（t64 / F15、F16）

两条都属「漏判 ⇒ 本层更松」，与 t54/t56/t58/R3-B1 同族。

**F15（medium）跨行链式调用**。`prettier` 默认会把长链式调用折行：

```js
const r = await ky
  .get(url);
```

本层早期**按行**扫描命名客户端调用，而引擎按**整段**匹配 ⇒ 折行后本层看不见（实测 5/7 漏判）。
现改为两级判定：按行照旧，另把**相邻非注释行**拼成「逻辑单元」（`ky .get(url)`）再匹配一次；
补报仅在「该单元内单行都没报出」时发生，避免重复计数。
**取舍**：选「逻辑单元拼接」而不是「让正则跨行」——后者会让 `\s*` 吞掉换行、把上下两条无关语句
也拼成命中（例如 `const a = ky;\n// ...\nconst b = get(url);` 这类），而单元拼接限定在相邻代码行，
误报面更小。实测 22 条良性对照**单行与折行两种形态都 0 误报**。

**F16（low）未闭合 `/*` 之后的 ` * ` 行**。`isCommentLine()` 把 ` * …` 一律当 JSDoc 续行跳过 ⇒
`/*` **未闭合**时，后面的真实代码被整体跳过（引擎侧 t46 已按 fail-closed 修过同族问题，本层是残留）。
现引入块注释状态机，判据是**「确实有开启符、且尚未闭合」才按注释处理**：

| 文本 | 处理 | 理由 |
|---|---|---|
| `/**\n * axios.get(url);\n */` | 静默 | 开启符与关闭符都在文本中 ⇒ 确为块注释 |
| `/*\n * axios.get(url);` | **报** | 开启符**从未闭合** ⇒ 星号行不属于任何注释块（fail-closed） |
| `/* oops\n * ky.get(url);` | **报** | 同上 |
| 孤立的 ` * import …`（文本里没有开启符） | **报** | 合法 JSDoc 中 `*/` 总在 `*` 行**之后**；无开启符即无注释块 |
| `// …`、`# …`、`<!-- … -->` | 静默 | 行注释形态，与旧集合一致 |
| `/* axios.get(url); */` | **报** | 注释与代码**同行**时不算整行注释（与引擎一致） |

**关于「孤立星号片段」的诚实说明**：` * import https from "node:https";` 单独出现时，本层现在**报**。
这看起来像把文档判成违规，但**引擎对同一文本也报**（t64 实测交叉验证，见用例
「与引擎逐判同判」）。真实文件里的 JSDoc 一定有开启符，所以这个差异只出现在「片段被单独喂入」
的场景 —— 而那种场景下「按注释跳过」才是没有依据的。**若读者认为应保留「星号行一律跳过」的旧行为，
请注意那正是 F16 缺陷本身**，且与引擎不同判。

回归用例：`test/crossline-and-comment.test.mjs`。自证：停用跨行补报 ⇒ 3 组失败；
把 `insideOpenBlock(idx)` 改回 `true`（恢复旧行为）⇒ 3 组失败；恢复后全绿。

### 4.6 路径拼写变体与名规则（t64 / F17）

**要害是「对规则」而不是「对答案」**（R3-B1 判据）：变体必须由**名规则**命中
（`reason=secret_path...`），而不是仅被扩展名白名单**兜住**（`reason=unsupported_extension...`）。

| 变体 | 修复前 | 修复后 |
|---|---|---|
| `.env::$DATA`（NTFS ADS） | `unsupported_extension:.env::$DATA`（兜底） | **`sensitive_path_never_included` + `SAFETY-001-SENSITIVE-PATH`** |
| `.env:stream` | `unsupported_extension:.env:stream`（兜底） | **名规则命中** |
| `secrets/db.txt::$DATA` | 名规则命中（目录段） | 名规则命中（不变） |
| `credentials.json::$DATA` | 名规则命中（前缀） | 名规则命中（不变） |
| `.env ` / ` .env`（空白变体） | `unsupported_extension:*`（兜底，**仍排除**） | **同左（未变）** |
| `CREDEN~1.JSON`（8.3 短名） | 纳入 | **纳入（已登记边界，见下）** |

做法：新增 `stripAlternateDataStream()`，在名规则/扩展名判定**之前**切掉最后一段里的 ADS 后缀
（`::` 或 `:` 之后的部分）。**只切最后一段**，所以 `secrets/db.txt::$DATA` 仍保留 `secrets/` 段、
目录类名规则照常命中；目录段里的冒号不受影响（`weird:dir/a.mjs:stream` ⇒ `weird:dir/a.mjs`）。

**空白变体为什么刻意不 trim（反直觉，但有实测依据）**：
Windows **不会**剥掉文件名的尾随空格 —— 实测创建 `.env ` 后 `readdirSync` 返回 `.env `，
且 `.env` 不存在；只有写 `.env::$DATA`（ADS）才会产生基础文件 `.env`。
⇒ `.env ` 与 `.env` 是**两个不同文件**，把前者当后者判会引入事实错误。
所以空白变体仍由结构规则兜住并排除（安全判定未放宽），但其 `reason` 是**兜底**而非名规则 —— 这一点如实登记，不假装是名规则命中。

**8.3 短名（`CREDEN~1.JSON`）：本层**不能**可靠判定，如实登记为已知边界。**
verifier 实测 `fsutil 8dot3name query` ⇒ Access denied（需权限，本层也不得依赖外部命令）。
本次用不依赖 fsutil 的方式独立复核，得到**决定性**事实：

* 在 `credentials.json` 存在的目录里，`CREDEN~1.JSO` **存在**（这是真实的 8.3 别名形态），
  而 `CREDEN~1.JSON` **不存在**；
* **创建** `CREDEN~1.JSON` 后，`credentials.json` 的内容**不变** ⇒ 它是**独立的字面文件**，
  **不是**别名。

⇒ 本层对 `CREDEN~1.JSON` 「按字面文件名处理」是**正确**行为，不是漏判；
但本层**无法枚举别名映射**（Node 无相关 API；别名是否存在取决于卷是否启用 8.3 与创建顺序），
所以**不做 8.3 猜测**（猜错会给出假保证）。**该形态在本环境无法判定** —— 这是边界，不是缺陷掩盖。
能给出的保证是：同一凭证的**真名**出现时必须被名规则排除（有断言锁定）。

回归用例：`test/crossline-and-comment.test.mjs` 的 F17 组。自证：让 `isSensitivePath()` 不再切 ADS
⇒ 2 组失败；恢复后全绿。


敏感路径清单：`.env`、`.env.*`（任意深度）、`.envrc`、`*.pem`、`*.key`、`*.p12/.pfx/.jks/.keystore`、
`id_rsa*`、`id_dsa*`、`id_ecdsa*`、`id_ed25519*`、`credentials*`、`secrets/**`、`service-account*.json`、
`.npmrc`、`.pypirc`、`.netrc`、`*.kdbx`。**上述清单的匹配一律大小写不敏感（S5）**。

**排除理由串的语义边界（t51 / D06）**：`excluded[].reason` 是**实测取值**，各类别各自独立：

| 情形 | `reason` 形式 | `ruleId` |
|---|---|---|
| 密钥/凭证路径 | `sensitive_path_never_included` | `SAFETY-001-SENSITIVE-PATH` |
| 默认排除目录 | `default_excluded_dir:<段名>` | `SAFETY-002-DEFAULT-DIR` |
| **二进制扩展名**（`.png`/`.PNG`/`.exe`…）或魔数空字节 | `binary_file:extension` / `binary_file:magic-null-byte` | `SAFETY-003-BINARY` |
| **不支持的扩展名**（`.bak`、**`.lock`**…） | `unsupported_extension:<ext>` | `SAFETY-004-EXTENSION` |
| 硬链接密钥别名 | `hardlink_secret_alias:<via>` | `SAFETY-005-HARDLINK-ALIAS` |
| 规则层排除 | 规则条目的 `reason`（缺省 `excluded_by_rule`） | 该规则 `id` |

`.lock` **刻意不在** `BINARY_EXTENSIONS` 里：早期它被归入二进制扩展名，导致与 `.PNG` 的
理由串重叠（都是 `binary_file:extension`），掩盖了「`.lock` 其实是**不支持扩展名**」这一事实。
现在 `.lock` 走 `SAFETY-004-EXTENSION` 分支，理由串为 `unsupported_extension:.lock`
（**仍然排除**，安全判定未放宽）。回归用例：`test/security-bypass.test.mjs` 的 D06 用例。

**F11 复核（t56）：t51 的根因修复是否真的把两类理由串分开了 —— 是，已实测并加断言锁死。**

verifier 在 t55/report-v7 仍把 F11 列为残余项。本次**逐条实测**当前代码，四类输入的
`reason × ruleId` 对照如下（`classifyFile(path, rules, {})` 直接调用，与目录 API 同源）：

| 输入 | `decision` | `reason` | `ruleId` | 语义族 |
|---|---|---|---|---|
| `yarn.lock`（含 `Yarn.Lock`） | excluded | `unsupported_extension:.lock` | `SAFETY-004-EXTENSION` | 不支持扩展名（D06） |
| `weird/file.bak`（含 `.BAK`） | excluded | `unsupported_extension:.bak` | `SAFETY-004-EXTENSION` | 不支持扩展名（D06） |
| `assets/logo.PNG` | excluded | `binary_file:extension` | `SAFETY-003-BINARY` | 二进制扩展名（D04） |
| `assets/logo.png` | excluded | `binary_file:extension` | `SAFETY-003-BINARY` | 二进制扩展名（D04） |

结论：**两类理由串与 ruleId 均已分开**（`.lock`/`.bak` 走 `unsupported_extension:*` + `SAFETY-004-EXTENSION`；
`.PNG`/`.png` 走 `binary_file:extension` + `SAFETY-003-BINARY`）。verifier 自己的
`artifacts-v7/b1-matrix.json` 记录的也正是这两条不同取值 —— 说明 F11 描述的「共用理由串」
在当前代码上**已不复现**；为终止该条的反复，本次把它固化为断言（见下）。

结构层还有三条互斥保证（`test/reason-vocab.test.mjs` 断言）：

* `BINARY_EXTENSIONS ∩ SENSITIVE_EXTENSIONS = ∅`、`BINARY_EXTENSIONS ∩ SUPPORTED_EXTENSIONS = ∅`、
  `SENSITIVE_EXTENSIONS ∩ SUPPORTED_EXTENSIONS = ∅`（实测三者两两交集均为空）。
* `.lock` **不在** `BINARY_EXTENSIONS`，也**不在** `SUPPORTED_EXTENSIONS` ⇒ 既不会退回
  `binary_file:*`，也仍然被排除。
* 穷举本层全部 `reason` 取值后，**跨族共用理由串数 = 0**。

计数口径也据此分族（`payload.counts`，实测）：`excluded_binary` 只数 `binary_file*`，
`excluded_extension` 只数 `unsupported_extension*`（同一次输入下分别为 1 与 1，不互相串）。

> 一处**潜伏但当前不可达**的命名重叠（记录以备复核）：
> `isBinaryFile()` 对密钥类扩展名返回 `via='sensitive-extension'`，经 step 2 会拼成
> `binary_file:sensitive-extension`，与 `binary_file:extension` 同属 `binary_file:*` 前缀。
> 实测该 branch 在 `classifyFile` 里**不可达** —— `.pem`/`.key` 等在 step 0 就被
> `sensitive_path_never_included`（`SAFETY-001-SENSITIVE-PATH`）截住，所以它不会成为任何文件的
> 实际理由串。保留该分支是 fail-closed 的深度防御；本次**不改**（改它属理由串取值调整，
> 需另行评估下游解析影响），仅在此登记。

回归用例：`test/reason-vocab.test.mjs`（5 组）。自证：把 `filters.mjs` step 3 的理由串临时改回
共用的 `binary_file:extension` 后，该文件 **3 组失败 / 2 组仍绿**；恢复后全绿。
> 注：`reason` 属 §6.2.2 映射表中标注「契约无（适配层独有）」的字段，其**取值**不受冻结枚举约束；
> 但它是 `selection.excluded[].reason` 的取值来源，因此语义调整已在 t51 回报 captain。

---

## 5. 规则四层优先级

```
L0  --include / --exclude（本次调用追加的最高层，priority 0）
L1  --rule <path>                        priority 1
L2  <root>/.opencodereview/rule.json     priority 2   （项目级）
L3  ~/.opencodereview/rule.json          priority 3   （用户级）
L4  内置                                  priority 4   （无 include ⇒ 结构上不可能救回敏感路径）
```

**第一条匹配生效**：对单个文件按 L0→L4 遍历，同一层内按 `include`/`exclude` 数组的**出现顺序**遍历，
第一个命中的模式决定该文件命运并停止。`ruleMatch[]`（或 `--explain <path>`）会给出最终命中的
`ruleSource` / `priority` / `pattern` / `ruleId` / `decision` / `reason`，可逐文件复核。

规则文件（v1.0）：

```json
{
  "version": "1.0",
  "include": ["src/**/*.mjs", { "id": "t", "pattern": "**/*.test.mjs", "reason": "测试必须参与评审" }],
  "exclude": [{ "id": "docs", "pattern": "**/*.md", "reason": "文档由 docs-engineer 负责" }],
  "includeExtensions": [".mjs", ".json", ".md"],
  "maxTokensPerGroup": 4096,
  "grouping": { "maxFilesPerGroup": 10, "buckets": [{ "id": "injection-chain", "patterns": ["src/chain/user-*.mjs"] }] }
}
```

`grouping.buckets[].patterns` 命中的文件被**强制捆进同一组**（跨文件调用链保上下文）；
未命中者按「公共目录前缀 + 首段目录」自动分段，再按 ≤10 切块。

### 5.1 规则文件格式与 `qgate` **不通用**（不对称失效，已修复为显式可见）

两侧的规则文件格式不同，**且失效方向不对称**：

| | 本适配层 | 引擎 `qgate` |
|---|---|---|
| 格式 | `{ include, exclude, includeExtensions, grouping }` | `{ schemaVersion, rules: [{ id, match, severity, category }] }` |
| 遇到对方的格式 | （修复前）**静默忽略** —— 规则一条都没生效，但输出看起来完全正常 | **exit 2 / `CONFIG_INVALID`**，明确报 `rule file has no "rules" array` |

「看起来配了、实际没生效」正是确定性工程要消灭的状态（比报错更危险），因此本层**不再静默**：
一旦发现规则文件不是本层可识别的格式，就显式上报

```json
{
  "degraded": true,
  "degraded_reason": "RULE_FORMAT_UNSUPPORTED",   // 与 provider 降级可并存，用 "+" 连接
  "degraded_reasons": ["OCR_CLI_NOT_FOUND", "RULE_FORMAT_UNSUPPORTED"],
  "rules": {
    "format_supported": false,
    "unsupported_layers": [
      { "source": "cli:--rule", "file": "…/rule.engine-format.json",
        "reason": "RULE_FORMAT_UNSUPPORTED",
        "detail": "engine rule format detected: { rules: [{ id, match, severity, category }] } is not the adapter format (…)",
        "kind": "engine" }
    ],
    "layer_trace": [{ "source": "cli:--rule", "format_supported": false, "format_reason": "RULE_FORMAT_UNSUPPORTED" }]
  }
}
```

`--md` 输出同样给出显式告警段落（`⚠️ RULE_FORMAT_UNSUPPORTED：存在无法识别的规则文件，其中的规则未生效。`），
并说明两侧格式差异。判定逻辑见 `src/rules.mjs` 的 `inspectRuleShape()`；
检测覆盖 `--rule`、项目级、用户级三层（不只是 `--rule`）。
复现用夹具：`demo/rule.engine-format.json`（引擎格式，标注为 fixture）；
回归测试：`test/rule-format.test.mjs`（同时断言**适配层自己的格式不被误报**）。

**取舍说明**：这里选择「显式降级 + 告警字段」而不是「非零退出码」，因为 `ocr-preview` 的定位是
**预览**命令——预览仍应给出可用的选择/分组结果，但必须让用户看见「规则没生效」。
`--md` 与 `--json` 两种消费者都能拿到该信号。**未**选择「保持静默、只补文档」，
因为那正是这类缺陷最危险的形态（用户永远不会知道规则没生效）。

---

## 6. 运行测试

```bash
# 标准方式（Node ≥ 18 的测试运行器）
node --test adapters/opencodereview/test/

# 等价的进程内方式：某些受限沙箱禁止 node --test 为每个文件派生子进程（EPERM）时使用
node adapters/opencodereview/tools/run-tests.mjs
```

当前基线：**15 个测试文件 / 144 个用例，全部通过**（三种 cwd 下均全绿，见 §6.1）。

| 测试文件 | 覆盖 |
|---|---|
| `test/selection.test.mjs` | CLI 契约与退出码、密钥优先于 include、二进制/默认目录/扩展名排除、四层优先级逐层、`--explain`、分组上限与 token 降级、调用链同组、ocr 缺失降级、零密钥、确定性重复运行、`--root` 同源、夹具真实性、不触碰 `packages/qgate` |
| `test/grouping-rules.test.mjs` | 分组常量与硬上限、空输入、无重复无遗漏、token 降级、失败回退、显式分桶、公共前缀、规则层解析与 `RuleError`、`classifyFile` 判定顺序 |
| `test/ocr-runner.test.mjs` | 探测/降级原因枚举、假 ocr 非零退出、子进程环境白名单、源码零密钥扫描、ocr JSON 夹具形状、reflection 复核规则 |
| `test/ci-workflow.test.mjs` | 恰好 5 个 job 与阶段依赖链、§8.2 命令映射、verify 三段式与顺序、**引用的每个文件都存在于仓库**（无运行时生成再引用）、40 位 SHA 固定、最小权限、无仓库密钥引用、模板输入参数、**内嵌 node 脚本真实执行**（人类门禁 + 安全断言） |
| `test/fixtures.test.mjs` | `test/fixtures/` 的真实运行产物回归（结构、计数、字节级一致性）+ **scrubber 覆盖面**（三类路径都抹平、不误替非仓库绝对路径） |
| `test/determinism.test.mjs` | **跨 cwd 确定性**（三种 cwd 下锚点与整体输出一致）、输出无绝对根路径、显式 `--root` 未回归、固定 cwd 重复运行字节级一致、安全不变量未受影响 |
| `test/rule-format.test.mjs` | **规则格式不对称**：引擎格式被检出并上报（`degraded:true` + `RULE_FORMAT_UNSUPPORTED`）、适配层格式不误报、告警在 `--json`/`--md` 可见、项目级层同样上报 |
| `test/security-bypass.test.mjs` | **三类安全绕过回归**：B1 大小写（路径/目录/扩展名，含 safety 假保证对照）、H2 硬链接别名（内容形态 + 不误报占位符 + 断言独立复检）、H3 SAFE_001 8 种写法与 SAFE_003 4 种网络写法（含静态 import 别名）、self-scan 防误报 |
| `test/hardlink-diff.test.mjs` | **F1 双路径覆盖**：三类别名 × `--diff`（并列 / 仓库内 / 嵌套子目录三种布局）与 `--root` 全部排除；排除依据必须是**同源 inode 身份链**而非内容启发式；低命中率 diff 不得丢弃根；无害硬链接不得误排除 |
| `test/network-import.test.mjs` | **网络导入面（t54 / R3-L3）**：导入网络模块本身即违规（静态/命名空间/动态/`require` 四形态，均不依赖调用点）；调用形态判定未被替换；非网络模块（`node:fs`/`node:path`/`os`）不报；注释行与否定行不报；纯模块名字面量不报；**与引擎 `policySafe003` 同判**（文本级同形边界）；目录级端到端 |
| `test/network-vocab.test.mjs` | **网络词表对齐（t56 / F12）**：适配层 `NET_MODULES` ⊇ 引擎 `NET_MODULE_NAMES`（从引擎源码文本解析，防漂移）；自检本身有效（构造缺项必须报警）＋解析失败必须响亮失败；22 格模块词表对照（引擎词表内 14 格都报、其余 8 格都不报）；词表扩张后非网络模块/注释/字面量仍未报；`dns`/`undici` 四形态 |
| `test/reason-vocab.test.mjs` | **排除理由串分族（t56 / F11）**：`.lock`/`.bak` → `unsupported_extension:*`＋`SAFETY-004-EXTENSION`，`.PNG`/`.png` → `binary_file:extension`＋`SAFETY-003-BINARY`；跨族共用理由串数 = 0；三个扩展名词表两两不相交；大小写变体分族一致；`excluded_binary`/`excluded_extension` 计数口径不串族 |
| `test/network-client.test.mjs` | **命名网络客户端调用面（t58 / F14）**：客户端名单/成员表覆盖引擎（从引擎源码文本解析，防漂移）＋自检有效性；`axios.get`/`client.get`/`ky.get`… 15 格必须报；**良性对照 22 条零误报**；客户端名 + 非 HTTP 成员不报；**锁死**「本层更严」的 `XMLHttpRequest`/`WebSocket` 不得被改松；名字碰撞两侧都报的现状；既有判定未被替换；目录级端到端 |
| `test/crossline-and-comment.test.mjs` | **跨行链式 + 块注释状态机 + 路径变体（t64 / F15·F16·F17）**：prettier 折行的跨行链式调用必须报且不重复计数（良性对照折行亦然）；未闭合 `/*` 后的星号行按代码处理、真正闭合的 JSDoc 仍静默；孤立星号片段按代码处理并与引擎逐例同判；NTFS ADS 变体由**名规则**命中（`reason=secret_path` 而非 `unsupported_extension` 兜底）；空白变体仍排除但 reason 为兜底（如实断言）；8.3 短名实测不是别名、不猜测 |
| `test/unmaterialized.test.mjs` | **未物化路径计数口径（t48）**：未物化路径不进入 `groups[].files`、空组被丢弃、与 `--root` 计数对齐；事实仍可查（`unmaterialized[]` + `materialized:false`）；契约面 `selection.included` 不变；token 不膨胀 |

### 6.1 跨 cwd / 跨机器的确定性（GAP-5 / GAP-6 修复）

同一输入必须在**任何调用目录、任何机器**上产出同一结果（REQ-QUALITY-GATE-010「同输入同输出」）。
早期这里有两个成因不同的缺口，现已同批修复：

| 缺口 | 性质 | 修复位置与做法 |
|---|---|---|
| **GAP-5** | 源码缺陷 | `src/ocr-pipeline.mjs`：未显式给 `--root` 时**不再用 `process.cwd()`** 作规则锚点，改用**选择阶段推断出的同一个根**（`selectFiles` 内部的 `inferDiffRoots` 从 diff 推断项目根，并作为 `sizeRoot` 返回）。「选择」与「规则解析」共用同一个根，避免两者用不同根造成新的不一致；显式 `--root` 仍优先。 |
| **GAP-6** | 测试资产缺陷 | 夹具把仓库绝对路径固化成期望值，且 scrubber 只覆盖含 `adapters/opencodereview` 段的路径。现改用**占位符 + 基于根前缀的替换**（`test/portable.mjs`），并用 `tools/record-fixtures.mjs` 重录夹具。 |

**占位符约定**（夹具里不再出现任何仓库/家目录绝对路径）：

| 占位符 | 含义 | 典型出现位置 |
|---|---|---|
| `<ADAPTER_ROOT>` | 适配层根 `…/adapters/opencodereview` | `rules.layer_trace[].file`（`--rule` 层）、`source.path`、`demo` 下的项目级规则路径 |
| `<REPO_ROOT>` | 仓库根（适配层根的上两级） | 仓库根 `.opencodereview/rule.json` 的项目级规则路径 |
| `<HOME>` | 用户家目录 | 用户级规则 `~/.opencodereview/rule.json` 路径 |

**scrubber 覆盖的三类路径**（`test/portable.mjs`，**基于根前缀而非目录名判断**）：

1. **适配层自身路径** —— 以 `ADAPTER_ROOT` 开头；
2. **项目级规则路径** `…/.opencodereview/rule.json`（含仓库根与 `demo/` 两种锚点）—— 这类路径**不含** `adapters/opencodereview` 段，是早期正则的漏网者；
3. **demo 输入文件路径**（`source.path` 指向的 diff 文件）与**用户级规则路径**（以 `HOME` 开头）。

替换按**最长/最具体前缀优先**（`<ADAPTER_ROOT>` → `<REPO_ROOT>` → `<HOME>`），否则 `<REPO_ROOT>` 会先把适配层前缀吃掉。
**非仓库/非家目录的绝对路径不被占位符化**（只统一分隔符为 `/`），避免把无关路径也抹平而掩盖真实差异；前缀相似但不相等的路径（如 `…/ai-quality-gate-extra`）也不会误匹配。这些都由测试锁定。

三个入口（断言侧与记录侧共用同一套规则，避免两边各写一份）：

| 函数 | 用途 |
|---|---|
| `portableize(value)` | 对象/数组深度遍历（用于 JSON 夹具与运行时 payload） |
| `portableizeString(value)` | 整串恰是一个路径（前缀匹配） |
| `portableizeText(text)` | 路径嵌在句子/表格里（Markdown `--md` 输出用） |

**重录夹具**：`node adapters/opencodereview/tools/record-fixtures.mjs`（在仓库根执行；进程内调用与 CLI 相同的代码路径并按同一键序序列化，因此产物与 `bin/ocr-preview.mjs --json` 的 stdout 逐字节一致；脚本末尾会自检，若夹具里仍残留绝对根路径则以 `FIXTURE_NOT_PORTABLE` 失败）。

**实测（三种 cwd）**：

| cwd | 适配层套件 |
|---|---|
| `E:\Desktop\ai-quality-gate`（规范路径） | 100 / 100 通过 |
| `E:\ai-quality-gate`（junction 别名） | 100 / 100 通过 |
| `E:\Desktop`（非仓库根） | 100 / 100 通过 |

并在三种 cwd 下断言 `rules.layer_trace[].file` / `loaded_layers[].file` / `source.path` **完全一致**（`test/determinism.test.mjs`）。

### 6.2 未物化路径与「评审覆盖面」计数口径（t48 / R3-L2）

**问题**：`--diff` 声明的路径在盘上可能不存在（典型：diff 里保留了已删除文件的条目，如 `gone/*.js`）。
早期这些**未物化路径**被当作普通入选文件，于是：

| | 含 6 个未物化路径的 diff | `--root` 对照 |
|---|---|---|
| `selection.included` | 9 | 3 |
| `groups[].files` 合计（覆盖面派生值的来源） | 9 | 3 |
| `counts.groups` | 2（含一个只有未物化路径的 `gone` 空组） | 1 |

⇒ 任何以「selected 文件数 / group 文件数」派生评审覆盖面的计数会**偏高 3 倍**。
**注意 token 没有膨胀**（未物化项 `size`/`tokens` 恒为 0，实测两模式 `tokenSum` 相同）
⇒ 本修复**不改 token 逻辑**，只修计数口径。

**采用的口径（三者同时成立）**：

1. **不污染计数**：未物化路径**不进入** `groups[].files`；物化后为空的组被**丢弃**
   （`counts.groups` 因此与 `--root` 对齐）。`counts.selected_materialized` 是
   「评审覆盖面」应当使用的值；`counts.unmaterialized` 与 `counts.groups_dropped_unmaterialized` 单列。
2. **不隐藏事实**：未物化路径以 **`unmaterialized`（顶层键，`string[]`）** 显式列出，
   且 `selected[].materialized === false` 逐项标注；每个组还带 `groups[].excluded_unmaterialized`
   表示「该组里被剔除的未物化路径数」。审计时可直接回答「diff 声明了什么、盘上有什么」。
   > **字段路径以实测为准（t51 更正）**：`--json` 输出的**顶层**键就叫 `unmaterialized`
      （`string[]`），另有顶层 `selectedPathsMaterialized`（`string[]`）；
      **没有 `payload` 容器**。`payload.xxx` 只是**模块内**用法
      （`const { payload } = createPreview(...)` 的返回对象），**不要**当作 JSON 字段路径。
      实测（`node -e` 读 `test/fixtures/preview.default.json`）：`has payload: false`、
      `has unmaterialized: true`、`has selectedPathsMaterialized: true`。
3. **契约面不变**：`selection.included[]` 仍与 §6.2.2 映射的**纯字符串数组**逐字一致
   （包含全部声明路径，不因物化与否而增删），因此不改变冻结面的语义。
   新增顶层 `unmaterialized` / `selectedPathsMaterialized`、`counts.selected_materialized` /
   `counts.unmaterialized` / `counts.groups_dropped_unmaterialized`、
   `selected[].materialized` / `groups[].excluded_unmaterialized` 都是**附加字段**
   （逐项已由 t50 写入契约 §6.2.2.5；本层新增输出键须同批更新 §6.2.2）。

**为什么选这个口径而不是「直接剔除未物化路径」**：剔除会让 `selection.included` 与冻结的
§6.2.2 映射面产生语义偏差（契约面字段含义会从「diff 声明并被选中的路径」变成
「盘上真实存在且被选中的路径」），而后者是**语义变更**、需要走契约修订；
本条是 low 级收尾，不应牵动冻结面。用「组内剔除 + 单列事实 + 契约面保持」可以在**不改契约语义**
的前提下同时满足「计数不污染」与「事实可查」。

回归测试：`test/unmaterialized.test.mjs`（6 用例：计数不污染、与 `--root` 对齐、事实可查、
空组丢弃、全物化时不回归、token 不膨胀）。

---

## 7. 目录结构

```
adapters/opencodereview/
├── bin/ocr-preview.mjs        # CLI 入口（确定性选择预览；退出码 0/2/3）
├── src/
│   ├── util.mjs               # 路径归一化、glob→RegExp、确定排序、token 估算、原子写
│   ├── filters.mjs            # S1–S4 安全不变量与判定顺序（classifyFile）
│   ├── selection.mjs          # 纯确定性文件选择（diff 与 root 同源）
│   ├── grouping.mjs           # FileGroup：MAX_FILES_PER_GROUP=10、token 降级、失败回退
│   ├── rules.mjs              # 四层规则优先级、第一条匹配、命中来源解释
│   ├── ocr-runner.mjs         # ocr 探测/调用/降级 + 零密钥子进程环境
│   ├── reflection.mjs         # 建议复核（离线规则化复刻，剔噪提精度）
│   └── ocr-pipeline.mjs       # 编排：rules → selection → grouping → JSON/Markdown
├── ci/github-actions.yml      # 可复用 CI 模板（workflow_call，含输入参数说明）
├── demo/                      # 演示夹具（见 §8）
├── test/                      # 56 个用例 + fixtures/（真实运行产物）
└── tools/
    ├── gen-demo-fixtures.mjs  # 可复现生成 demo 夹具
    └── run-tests.mjs          # 进程内聚合测试运行器
```

---

## 8. demo 夹具说明（**全部为 fixture，非真实调用结果**）

下表路径以 `adapters/opencodereview/` 为锚（即 `demo/` 目录内部）；这些也正是 `diff.json`
中记录的相对路径（以 `demo/` 目录为锚，与 `--root adapters/opencodereview/demo` 同根）。

| 路径 | 用途 |
|---|---|
| `demo/diff.json` | 变更集夹具：`fixture:true`，23 个候选路径（含 `binary:true` 标记） |
| `demo/rule.json` | 演示规则：显式 `include` 源码与测试、显式 `exclude` 文档与 `.bak`、`grouping.buckets` 捆注入链 |
| `demo/src/chain/user-handler.mjs` → `user-service.mjs` → `user-repository.mjs` → `user-mapper.mjs` | 跨文件注入调用链：`mapper` 读取 `row.created_at`，而 `repository` 的字段契约一旦改名即静默产生 `Invalid Date` —— 用于验证「四文件必须落在同一组才能发现跨文件缺陷」 |
| `demo/src/chain/chain.test.mjs` | 覆盖该调用链的测试 |
| `demo/src/reader/reader-part-1..8.mjs` | 同目录多文件：演示「按目录分段 + ≤10 切块」与 token 预算降级 |
| `demo/.env.production`、`demo/config/tls/server.pem`、`demo/src/chain/id_rsa`、`demo/config/service-account.json`、`demo/.opencodereview/secrets/db-password.txt` | 真实存在的密钥/凭证类文件（内容均为 `DEMO-FIXTURE-PLACEHOLDER`）——用于证明**即使真实存在也永远不进 `selected`** |
| `demo/node_modules/left-pad/index.js`、`demo/dist/bundle.js` | 默认排除目录 |
| `demo/assets/logo.png`、`demo/src/chain/user-handler.mjs.bak` | 二进制与不支持扩展名 |
| `demo/ocr-review.sample.json` | `ocr review --format json` 的**输出形状夹具**：`_fixture:true` / `_note` 显式声明非真实调用结果；真实 `ocr` 存在时由 `ocr-runner.mjs` 用其 stdout 替换 |

重新生成夹具：`node adapters/opencodereview/tools/gen-demo-fixtures.mjs`
（幂等：只重建 `diff.json` 与文件内容，不会覆盖 `rule.json` / `ocr-review.sample.json`；
`test/selection.test.mjs` 会逐条断言 `diff.json` 中每个路径都真实存在且可被 `--root` 枚举）。

---

## 9. 与 OCR 上游的取舍（诚实说明）

| OCR 手法 | 本适配层复刻位置 | 取舍 |
|---|---|---|
| `selection.go` 纯确定性文件选择（无副作用） | `src/selection.mjs` | 无 LLM 参与，`--preview` 与真实执行同源 ⇒ 预览即执行 |
| 二进制/密钥/默认目录/扩展名过滤 | `src/filters.mjs` | 安全层判定顺序先于用户规则，无法被 `include` 覆盖 |
| `FileGroup` + `maxFilesPerGroup=10` + token 预算降级 + 分组失败回退 per-file | `src/grouping.mjs` | 牺牲单组覆盖率换上下文质量；降级形态在输出中显式记账 |
| `.opencodereview/rule.json` 优先级 + 第一条匹配 | `src/rules.mjs` | 规则竞争不可能产生两种结论 |
| reflection / suggestion validation | `src/reflection.mjs` | 纯离线规则化复刻：无 evidence / 无定位 / 指向密钥 / 重复的建议一律丢弃 |
| 失败降级 | `src/ocr-runner.mjs` + 全链路 `degraded` 标记 | 任一步失败不产生「半个结论」 |

**已知 Recall 缺口**（与上游公开取舍一致：Precision/F1 更高、Recall 更低；Token 约为通用
Claude Code Agent 方案的 1/9）：

1. 文本启发式 + 魔数只覆盖常见二进制；加密/压缩容器内部的文本会被整文件排除。
2. 扩展名白名单会排除未列入的长尾语言文件（可用 `rules.includeExtensions` 按仓库扩展）。
3. `--diff` 只消费文件列表，不解析 hunk，因此行级定位精度依赖下游工具的重新定位。
4. 分组降级为单文件桶后，跨文件缺陷（如 §8 的字段契约注入）可能被漏掉 —— 这正是
   `grouping.notes` 与 `downgraded` 必须被上游门禁读取并作为证据留痕的原因。
