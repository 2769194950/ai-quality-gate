# verification/review-round3.md — t36 第三轮评审（放行闸门）

| 项 | 值 |
|---|---|
| 任务 | t36 [review]（attempt_id `02e3e00b-06de-468a-85e6-6ea03605fbad`） |
| 与历史的关系 | 本文件**取代** `verification/review.md`（t6 第一轮）与 `verification/review-round2.md`（t29 第二轮）的状态判定；两份保留为历史，其 blocker/high 编号沿用 |
| 复核对象 | t30/t32/t33/t34/t35/t37/t39/t41/t42/t43/t44 的修复面 + **t45 的 `verification-t9/report-v4.json`**（并按要求复核 `report-v3.json`） |
| 评审时刻 | 开工 04:04:28，收敛采样 04:05–04:07（本地 UTC+08:00） |
| **结论** | **needs_revision**（0 blocker / 2 high / 2 low / 2 info）——第二轮 6 项全部闭合，但本轮**新构造出 2 条未记账的绕过** |
| 是否修改实现 | 否。只读 `packages/**`、`adapters/**`、`schemas/**`、`docs/**`；只读引用 `verification-t9/**`（未运行任何会写入该目录的 verifier 工具）；本文件是唯一写入物 |
| 环境 | Node v24.19.0 / Windows / 离线、无 API Key |

## 0. 开工前提与树指纹

| 前提 | 状态 | 证据 |
|---|---|---|
| 依赖全部终态 | ✅ | t30/t32/t33/t34/t35/t37/t39/t41/t42/t43/t44/t45 均 completed；`report-v4.json`（30940 B，04:03:32）已落盘 |
| 连续两次指纹一致 | ✅ | 源面指纹（packages/adapters/docs/schemas/.github + 根配置，131 文件）**两次均为 `C902552E7F233C01`**（04:04:28 / 04:04:53）；近 4 分钟内源面无写入 |

评审时刻关键文件指纹（SHA256 前 16 位）：

```
C902552E7F233C01  = 源面聚合指纹（131 文件）
0D4EDDA0A3EED511  docs/01-architecture.md        (t44 终点值，151012 B)
916BC79C082558D1  docs/02-playbook.md            (t32 终点值)
F9D843A70AFA7A64  packages/qgate/src/contract.mjs (t43 终点值)
FEC70EF18128A458  packages/qgate/src/provider.mjs (t43 终点值)
DA9883D46B69B45E  packages/qgate/gates/README.md  (t43 终点值)
16BF3D65F8B09988  verification-t9/report-v3.json  (t40 冻结指纹)
EF3712333AC335D6  verification-t9/report-v4.json  (t45 冻结指纹)
```

---

## 1. 第二轮 6 项逐条闭合判定（全部闭合）

| # | 第二轮发现 | 判定 | 关键实测（命令 + 结果） |
|---|---|---|---|
| 1 | **R2-B1 适配层大小写绕过（blocker）** | ✅ **CLOSED** | 自建矩阵（`--diff` 与 `--root` 两模式）：`.ENV` / `.Env` / `.Env.production` / `.ENV.PRODUCTION` / `Credentials.json` / `CREDENTIALS.JSON` / `Secrets/db.txt` / `Secrets/Db.Txt` / `SECRETS/DB.TXT` / `CONFIG/TLS/SERVER.PEM` **10/10 全部 excluded**，reason 一律 `sensitive_path_never_included`；`--root` 模式用**盘上真实大写拼写**（`.ENV`、`.Env.production`、`CREDENTIALS.JSON`、`Secrets/Db.Txt`、`CONFIG/TLS/SERVER.PEM`）复测同样全排除；`safety.no_sensitive_selected=true`、`violations=[]` 与事实一致；`safety.hardlink_aliases=[]` 的语义已核实为"**included 集内没有别名**"（`adapters/opencodereview/src/selection.mjs:333-351`），不是漏报 |
| 2 | **R2-H2 硬链接别名（high）** | ✅ **CLOSED（适配层）** + ⚠️ 新发现见 R3-H1 | 5 个别名在**两模式**全部 excluded、reason 一律 `hardlink_secret_alias:same-inode-as-sensitive-path`：`docs.txt`→`.env`；**新变体** `notes.txt`→`credentials.json`；**新变体** `handbook.txt`→`secrets/db.txt`；**新变体** `multi1.txt`/`multi2.txt`（同一 inode 两个名字）→`.env`。目标内容刻意写成不可判形态（`OPAQUE_SECRET_MATERIAL_A1B2C3`）仍被排除 ⇒ 走**身份链**而非内容启发式。CI 常见布局（`<base>/diff.json` + `<base>/repo/…`，diff 含 6 个不存在路径、命中率 3/9）复测同样全排除 |
| 3 | **R2-H3 SAFE_001 env 名大小写变体（high）** | ✅ **CLOSED（引擎侧）** | 探针（`policySafe001` 单文件调用）：`process.env.anthropic_api_key`、`process.env.Anthropic_Api_Key`、`process.env["openai_api_key"]`、`process.env['openai_api_key']` **全部 DETECTED**；三类大写正写法 3/3 DETECTED；对照 4 条（注释 `apiKey`、散文、`process.env.PATH`、定义 `const apiKey=`）**0 误报** |
| 4 | **R2-H4 未知键（high）** | ✅ **CLOSED** | `provider` / `policy` / `selection` / `grouping` 各注入一个未知键 ⇒ **4/4 exit 2**、`error.code=CONFIG_INVALID`、消息指名该字段；对照 demo 与根配置仍 **exit 0** |
| 5 | **H8 历史证据掩盖（部分闭合）** | ✅ **CLOSED** | 用仓库自带 append-only 历史（**27 次 run、14 个 testId**）：① 删掉承载 `T-QG-003` 的 check ⇒ **exit 1**，blocker `TRACE_GAP: REQ-DEMO-006 is covered only by historical evidence: testId T-QG-003 is produced by check(s) "req-index-valid", which is absent from the current config`（第二轮此处 exit 0）；② **改 check.id**（`req-index-valid-renamed`）⇒ 同一 blocker，exit 1；③ 删 check 且同时撤掉该需求对 `T-QG-003` 的声明 ⇒ exit 1（testIds drift + historical-evidence blocker）；④ 对照（未改动、历史完整）⇒ exit 0 |
| 6 | **t35 信任边界记账（high）** | ✅ **CLOSED** | `docs/01-architecture.md:720-746`：明确"**只声明完整性一致性，不声明抗伪造**"，列出**能**发现的三种真实篡改（exit 3 / `EVIDENCE_UNRESOLVED`）与**不能**发现的"整条链的一致伪造"，并写明措辞纪律"不得被解读为证据不可伪造"。**我第二轮的整链伪造绕过在本轮仍成功**（见 §3 N-0），与文档一致 ⇒ 无过度承诺 |
| 7 | 复核 `report-v3.json` | ✅ 结构与自洽性通过 | `tree_fingerprint=16bf3d65…`、`tree_fingerprint_file_count`/`newest` 齐备、`summary={pass:27,fail:1,blocked:1,total:29}` 与 assertions 长度**自洽**（27+1+1=29）；#22（根配置 exit 0 的"为何"）与 #23（T-QG-007/015 真实测试存在）均带 `command` 与 `evidence` 落盘；#5/#6（反向用例 A/B）带**真实退出码**（我独立复现，见 §2） |
| 7b | 复核 `report-v4.json`（captain 指定的放行依据） | ✅ | `tree_fingerprint=ef371233…`（147 文件）、`summary={pass:31,fail:1,blocked:1,total:33}` **自洽**（31+1+1=33）、`supersedes=report-v3.json`；非 pass 两项已列明：#10 blocked（未验证项标 blocked）、#B4 fail（未物化 diff 路径污染计数，owner adapter-engineer） |
| 8 | **独立抽查 ≥3 条 pass 断言** | ✅ 抽 7 条，全部可复现 | 见 §2。未发现任何"不可复现"或与实测不符的断言 ⇒ 未触发"验证者自身不可信"的 blocker |

---

## 2. 独立抽查：自行复跑断言（≥3 条/报告）

| 断言 | 报告声称 | 我的独立复现 | 结果 |
|---|---|---|---|
| v3 #1/#2 | demo 五阶段 exit 0；`--summary` 为人类表格 | `check --config demo/qgate.config.json` ⇒ exit 0；`--summary` 输出 `stage | gate | required | passed | blockers | checks` 表格 | 一致 |
| v3 #14 / v4 #14 | `npm test` 与 `test:all` 覆盖一致且全绿 | `package.json:14-15` 两条脚本是**同一条命令**（引号 glob 全部 `*.test.mjs`）；实测 `test` **106/106**、`test:all` **106/106**、`test:contract` **25/25**（严格子集）、适配层 **94/94**，全部 exit 0 | 一致 |
| v3 #5/#6 | 反向用例 A/B 含真实退出码 | 自建副本：A-control（完整）exit 0；A（删 `.qgate/evidence/test-results.json`）⇒ **exit 1**，blocker `test-results-threshold | FILE_MISSING: .qgate/evidence/test-results.json does not exist`；B1（删 `version`）⇒ **exit 2 / CONFIG_INVALID**；B2（`check.type="file_exist"`）⇒ **exit 2 / CONFIG_INVALID**；B3（配置不存在）⇒ **exit 2** | 一致 |
| v3 #23 / v4 #23 | T-QG-007/T-QG-015 有真实测试与断言 | `evidence-resolution.test.mjs` 中 T-QG-007 用例 **7 处**（L57/75/103/148/174/197/221）；`ci-template.test.mjs` 中 T-QG-015 **5 处**（L240/258/275/291 + L1 注释）；另 `contract-hardening.test.mjs:245`、`schema-contract.test.mjs:878,970` 亦引用；`npm test` 106/106 通过 | 一致 |
| v4 #B2 | 显式 `provider.fixture` 不可用必须 fail-closed | 自建配置（deterministic + `fixture:"fixtures/missing.json"`）⇒ **exit 3 / `PROVIDER_FAILED`**、`message="provider fixture not found or unreadable: fixtures/missing.json"` | 一致 |
| v4 #B1 | 10 项安全判定 × 3 条路径全绿 | 我自建了更大的矩阵（10 类大小写变体 + 5 类别名 × `--diff`/`--root`/CI 布局），结论一致（§1 第 1、2 行） | 一致 |
| v4 #A4/#B4 | H8 复验通过；B4/F7 失败（未物化路径） | H8 我独立复现（§1 第 5 行）；**B4 我也独立复现了**：我的 CI 布局产物 `included=["gone/four.mjs","gone/one.mjs","gone/three.mjs","gone/two.mjs","src/app.mjs"]` ⇒ 5 个选中里 **4 个是不存在的路径**，`counts.selected=5`、分组 `gone(4)` 被计入 | 一致（验证者该项可信） |

结论：抽查的 7 条断言（覆盖 v3 与 v4、含正/反向）**在本次修订上全部可复现**；`report-v4` 的 `#B4` 失败项也被我独立确认为真。

---

## 3. 本轮**新构造**的绕过尝试（不复用前两轮）

### N-0（对照组，非缺陷）：整链伪造仍成功 —— 边界已如实记账
清空 `evidence/**` 后用引擎自身 `sha256` 写自造账本 + 自洽索引（覆盖索引声明的全部 14 个 testId）⇒ `check` **未报 `EVIDENCE_UNRESOLVED`**、`trace-complete passed=true`（整体 exit 1 仅因实验同时清空了 `test-results/ocr-findings/coverage` 三份 json_assert 目标）。与 `docs/01-architecture.md:720-746` 的记账一致 ⇒ **不是缺陷**。

### N-1（新，high）R3-H1：**引擎侧**没有硬链接身份链，`SAFE_002` 与 `qgate preview` 被别名绕过
- 构造：`E:\Desktop\qs3\eng-alias\`（`.env` 含 `ANTHROPIC_API_KEY=sk-ant-ENGINE-ALIAS`；`notes.txt` 为 `.env` 的**硬链接**，实测 `nlink=2` 且内容逐字节相同；`src/app.mjs`；配置 build 门禁 `SAFE_002` + verify 门禁 `SAFE_001`）。
- 实测：`check` ⇒ **exit 0 / overall_passed=true**；`SAFE_002` 证据 `metrics={"selected":3,"secretPathsExcluded":1,…}` 且 **passed=true**；`qgate preview --json` ⇒ `included=["notes.txt","qgate.config.json","src/app.mjs"]`、`invariants.secretPathsSelected=[]`。
- 文件:行：引擎规则是**纯按名**的 —— `packages/qgate/src/selection.mjs:38-47`（`secret-env` `**/.env*`、`secret-credentials` `**/credentials*`、`secret-dir` `**/secrets/**`）＋ `packages/qgate/src/policy.mjs:571`（`policySafe002` 只对 `SECRET_PATH_RULES` 做 glob 判定）；对照适配层已实现身份链：`adapters/opencodereview/README.md:359`（S6 / `SAFETY-005-HARDLINK-ALIAS`，`filters.detectHardlinkSecret()` 用 `nlink>1` + 同源 inode）。
- 性质判定：**不是文档过度承诺**（全仓库 `*.md` 中 `hardlink|SAFETY-005|same-inode` 只出现在适配层 README 与验证报告，未声称引擎侧覆盖）⇒ 属**两侧同一安全断言的实现不对称**，且引擎是 CI 直接跑的那一侧（根配置 `build-deterministic/no-secret-paths` 用的就是 `SAFE_002`）。
- 建议：由 captain 裁决 **(a) 补引擎侧身份链**（`selectFiles`/`filterFile` 增加同源 inode 判据，与适配层 S6 对齐），或 **(b) 明确记账为边界**（`packages/qgate/gates/README.md` 的 Boundaries 段新增一条：SAFE_002 为按名规则，不覆盖 inode 别名；并说明适配层侧更强）。owner：core-engineer（(a)）/ architect（(b)）。

### N-2（新，high）R3-H2：`stripComments()` 在 `/*` 未闭合时**吞掉文件其余部分**，可在**合法 YAML** 中隐藏真实读取/网络调用
- 文件:行（根因）：`packages/qgate/src/policy.mjs:122-127` —— `const end = text.indexOf('*/', i + 2); const stop = end === -1 ? chars.length : end + 2; blank(i, stop);`。**没有闭合 `*/` 时 `stop` 取文件末尾** ⇒ 之后所有内容被空格覆盖，扫描器看不见。
- 实测（`policySafe001`/`policySafe003` 单文件调用，逐样本）：
  ```
  NOT-DETECTED (bypass)  yaml: 'path: /*/build' 之后一行 node -e "const k = process.env.ANTHROPIC_API_KEY;"      [ci.yaml]
  DETECTED               yaml control：同一行读取、但没有 /* 标量                                        [ci2.yaml]
  NOT-DETECTED (bypass)  yaml: 'x: /*/glob' 之后一行 'y: fetch(url)'                                     [ci3.yaml]
  DETECTED               json: '{"glob":"/*","cmd":"const k = process.env.ANTHROPIC_API_KEY;"}'            [cfg.json]
  ```
  ⇒ 关键是 `.yaml`（以及任何被扫描的非引号感知语法）里出现 `/*` 且同文件无 `*/`：这是**合法文件**（`/*/build` 是合法 YAML 标量），不是畸形输入。
- 对照（说明扫描器的引号/正则感知本身是对的，缺陷只在"未闭合"这一分支）：跨行 `"/*" … "*/"` 字符串、正则字面量 `/\/\*/ … /\*\//`、JSON 字符串里的 `/*`、两个闭合块注释之后读取 —— **全部 DETECTED**；"读取位于两个字符串形态的开启符之间"亦 DETECTED。
- 记账缺口：`packages/qgate/gates/README.md:61-85`（Boundary 4）确实写明了"注释内的 env 读取/vault 引用/网络调用不再报告"（L79-80）以及引号/正则感知（L68-69），但**没有**写明"未闭合的 `/*` 会让该文件其余部分整体退出扫描面"。
- 建议修复（小）：仅在文件内**存在** `*/` 时才置空该跨度（`end === -1` 时按字面量处理，不置空）；或在 Boundary 4 增补该行为并把"未闭合开启符 = 整段不扫"记为已知假阴性（附本条实测）。owner：core-engineer（修）/ architect（记账）。
- 影响强度：`docs/01-architecture.md` §8.3 与 `docs/01-architecture.md:1021` 一带把"无网络访问/不需要 API Key"表述为**由 SAFE_001/SAFE_003 断言**的硬属性；本条给出的是该断言在**文档声明的扫描面内**可被规避的具体路径。

---

## 4. 其余级别

### low
- **R3-L1**：字符串字面量里的 token 会被 SAFE_003 命中 —— `const s = "https.request";` ⇒ DETECTED。这是既有的子串匹配语义（非本轮回归），但 `packages/qgate/gates/README.md:98-110` 只说明了 `cache.get(key)`/`headers.get('x')` 不命中，未提到"字符串字面量中的 token 会命中"。建议一句话记账。
- **R3-L2**（引用 report-v4 的失败项并**独立确认**）：未物化 diff 路径进入 `included/selected/groups`，使计数类审计数字偏高（我的产物：5 选中里 4 个不存在，`counts.selected=5`、`gone(4)`；token 未膨胀）。owner：adapter-engineer。

### info
- **R3-I1**：`safety.hardlink_aliases=[]` 与"5 个别名被排除"并不矛盾 —— 该字段列的是 **included 集内**的别名（`adapters/opencodereview/src/selection.mjs:333-351`，`ok = violations.length===0 && hardlinkAliases.length===0`），语义正确。
- **R3-I2**：根 `.qgate/out/evidence/ledger-…75870016.json` 仍引用已删的 `scratch.config.json`（t43 已上报 T43-1，waiting captain）。

---

## 5. captain 指定的四个复核点 + 两处诚实边界

| 复核点 | 判定 | 证据 |
|---|---|---|
| ① 三入口覆盖一致（绿/红不一致或集合不同 ⇒ blocker） | ✅ 通过 | `package.json:14-15`：`test` 与 `test:all` **是同一条命令**；`test:contract` 是其严格子集（`schema-contract.test.mjs`）。实测 106/106、106/106、25/25 全绿 ⇒ **不存在**"npm test 绿而 test:all 红"或"缩小范围制造假绿" |
| ② demo 未被手工调绿 + `scanRoots` 变宽量化 | ✅ 通过 | 19 个 check 与第一轮快照**逐项一致**（id/type/severity/required 全同）、`onFail:"warn"` 计数 **0**、`trace-complete` 的 `enforce` 仍 `"strict"`、`testIdSource="ledger-index"`。**变宽量化**（同一 demo root，切换两套 scanRoots）：round-1 的 4 子树 ⇒ `candidates=43 / scanned=39`（adapters=0）；现 `["."]` ⇒ `candidates=138 / scanned=94`（adapters=**33**、docs 1、prose 11 / fixtures 28 被排除）⇒ **确为变宽**，是"通用扫描面规则"消噪而非"排除 demo" |
| ③ F1 硬链接两模式 + ≥2 新变体 | ✅ 通过 | §1 第 2 行（5 别名 × 两模式 + CI 布局）；新变体：`secrets/**` 目标、同一 inode 两名、`credentials*` 目标 |
| ④ 独立抽查 ≥3 条 pass 断言 | ✅ 通过（抽 7 条） | §2；含 v3 #5/#6 真实退出码、v3/v4 #23 测试存在性、v4 #B2 fail-closed、v4 #B4 独立确认 |
| 边界 A：抗篡改 ≠ 抗整链伪造（不得过度承诺） | ✅ 记账准确 | `docs/01-architecture.md:720-746`；N-0 实测仍成功且与文档一致 |
| 边界 B：三类扫描面 + 注释跳过并列记账 | ✅ 已并列记账（含假阴性面） | 三类：`packages/qgate/gates/README.md:34-36`（prose / fixtures / generated-evidence）＋ L39-49 的量化（candidates 135 / scanned 96）；代价：L53-59「The cost of the narrowing (known blind spot)」（明确"`.md`/夹具里的真实密钥**不会**被发现"）；注释跳过：L61-85 Boundary 4，含 L79-80「**注释内的 env 读取/vault 引用/网络调用不再报告**」。**唯缺"未闭合 `/*`"分支** ⇒ 见 R3-H2 |

---

## 6. 结论与放行建议

**结论：`needs_revision`**（无 blocker；2 条 high 为本轮新构造的绕过，均为小改动可修）。第二轮 6 项（1 blocker + 4 high + 1 部分闭合）**全部闭合**；`report-v3` 结构自洽、抽查 7 条断言全部可复现，`report-v4` 的失败项也被我独立确认 ⇒ **验证者本身可信**。

**是否可放行**：**暂不建议无条件放行**；按以下两种处置之一即可放行（captain 裁决）：

| 残余项 | 级别 | 归属 | 最小修复 |
|---|---|---|---|
| R3-H1 引擎侧无硬链接身份链（SAFE_002 / preview 被别名绕过） | high | captain 裁决 → core-engineer（补身份链）或 architect（记为边界） | 对齐适配层 S6：`selectFiles`/`fileFilter` 增加同源 inode 判据；或在 `gates/README.md` Boundaries 增一条"引擎 SAFE_002 仅按名" |
| R3-H2 `stripComments()` 未闭合 `/*` 吞掉文件其余部分（可在合法 YAML 中隐藏真实读取/网络调用） | high | core-engineer（修）+ architect（记账） | `policy.mjs:122-127`：`end === -1` 时不置空（按字面量处理）；并补 Boundary 4 说明与反向用例 |
| R3-L1 字符串字面量 token 命中 | low | architect | 一句话记账 |
| R3-L2 未物化 diff 路径污染计数（report-v4 #B4） | low | adapter-engineer | 已在 report-v4 记账，或过滤未物化路径后再计数 |
| R3-I2 根 `.qgate/out` 残留 | info | captain | 清理或保留记账 |

若 captain 选择"按已记账边界放行"，则必须**同时**把 R3-H1/R3-H2 的边界写进 `packages/qgate/gates/README.md`（并同步 §8.3 的能力边界表），否则"SAFE_001/003 断言实现中不存在密钥读取/网络调用面"这句会被读成比实现更强的保证。

---

## 7. 本轮执行的命令（节选，全部可复现；cwd=`E:\Desktop\ai-quality-gate`）

```powershell
# 指纹 / 前提
Get-FileHash packages/qgate/src/*.mjs,docs/*.md,package.json -Algorithm SHA256      # 两次采样，聚合指纹 C902552E7F233C01
node --test --experimental-test-isolation=none "packages/qgate/test/*.test.mjs"      # 见 npm run test:all
npm run test --silent ; npm run test:all --silent ; npm run test:contract --silent   # 106/106、106/106、25/25（exit 0）
node adapters/opencodereview/tools/run-tests.mjs                                     # 94/94（exit 0）

# 大小写 / 硬链接（自建树，两模式 + CI 布局）
node E:\Desktop\qs3\build-tree.mjs
node adapters/opencodereview/bin/ocr-preview.mjs --diff <treeA>\diff.json --root <treeA> --json --quiet
node adapters/opencodereview/bin/ocr-preview.mjs --root <treeA> --json --quiet
node adapters/opencodereview/bin/ocr-preview.mjs --root <treeB> --json --quiet        # 盘上大写拼写
node adapters/opencodereview/bin/ocr-preview.mjs --diff <layout2>\diff.json --json --quiet   # diff 与仓库并列、命中率 3/9

# SAFE_001/003 矩阵（引擎侧）
node E:\Desktop\qs3\probe3.mjs        # 8+ 写法；大小写变体
node E:\Desktop\qs3\fp-matrix.mjs     # SAFE_003 误报对照 11 条 + SAFE_001 误报对照 5 条
node E:\Desktop\qs3\comment-probe.mjs ; node E:\Desktop\qs3\comment-probe2.mjs ; node E:\Desktop\qs3\reach-probe.mjs

# 新绕过 N-1 / N-2
node packages/qgate/bin/qgate.mjs check  --config <eng-alias>\qgate.config.json --json     # exit 0，SAFE_002 passed
node packages/qgate/bin/qgate.mjs preview --config <eng-alias>\qgate.config.json --json    # included 含 notes.txt(硬链接)
node <回归>；见 §3 N-2 的 yaml 样本

# 未知键 / H8 / 负向 / provider fixture / 伪造链
node packages/qgate/bin/qgate.mjs check --config <cfg-provider|policy|selection|grouping>.json --json   # 4/4 exit 2
node packages/qgate/bin/qgate.mjs check --config <demo5a|5b|5c>\qgate.config.json --json                # 3/3 exit 1 + TRACE_GAP
node packages/qgate/bin/qgate.mjs check --config <negA>\qgate.config.json --json ; <b1|b2|nope>.json    # exit 1 / 2 / 2
node packages/qgate/bin/qgate.mjs check --config <fx.json> --json                                       # exit 3 PROVIDER_FAILED
node E:\Desktop\qs3\final-checks.mjs ; node packages/qgate/bin/qgate.mjs check --config <forge>\qgate.config.json --json

# 文档与报告
Select-String -Path packages\qgate\gates\README.md -Pattern 'prose|fixtures|evidence|Boundary|comment'
Select-String -Path docs\01-architecture.md -Pattern '伪造|抗篡改|信任模型|EVIDENCE_UNRESOLVED'
node -e "…report-v3/v4：fingerprint / summary / assertions / 非 pass 项…"
Select-String -Path packages\qgate\test\*.test.mjs -Pattern 'T-QG-007|T-QG-015'
```

## 8. 方法局限（could not confirm）

1. **符号链接仍未实测**：本机 `New-Item -ItemType SymbolicLink` 无权限（`Administrator privilege required`），在允许符号链接的环境（或 Linux/CI）上 R3-H1（引擎侧）与适配层 S6 的等价性未验证；硬链接（同 inode）是等价复现。
2. **未运行任何会写入 `verification-t9/**` 的 verifier 工具**（如 `v3-cases.mjs`、`b1-coverage-matrix.mjs`），以免污染他人产物；因此对 report-v3/v4 的复核是"**自行复现其断言的底层命令**"（§2 抽 7 条），不是重跑其脚本本身。
3. **未逐条复核 report-v4 的 33 条断言**（只抽 7 条 + 核对非 pass 两项 + 结构自洽性）。
4. `R3-H1` 的"可达性"以本机 Windows（大小写不敏感、支持硬链接）为准；git 侧 `mode 120000` 符号链接路径未实测。
5. 本轮实验全部在 `E:\Desktop\qs3\`（项目根之外）进行，评审结束已删除。

---

## 9. 评审后自审补执行（task t36 已终态；本节为追加记录，不改动 §1–§8 的原始判定）

对 t36 契约逐条自审后发现 5 处**未执行或仅部分执行**，其中 3 处可立即补做并已补做；补做**新暴露 1 条 blocker 级缺陷**。

### 9.1 自审发现（如实列出）

| # | 契约要求 | 我实际做了什么 | 性质 |
|---|---|---|---|
| 1 | 第 3 项："`process.env.anthropic_api_key` 等**引擎侧与适配层侧都要测**" | 引擎侧做了完整矩阵；**适配层侧只读了源码、没有实跑** | **未执行（已补做，见 9.2-1）** |
| 2 | 第 8 项："**自行复跑其 `command`**"（report 的 assertions 含 `node verification-t9/tools/*.mjs`） | 为不污染 verifier 目录，改为**自行复现其断言底层命令**（未运行 verifier 脚本本身） | **部分执行（已披露于 §8-2，受控偏离）** |
| 3 | 第 7 项："`tree_fingerprint` 是否与**会话开始**一致" | 只读取 v3/v4 的指纹字段与文件数、核对自洽性；**未用同一算法在同一范围复算** | **部分执行（同一算法复算未做）** |
| 4 | 第 5 项："额外尝试：**只删该 check 的一部分**，或改名 check.id" | 做了"改名 check.id"与"删 check + 撤声明"两个变体；**"只删一部分"未字面执行** | **部分执行（已补做，见 9.2-3）** |
| 5 | 引擎侧 SAFE_002 的**大小写**行为（与第 1 项同族；契约未逐字要求，但前两轮也只测了适配层） | 前两轮均未测引擎侧名字规则的大小写 | **未执行（已补做，暴露 9.3 的 blocker）** |

### 9.2 补做结果

1. **适配层侧 SAFE_001/SAFE_003**（`adapters/opencodereview/src/ocr-runner.mjs` 的 `assertNoApiKeyRequirement()` / `scanNetworkSurface()`）：5 种 env 取密钥写法（`ANTHROPIC_API_KEY` / `anthropic_api_key` / `Anthropic_Api_Key` / `["ANTHROPIC_API_KEY"]` / `["openai_api_key"]`）**全部检出**（`ok:false` + 行号）⇒ 适配层侧大小写**不敏感**，与 t33 声称一致；`fetch(` 亦检出。**新发现 R3-L3（low）**：**裸模块导入**在适配层不报——`const m = await import("node:https");` ⇒ `violations=[]`（仅 `aliases` 记录），而"导入后调用"（`m.request(opts)`）⇒ `violations=[{via:"imported-module-alias"}]`；对照**引擎侧** SAFE_003 把裸导入也计为 `network module import/require` ⇒ 两侧同一断言覆盖不一致（owner: adapter-engineer）。
2. **引擎侧**：见 9.3（本条为 blocker）。
3. **第 5 项"只删该 check 的一部分"**（保留 `req-index-valid` 的 id，把 `assertions` 换成 `{pointer:"/requirements", exists:true}` 这种"空转但通过"的断言）⇒ **exit 0 / overall=true / 无 blocker**。判定：**不是绕过**——`check.id → testId` 映射只看"该 check 是否执行"，不看断言实质；这与 §1 第 5 行（t34 历史证据规则）配合后结论自洽。记 **info（R3-I3）**，建议契约写明这层语义。

### 9.3 补做暴露的新缺陷：**R3-B1（blocker）引擎侧密钥路径规则区分大小写**

- 构造：两棵**同构**树、同一份配置（`file_exists src/app.mjs` + `policy SAFE_002`），唯一差别是**盘上文件名大小写**——UPPER：`.ENV`、`Credentials.json`、`Secrets/Db.Txt`、`CONFIG/TLS/SERVER.PEM`；lower（对照）：`.env`、`credentials.json`、`secrets/db.txt`、`config/tls/server.pem`。
- 实测（`check --json` + `preview --json`）：

| 树 | `preview.selection.included` | SAFE_002 证据 | 排除项 reason |
|---|---|---|---|
| **UPPER** | `["Credentials.json","Secrets/Db.Txt","qgate.config.json","src/app.mjs"]` | `passed=true`、**`secretPathsExcluded: 0`**、`selected: 5` | `.ENV:extension`、`CONFIG/TLS/SERVER.PEM:extension`（仅被扩展名白名单**偶然**挡住，非 `secret_path`） |
| **lower（对照）** | `["qgate.config.json","src/app.mjs"]` | `passed=true`、**`secretPathsExcluded: 4`**、`selected: 2` | `.env:secret_path`、`credentials.json:secret_path`、`secrets/db.txt:secret_path`、`config/tls/server.pem:secret_path` |

- 结论：**同一棵树、同一配置，仅字母大小写不同** ⇒ 引擎把 `Credentials.json` / `Secrets/Db.Txt` 当普通文件**选中**，而 `SAFE_002` 仍报"密钥路径未被重新纳入"，且 `secretPathsExcluded=0`（连"挡住了几个"都是零）。这与第二轮被判 **blocker** 的 R2-B1（适配层大小写）是同一类缺陷，适配层已在 t33 修复，**引擎侧从未修也从未被测**。
- 文件:行：`packages/qgate/src/util/glob.mjs:69`（`globMatch` 大小写敏感）＋ `packages/qgate/src/selection.mjs:38-47`（`SECRET_PATH_RULES` 全小写 pattern）＋ `packages/qgate/src/policy.mjs:571`（`policySafe002` 复用这些规则）。对照适配层已大小写不敏感：`adapters/opencodereview/src/filters.mjs:249`（`isSensitivePath`）与 `:111-115`（`isSensitiveExtension` 先 `toLowerCase()`）。
- 可达性：**不需要 diff**——仓库里存在 `Credentials.json` 这类大写拼写的文件即成立；而根配置 `build-deterministic/no-secret-paths` 用的正是引擎侧 `SAFE_002`，CI 主路径直接受影响。
- 要求修复：`packages/qgate/src/selection.mjs` 的密钥路径判定（及扩展名/目录段比较）做大小写归一化，并补引擎侧大小写反向用例；与 R3-H1（inode 身份链）建议**同批修复**——两者都是"引擎侧安全断言弱于适配层"。

### 9.4 追加后的判定

- 级别分布变为 **1 blocker（R3-B1）+ 2 high（R3-H1 引擎别名、R3-H2 未闭合注释）+ 3 low（R3-L1、R3-L2、R3-L3）+ 2 info（R3-I2、R3-I3）**。
- **放行建议方向不变且更强**：§6 的"暂不建议无条件放行"依然成立；现在**必须**先处理 R3-B1——它能让"密钥路径不可被重新纳入"在 CI 主路径上直接失效。最小修复集：R3-B1 + R3-H1（同一文件族，core-engineer）+ R3-H2（`policy.mjs:122-127`，core-engineer）；记账项归 architect。
- 说明：t36 已终态（`failed`），本节为评审文件的追加记录，未改动任何实现文件；补做实验在 `E:\Desktop\qs4\`（项目根之外）进行，完成后已删除。

### 9.5 当前修订复核（10:2x，树自我评审后已移动约 6 小时）

评审后源面指纹由 `C902552E7F233C01` 变为 `04107D952C89386E`（`packages/qgate/src/selection.mjs` 04:14:02、`packages/qgate/src/policy.mjs` 04:12:07、`adapters/opencodereview/src/{selection,filters}.mjs` 04:22/04:38 均在我评审之后被改）。我据此对 §9 的三条发现与 §4 的 L3 做了**同构造复测**：

| 发现 | 评审修订（C902552E…） | 当前修订（04107D95…） | 证据 |
|---|---|---|---|
| **R3-B1 引擎侧大小写** | 复现 | **仍未修（OPEN）** | `case-upper`：`included=["Credentials.json","Secrets/Db.Txt","qgate.config.json","src/app.mjs"]`、`SAFE_002 secretPathsExcluded: 0`；`case-lower` 对照：`included=["qgate.config.json","src/app.mjs"]`、`secretPathsExcluded: 4`（四条 reason 全为 `secret_path`） |
| **R3-H1 引擎侧硬链接别名** | 复现 | **机制已在评审后修好（FIXED）**，残留受 R3-B1 限制 | `selection.mjs:144-194` 已加入 `ino:<dev>:<ino>` 身份集 + `nlink > 1` 门 + `reason=hardlink_secret_alias`（对齐适配层 `SAFETY-005`）；复测：`notes.txt`→`credentials.json`（小写敏感目标）⇒ **included 不含它、excluded 含 `notes.txt:secret_path`**（其自身名字无害 ⇒ 只能由身份链解释）——修复生效；但 `notes.txt`→**`Credentials.json`**（大写目标）仍被 included，因为目标未被识别为敏感文件（即 R3-B1 的后果） |
| **R3-H2 未闭合 `/*` 吞掉文件其余部分** | 复现 | **已修（FIXED）** | `policy.mjs:134-141` 新增未闭合分支（`if (end === -1) { … }`）；同一 `cmt` 树复测 ⇒ SAFE_001 **DETECTED**（violations=2）、SAFE_003 **DETECTED**（violations=2），而评审时为 NOT-DETECTED |
| **R3-L3 适配层裸模块导入不报** | 新增（low） | 仍 OPEN（该文件未变：`ocr-runner.mjs` mtime 03:20:12 < 评审） | `const m = await import("node:https");` ⇒ `violations=[]`；`m.request(opts)` 同行则命中 `imported-module-alias` |

**因此最小修复集收缩为：R3-B1（blocker，core-engineer）+ R3-L3（low，adapter-engineer）**；R3-H1 只需在 R3-B1 修好后复测其大写目标的别名变体（预期随名字规则归一化而自动闭合），R3-H2 已闭合。放行建议方向不变：R3-B1 未修之前不建议放行——它仍能让"密钥路径不可被重新纳入"在 CI 主路径上失效。
