# verification/review-round2.md — t29 第二轮评审（复核 t26/t27/t28 对 t6 结论的闭合情况）

| 项 | 值 |
|---|---|
| 任务 | t29 [review]（attempt_id `a4da52c0-a421-493a-b646-d8e74ae4fd9a`） |
| 与上一轮的关系 | **本轮结论取代 `verification/review.md`（t6 第一轮）的状态判定**；第一轮文件保留为历史记录（其 blocker/high 编号沿用，便于对照） |
| 评审对象 | `E:\Desktop\ai-quality-gate`（junction 两侧等价） |
| 结论 | **needs_revision**（1 条仍成立的 blocker（适配层大小写绕过，captain 已列为必须修）+ 5 条 high + 7 条 medium-low）。第一轮 4 blocker + 4 high 共 8 项中：**7 项已闭合、1 项部分闭合**（H8 trace 自证）；另 3 项追加复核中 **H7、M4 已闭合，M2/M3（大小写 + 别名路径）未闭合** |
| 评审后修订增量 | 03:14:14 owner 改写 `test/evidence-resolution.test.mjs` ⇒ 03:15:5x 复跑 **`npm test` 95/95、`npm run test:all` 95/95、`npm run test:contract` 23/23，三者同绿（exit 0）**；原 blocker-1（套件红）因此**在评审窗口内闭合**，详见 §0.1 |
| 是否修改实现 | 否。只读 `packages/**`、`adapters/**`、`schemas/**`、`docs/**`；本文件是唯一写入物 |
| 环境 | Node v24.19.0 / Windows / 离线、无 API Key |

## 0. 评审时刻的树指纹（必须先读）

**开工 03:09:17，收敛采样 03:14–03:16。评审期间有并发写入**：`packages/qgate/src/checks/{evidence(03:12:16)、file_not_exists、json_assert、regex、file_exists、trace_matrix(03:13:12)}` 与 `packages/qgate/test/evidence-resolution.test.mjs(03:13:15)` 在窗口内被改（`Get-ChildItem | Where LastWriteTime -gt (Get-Date).AddMinutes(-6)` 实测），core-engineer 仍在跑 t31。**因此本报告的"未闭合"判定适用于下表指纹所指的修订**；若 owner 在此之后再次改动，captain 必须要求在同一新修订上复跑复验项。

```
DBD98FCA24BD1FAE  packages/qgate/src/core.mjs              (03:02:57)
E12C6E0D4B55A7FA  packages/qgate/src/policy.mjs            (03:05:02)
0BEF75EE5ED7F72F  packages/qgate/src/ledger.mjs            (03:00:56)
0CC4636F578ACE2F  packages/qgate/src/trace.mjs             (03:06:46)
D47B79A3C54FE11A  packages/qgate/src/cli.mjs               (03:02:09)
8B7BAAB07C53277B  packages/qgate/src/evidence.mjs          (03:12:16)
08DFCAFF8933ABFE  packages/qgate/test/evidence-resolution.test.mjs (03:13:15)
3C12AA52C002333E  demo/qgate.config.json                    (03:01:57)
7627A38680BB9F75  qgate.config.json                         (02:34:31，自第一轮起未变)
39074F7033209BBC  package.json                              (02:50:56)
107113BB0588A32D  schemas/trace-matrix.schema.json          (02:08:52)
```

t26/t27/t28 在任务列表上均为 `completed`，故未按"仍在变动 ⇒ 标 blocked"整单搁置；但**采样期间确有源码在写**，凡受此影响的判定都在下文逐条标注。

### 0.1 评审窗口后的修订增量（03:15:40 复查）

| 项 | 评审修订（pin） | 03:15:40 复查 | 处理 |
|---|---|---|---|
| `test/evidence-resolution.test.mjs` | `08DFCAFF8933ABFE`（03:13:15），`T-QG-007 dangling form 2` 失败 3/3 | owner 于 **03:14:14** 改写为 `runSingleCheckGate` 自包含用例（新哈希 `D07BE40E81114E7B`）：`npm test` **95/95**、`test:all` **95/95**、`test:contract` **23/23**，三者 exit 0 | blocker-1 改记 **closed during review（在 pin 之后）**；根因记录保留（§2） |
| 引擎源码（core/policy/ledger/trace/cli/evidence） | 见 §0 指纹 | **哈希全部未变** | 所有引擎侧判定（item 1/2/5/6/7/8/9/10、H5）在 pin 上依然有效 |
| `demo/qgate.config.json`、根 `qgate.config.json`、`package.json` | 同上 | **未变** | "demo 未被手工调绿""脚本未缩小范围"两条结论不变 |

---

## 1. 逐条闭合状态（第一轮 4 blocker + 4 high + 3 追加项）

| # | 第一轮发现 | 判定 | 关键实测 |
|---|---|---|---|
| 1 | **B1** 必需检查失败被静默放过 | ✅ **CLOSED** | 自建配置实测：`required:true` + 不写 severity（默认 medium）+ 失败 ⇒ **exit 1**、`overall_passed=false`、`gate.passed=false`、`blockers=["c1:medium"]`、`checks[0].passed=false`；`required:false` ⇒ exit 0；`onFail:"warn"` ⇒ exit 0；`severity:"low"` ⇒ **仍 exit 1**（severity 只作呈现）。与 §5.2.1（新 L574）/§9.2 裁决一致 |
| 2 | **B3** SAFE_001 检不出 env 取密钥 | ✅ **CLOSED（含 1 条 high 残留）** | 自建探针：必须检出的 12/12 全部 DETECT（含 `process.env.ANTHROPIC_API_KEY`、`['...']`、`["..."]`、`OPENAI_API_KEY`、`import.meta.env`、`Deno.env`、`os.environ`、`getenv()`、`vault.X`）；不得检出的 6/6 全部干净（注释/散文/`const apiKey=` 定义/对象字面量键/`process.env.PATH`）；`scanRoots=null` 全仓 **SAFE_001 61→0、SAFE_003 55→0**，扫描面 **264→96 文件**（非"空扫通过"） |
| 3 | **B4** 点名验证资产缺失 | ✅ **CLOSED** | `docs/01-architecture.md:1117-1144` 新增 **§8.3.1 GAP-9 逐条判定表**（"已实现，路径写错"×11 / "未实现（延后）"×1+1）；REQ-009/REQ-015 的 `end-to-end.json`/`ci-parity.json` 在 `docs/00-requirements.md:119/121/168` 与 `docs/requirements-index.json:169/262` 均标 **延后（由 t24 产出）**，文档未声称其已存在；`requirements-index.json` 只对 REQ-007/REQ-015 声明 `covered:false` |
| 4 | **B5/H11** 引擎套件红 / `npm test` 排除契约套件 | ✅ **CLOSED（评审窗口内，在 pin 之后）** | 覆盖面早已修好（`test` 与 `test:all` **同一条引号 glob 命令**，`package.json:14-15`）；pin 时刻仍是红的（连跑 3 次 `90 tests / 88-89 pass / 1-2 fail`，唯一稳定失败项 `test/evidence-resolution.test.mjs:148`，根因见 §2 blocker-1）。owner 于 **03:14:14** 改写该用例 ⇒ 03:15:5x 实测 **`test` 95/95、`test:all` 95/95、`test:contract` 23/23，三者同绿** |
| 5 | **H6** 账本 sha256 从不复算 | ✅ **CLOSED** | 三种篡改各 exit 3 + `EVIDENCE_UNRESOLVED`：① 改账本条目 `passed` ② 改 `ledger-index.ledgers[0].sha256` ③ 篡改 `runIds`（第一轮三种都是 exit 0）。残留：伪造整条链（自算 sha256）可通过 → §2 medium-1 |
| 6 | **H8** trace 覆盖率自证 | ⚠️ **PARTIAL（high）** | 干净证据目录 + 删掉承载 testId 的检查 ⇒ **exit 1 / TRACE_GAP: REQ-DEMO-006 covered=false (T-QG-003 absent from ledger-index)** ✓；但**用仓库自带的（append-only）证据历史时同一改动 exit 0** —— 见 §2 high-1 |
| 7 | **H10** trace 输出违反冻结 schema | ✅ **CLOSED** | `qgate trace --json`、`demo/.../trace-matrix.json`、`verification/trace-matrix.json` 三份对 `schemas/trace-matrix.schema.json` 求值 **valid=true errors=0**（第一轮 7 errors） |
| 8 | **H2/H3** `--summary` JSON / preview 键数 | ✅ **CLOSED** | `check --summary` 实测输出人类可读表格（`stage | gate | required | passed | blockers | checks`），§6.1 L756 与 §6.2.0 L767-768 已写明"不是 JSON"；`preview --json` 顶层**恰 8 键**（`ok,degraded,root,selection,groups,ruleMatch,rules,invariants`），§6.2.1 L786 已改为"恰好为 8 项"，L778 同步 |
| 9 | **H7** provider fixture 未命中静默 exit 0 | ✅ **CLOSED（可见失败）** | scripted provider + 无命中 fixture ⇒ **exit 3**、`error.code=PROVIDER_FAILED`、`message="provider fixture has no recording for the qgate provider probe (fx.json)"`、`jsonPointer=/provider/fixture`（第一轮 exit 0）。残留：findings 仍不参与门禁判定（仅启动探针）→ §2 medium-2 |
| 10 | **M4** `QGATE_REPO_ROOT` 空转绕过 | ✅ **CLOSED** | 源码 grep `QGATE_REPO_ROOT` = 0 命中；设该变量后 demo 仍扫描 **96 文件**、`filesScanned:96`、exit 0（第一轮为 0 文件 + exit 0）；另有"空扫集合即违规"守卫：`scanRoots` 指向空目录 ⇒ exit 1、`filesScanned:0, violations:1` |
| 11 | **M2/M3** 大小写绕过 / 硬链接别名绕过 | ❌ **NOT CLOSED** | 复测与第一轮完全相同：diff 模式下 **`Credentials.json`、`Secrets/db.txt`、`docs.txt`（硬链接→`.env`）仍全部 INCLUDED**，`safety.no_sensitive_selected=true`；`--root` 扫描同样 INCLUDED。captain 已把大小写与硬链接列为**必须修**项，未交付 → §2 blocker-2 |
| 追加 | **H5** 引擎接受嵌套未知键（schema 拒绝） | ❌ **仍未闭合（medium）** | demo 副本中给 `provider/policy/selection/grouping` 各注入一个未知键 ⇒ 引擎 **exit 0（接受并执行）**，同一配置对 `schemas/config.schema.json` 求值 **valid=false（4 errors）** |
| 追加 | **H1** `--config` 相对路径语义 | ⚠️ **基本闭合（low 残留）** | 文档新增 L130/L138 明确"按 cwd 解析，一旦配置被找到则 RunResult 与 cwd 无关"（实测 cwd=`packages/qgate` ⇒ exit 2）；但 §6.1 字段表 **L753 仍写"相对项目根或绝对路径"**，与自身注记矛盾 |
| 追加 | **H4** §6.6 `ok` 矩阵 | ⚠️ **未复测（low，保留）** | `check --json` 顶层 8 键（§5.2）无 `ok`；`docs/01-architecture.md:980-989` 的 `ok` 矩阵仍以 `ok` 表述 `check`/`trace`。本轮命令行键集探针失败（见 §5 局限），按第一轮证据保留为 low |

**两个"假绿/造假"重点问题的直接回答：**

- **demo 是否被手工调绿？——没有。** `demo/qgate.config.json` 的 19 个 check 与第一轮快照**逐项一致**（id/type/severity/required 全同，`onFail:"warn"` 计数 = 0）；唯一的配置改动是 `policy.scanRoots` 由 4 个显式子树变为 `["."]`，即扫描面**变宽**（实测覆盖 32 个 `packages/qgate/src` + 33 个 `adapters` + 5 个 `demo/mini-service` 文件）；噪声是靠"散文/夹具不入默认扫描面 + 空扫即违规"这类**通用**规则消掉的，不是靠把 demo 排除在外。根 `qgate.config.json` 的 mtime 自第一轮起未变（`7627A38680BB9F75`），其中 `interface-frozen/no-loose-ends` 的 `required:false + onFail:"warn"` **早于本轮修复**（文件未改），且在 `required:false` 下不影响门禁结论；更重要的是根配置**当前是红的**（t28 的 rule 0 指名 REQ-007/REQ-015），这与"调绿"相反。
- **`npm test` 是否靠缩小范围变绿？——不是（已修）。** `package.json:14-15` 的 `test` 与 `test:all` 是**完全相同的命令**（`node --test --experimental-test-isolation=none "packages/qgate/test/*.test.mjs"`），覆盖 5 个测试文件；`test:contract` 是其中的 `schema-contract.test.mjs` 子集。pin 时刻三个入口**并非同绿**（罪魁是测试自身的接线 bug，见 §2 blocker-1），owner 在 03:14:14 修好接线后，03:15:5x 实测三者**同绿**（95/95、95/95、23/23）。

---

## 2. 发现清单（按级别）

### blocker

**blocker-1（评审窗口内闭合，保留根因记录）— 引擎套件在 pin 修订上是红的（`test` / `test:all` exit 1）**
- 状态：**closed during review**。pin（03:13:15）时红，3 次连续采样 `90 tests / 88–89 pass / 1–2 fail`；owner 于 03:14:14 改写该用例后，03:15:5x 实测 `npm test` 95/95、`test:all` 95/95、`test:contract` 23/23（三者 exit 0）。**根因仍值得记账**，因为它是"测试自身接线错误会让引擎看起来红"的实例，且下一次同类改动会重现。
- 复现（3 次一致）：`node --test --experimental-test-isolation=none "packages/qgate/test/*.test.mjs"` ⇒ `ℹ tests 90 / pass 88–89 / fail 1–2`，**exit 1**；`npm run test:contract` ⇒ `23/23`，exit 0。
- 稳定失败项：`packages/qgate/test/evidence-resolution.test.mjs:148`（`T-QG-007 dangling form 2`），3/3 次失败；断言差异为
  `auditEvidence(demo.root, runResult).failures` 实际含 1 条 `{checkId:'no-network-surface', ref:{path:'../../.github/workflows/quality-gate.yml', kind:'file'}}`。
- **根因（已定位到行）**：`packages/qgate/test/helpers.mjs:115` 的 `copyDemoRepo()` 返回 `{ root: <临时副本>, config: path.join(REPO_ROOT,'demo','qgate.config.json') }` —— **root 用的是临时副本，config 却指向原仓库**。测试 `evidence-resolution.test.mjs:149-157` 用该 config 跑流水线、再用 `demo.root`（副本）审计。流水线实际跑在原仓库上，SAFE_003 的样例证据是**按项目根相对化**的 `../../.github/workflows/quality-gate.yml`（实测：`auditEvidence(loaded.root)` = **0 failures**，`auditEvidence(repoRoot)` = 15 failures），该相对路径在副本里指到副本之外 ⇒ 假 dangling。**生产代码在本项上是正确的**；缺陷在测试自身的接线。
- 要求修复：`copyDemoRepo()` 同时返回副本内的 config 路径（`path.join(target,'qgate.config.json')`），或让测试对 `loaded.root` 审计。**实际修复方式**（owner，03:14:14）：把该用例改为 `runSingleCheckGate` 自包含（临时 root + 副本内 config），不再混用原仓库 config 与副本 root；已复跑确认三者同绿。建议把这条教训写进测试约定：**任何"复制仓库再审计"的用例必须让 config 与 root 同源**。
- 附注（不单独计级）：采样早期有一次 `90 tests / 64 pass / 26 fail`，其时 `src/checks/*` 与 `test/evidence-resolution.test.mjs` 正在被写入（mtimes 03:12:16–03:13:15），故未把该样本计为稳定缺陷；但这也说明**该套件在文件被并发改动时结果剧烈漂移**，放行判定必须绑定修订指纹。

**blocker-2 — 适配层大小写绕过仍未修（captain 已列为"必须修"）**
- 证据：`adapters/opencodereview/src/filters.mjs:106-116`（`base === '.env'`、`startsWith('id_rsa')`、`segs.includes('secrets')`，`matchesAnyPattern` 走大小写敏感的 `globToRegExp`，`util.mjs:37-80`）。
- 复现（自建树 + `--diff`）：`node adapters/opencodereview/bin/ocr-preview.mjs --diff <diff.json> --root <tree> --json` ⇒ `INCLUDED: Credentials.json, Secrets/db.txt, docs.txt, src/app.mjs`，而 `credentials.json`、`secrets/db.txt` 在 excluded；`safety.no_sensitive_selected = true`。`--root` 扫描模式同样包含 `Credentials.json`、`Secrets/db.txt`。
- 可达性：CI 的 diff 通常由 Ubuntu（大小写敏感）生成、或文件在大小写敏感文件系统上创建为 `Credentials.json`，随后在 Windows/macOS（大小写不敏感）上运行 ⇒ **同一份凭证文件被选入评审上下文**，违反 §5.1 SAFE_002/REQ-012 的硬不变量。
- 要求修复：路径清单与 glob 匹配改为大小写不敏感（或对不区分大小写的文件系统做显式归一化），并补 `Credentials.json`/`Secrets/**` 的反向用例。

### high

**high-1 — trace 覆盖率仍可被"历史证据"掩盖（append-only 证据面上的自证）**
- 实验 A（干净证据目录 + 删掉承载 `T-QG-003` 的检查 `req-index-valid`，按 CI 三段式）：warm-up exit 1 → `trace --write` → 权威 check **exit 1**，blocker `TRACE_GAP: REQ-DEMO-006 covered=false (testIds T-QG-003 absent from ledger-index)` ⇒ 引擎**能**发现。
- 实验 B（**使用仓库自带的证据历史**做同一改动）：**exit 0 / overall_passed=true**。原因：`.qgate/evidence/ledger-index.json` 是 append-only 的跨运行并集（实测 6 次历史 run、14 个 testId），删掉检查后该 testId 仍留在索引里 ⇒ 覆盖率依据依旧成立。
- 影响：在真实 CI 中每个 job 都从含 `.qgate/evidence/**` 的提交开始，因此**"删掉某检查 / 换掉配置"这类改动不会让 verify job 变红**，门禁读到的是旧修订的证据。这属于"假绿"类缺陷（不是第一轮的"完全自证"，但仍是"当前配置无法自证当前结论"）。
- 要求修复（三选一，需 captain 裁决）：① `trace_matrix` 额外断言"每个 testId 的承载 check 在当前配置中仍存在"；② 把证据目录在 CI 中设为非提交物/每次运行重建（`selection.defaultExcludedPaths` + CI cleanup）；③ 在索引条目里记录 `configSha256` 并要求与当前配置一致（不一致即 TRACE_GAP）。
- 文件:行：`packages/qgate/src/ledger.mjs:57-86`（append-only 并集）、`packages/qgate/src/trace.mjs`（覆盖率依据取自 `ledgerIndex.testIds`）。

**high-2 — 适配层别名路径（硬链接/符号链接）绕过仍未修**
- 证据/复现同 blocker-2：把 `.env` 硬链接为 `docs.txt`（`stat.nlink=2`、内容逐字节相同）后，`ocr-preview` 输出 `INCLUDED docs.txt` 且 `safety.no_sensitive_selected=true` —— 安全断言给出**假保证**。本机创建符号链接被系统拒绝（`Administrator privilege required`），故以硬链接等价复现；Linux/CI 上的 git mode 120000 符号链接路径未实测（见 §5）。
- 要求修复：对已选文件做 realpath/inode 去重，并对链接目标二次判定是否落在敏感清单内。

**high-3 — SAFE_001 对"同一环境变量的不同大小写"无感**
- 探针实测（`policySafe001` 单文件调用）：`process.env.anthropic_api_key`、`process.env.Anthropic_Api_Key`、`process.env['openai_api_key']` 全部 **NOT-DETECTED**（`SENSITIVE_WORDS` 只列大写词，见 `packages/qgate/src/policy.mjs:60-61`）；B3 要求的三类写法已检出（12/12），但大小写变体在 Windows（环境变量名不区分大小写）下读的是同一个密钥 ⇒ 仍是可被"非对抗性"写法绕过的漏检。
- 要求修复：`SENSITIVE_WORDS` 匹配加 `i` 标志（并同步 `NOT_A_DEFINITION` 的语义），补大小写反向用例。

**high-4 — 引擎接受嵌套未知键而 schema 拒绝（契约一致性残留）**
- 复现：demo 副本 + `provider/policy/selection/grouping` 各注入一个未知键 ⇒ 引擎 **exit 0**；同配置 `schemas/config.schema.json` **valid=false（4 errors）**；`schemas/README.md:104-106` 明文承诺这些层级会拒绝未声明字段。

**high-5 — "套件红"这一状态本身会随并发写入漂移，放行判定缺冻结机制**
- 证据：同一命令在 8 分钟内给出 `84/84`（03:0x，owner 采样时刻）→ `90/64/26`（03:12–03:13 并发写入窗口）→ `90/88/2` → `90/89/1`；测试计数从 62 → 84 → 90 变化，均因他人在写测试文件。
- 这不是代码缺陷，但 captain 已把"同一修订复跑"写进 t24；本轮实测**再次证明**该要求必需。要求：t24/后续复验必须记录 `tree-fingerprint` 并在无写入窗口内采样（例如冻结期）。

### medium / low

- **medium-1 — 伪造账本链可通过校验（新绕过）**：见 §3。要求修复/记账：在 §5.3.2 明确"哈希链是抗意外篡改，不是抗伪造"，或引入外部锚点（CI 生成的清单 / 提交签名）。
- **medium-2 — provider findings 仍不参与门禁判定**：`packages/qgate/src/core.mjs:98-108` 只在启动时做一次 `provider.findings(PROBE_REQUEST)` 探针（未命中即 `PROVIDER_FAILED`/exit 3），`classifyFindings` 仍无门禁消费方；REQ-013 的"finding 分级"只在测试与夹具层面成立。
- **low-1 — §7 布局树仍列 `bin/ocr-adapter.mjs`**：`docs/01-architecture.md:1033` 与同文件 §8.3.1 L1124 的判定（真实入口 `bin/ocr-preview.mjs`）自相矛盾。
- **low-2 — `--config` 字段表行未同步**：`docs/01-architecture.md:753` 仍写"相对项目根或绝对路径"，与 L130/L138 的 cwd 语义注记矛盾。
- **low-3 — §6.6 `ok` 矩阵**：`docs/01-architecture.md:980-989` 仍以 `ok` 表述 `check`/`trace`，而 `check --json` 顶层是 §5.2 的 8 键（无 `ok`）。
- **low-4 — 策略证据路径带 `./` 前缀（仅指向根扫描时）**：`scanRoots:["."]` 产出的 `scanCandidates` 路径形如 `./.github/workflows/quality-gate.yml`，证据落盘前已被相对化（实测最终证据为 `../../.github/...`，可解析），故仅为中间产物层面的噪声。
- **low-5 — 评审文件归属**：`verification/.captain-freeze.json` 的"t9 前仅 verifier 可写 `verification/**`"与 t29 的落盘要求冲突，captain 已确认 `verification/review.md` 归 reviewer；本轮新增 `verification/review-round2.md` 同属 review 产物，请一并纳入归属口径。

---

## 3. 本轮新构造的绕过尝试（不复用第一轮的向量）

**NEW — 伪造整条审计链，让"覆盖率"无需任何真实运行**
- 构造（`E:\Desktop\qs2\demo2` 副本）：清空 `.qgate/evidence/**`，用 `packages/qgate/src/util/hash.mjs` 的 `sha256` 计算一个**自造账本文件**的真实哈希，写成 `ledger-<伪造 runId>.json`（条目覆盖 requirements-index 声明的全部 14 个 testId），再写入 `ledger-index.json`（`runIds`/`ledgers`/`testIds` 自洽、`sha256` 与文件一致）。
- 实测：`check` **未报 `EVIDENCE_UNRESOLVED`**（t28 新增的 `verifyLedgerChain()` 接受该链），`trace-complete` 通过；整体 exit 1 仅因我同时清空了 `test-results.json`/`ocr-findings.json`/`coverage.json`（属实验副作用），blocker 全为 `FILE_MISSING`。
- 结论：**H6 的修复是"抗意外/陈旧篡改"（三种真实篡改均 exit 3），但不抗伪造**——能写 `evidence/**` 的一方可以铸造覆盖率依据。这与 high-1 同源（证据面的来源性未绑定到"当前配置 + 真实执行"）。要求：要么在契约里如实限定（§5.3.2 加一句能力边界），要么引入外部锚点。

**NEW — SAFE_001 的 8 种写法矩阵**（`env 别名对象`、解构、计算名、大小写变体、getter 拼接、`globalThis.process.env.X`）：结果 7 种 BYPASS、1 种 DETECT（`globalThis.process.env.ANTHROPIC_API_KEY` 被检出）。其中**大小写变体**升为 high-3；其余（别名/解构/计算名/getter）归为**基于文本匹配的固有边界**，建议在 §5.1 的 policy 语义表加一句"本断言覆盖直接读取写法，不覆盖间接取值"，避免读者把它当语义级证明。

**NEW — SAFE_003 的 4 种写法**：`await import('node:https')`、`import * as h from 'node:http'; h.request(...)`、`globalThis['fe'+'tch'](...)`、`client.get(url)` 全部 BYPASS（`fetch(`/`http.request`/`net.connect` 三种字面形式仍 DETECT）。§5.1:425 的 token 枚举与实现一致，故按**文档已限定的能力**处理，仅建议 §8.3 的"网络访问禁止"改为"实现中不存在本策略枚举的调用形式"。

**回测（第一轮向量，确认已修/未修）**：路径穿越、Windows 反斜杠、双扩展名 `.env.mjs`、`secrets/` 与 `.opencodereview/secrets/` 目录伪装 —— 仍被挡住 ✓；大小写与硬链接 —— 仍未挡住 ✗（blocker-2 / high-2）。

---

## 4. 实际执行过的命令（cwd=`E:\Desktop\ai-quality-gate` 除非注明）

```powershell
# 指纹与并发
Get-ChildItem -Recurse -File | Where LastWriteTime -gt (Get-Date).AddMinutes(-8)
Get-FileHash packages/qgate/src/{core,policy,ledger,trace,cli,evidence}.mjs,demo/qgate.config.json,qgate.config.json,package.json -Algorithm SHA256

# item1 required/severity（自建 4 组配置，非读代码）
node packages/qgate/bin/qgate.mjs check --config <scratch>/t1{a,b,c,d,e}*.json --json
node -e "…demo/qgate.config.json 与根 qgate.config.json 的 (gate,check,severity,required,onFail) 清单…"

# item2 SAFE_001/003
node E:\Desktop\qs2\probe2.mjs                      # 12 必修 / 6 误报对照 / 8 种新绕过 / 4 种 SAFE_003 绕过
node --input-type=module -e "…policySafe001/003(scanRoots=null) + scanSurface + scanCandidates…"
node --input-type=module -e "…scanCandidates(resolveRepoRoot(demo/mini-service), scanRoots:['.'])…"
$env:QGATE_REPO_ROOT='E:\Desktop\qs2\empty-root'; node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs check --config <scratch>/emptyroot2/qgate.config.json --json   # 空扫守卫

# item4 三入口
npm run test --silent ; npm run test:all --silent ; npm run test:contract --silent
node --test --experimental-test-isolation=none "packages/qgate/test/*.test.mjs"   # ×3 采样
node --test --experimental-test-isolation=none packages/qgate/test/evidence-resolution.test.mjs   # ×4

# item5 账本篡改（三种）
<demo 副本> 改账本条目 passed / 改 ledger-index.ledgers[0].sha256 / 篡改 runIds + check --json

# item6 trace 不得自证
<demo 副本> 删 req-index-valid 检查 → check --json               # 有历史证据：exit 0
<demo 副本> 清空 evidence + 删同一检查 → check || true; trace --write; check   # 干净证据：exit 1 / TRACE_GAP
<demo 副本> requirements-index 声明 covered:false → check --json # exit 1 / rule 0

# item7 schema
node --input-type=module -e "…validate(schemas/trace-matrix.schema.json, trace --json | demo trace-matrix | verification/trace-matrix)…"

# item8 summary/preview
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --summary
node packages/qgate/bin/qgate.mjs preview --config demo/qgate.config.json --json

# item9 provider
<scratch>/pcheck.json（scripted + 无命中 fixture）→ check --json   # exit 3 / PROVIDER_FAILED
node --input-type=module -e "…auditEvidence(loaded.root, runResult) on a real demo run…"

# item11 适配层绕过
node adapters/opencodereview/bin/ocr-preview.mjs --diff <scratch>/diff.json --root <scratch> --json
node adapters/opencodereview/bin/ocr-preview.mjs --root <scratch> --json
New-Item -ItemType HardLink -Path <scratch>/docs.txt -Target <scratch>/.env

# 新绕过：伪造账本链
node --input-type=module -e "…sha256 + 自造 ledger/ledger-index → check --json…"
```

---

## 5. 方法局限与"could not confirm"

1. **采样窗口内有并发写入**（`src/checks/*`、`test/evidence-resolution.test.mjs` 于 03:12–03:13 被改），故 blocker-1 的"套件红"以 **3 次连续采样（88–89/90）** 为准，并已给出根因行号；若 owner 已在 03:13 之后修好接线，请在同一新修订上复跑 `npm run test`/`test:all`/`test:contract` 后再判定闭合。
2. **符号链接未实测**：本机 `New-Item -ItemType SymbolicLink` 被拒（`Administrator privilege required`），high-2 以硬链接（同 inode、内容逐字节相同）等价复现；Linux/CI 的符号链接可达性未实测。
3. **H4（§6.6 `ok` 矩阵）本轮未复测命令行键集**：批量探针进程异常退出，故按第一轮实测（`check --json` 无 `ok`）保留为 low。
4. **未逐行复核** `adapters/**` 的分组/规则实现与 `packages/qgate/src/report.mjs` 渲染细节；schema 求值仍用仓库自带的零依赖子集求值器（未与 ajv 交叉验证）。
5. **未评估** t7/t24/t31 的在制品；本轮只针对 t26/t27/t28 的修复面。
6. 本轮实验全部在 `E:\Desktop\qs2\`（项目根之外）与 `demo` 的临时副本中进行，评审结束已删除；工作区内只新增本文件。
