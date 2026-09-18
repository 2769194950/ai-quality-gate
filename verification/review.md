# verification/review.md — t6 评审门禁：对全部制品的对抗式评审

| 项 | 值 |
|---|---|
| 任务 | t6 [review]（attempt_id `658867c7-b9f5-44e1-822b-bab19a203773`） |
| 评审人 | reviewer（对抗式评审） |
| 评审对象 | `E:\Desktop\ai-quality-gate`（junction 两侧等价） |
| 评审快照时刻 | 2026-09-18 02:41–02:47（本地，UTC+08:00） |
| 结论 | **needs_revision**（02:47 复查：4 条 blocker 仍成立——B1/B3/B4/B5(引擎半边)；B2/H9 与 B5(适配层半边) 已在评审窗口内被 owner 修好，逐条标注） |
| 是否修改实现 | 否。本轮只读 `packages/**`、`adapters/**`、`schemas/**`、`docs/**`；本文件是唯一写入物 |
| 复现环境 | Node v24.19.0 / Windows / 无网络、无 API Key |

## 0. 快照与并发告警（必读，影响结论的可复现性）

评审期间**树在被我方其他成员持续修改**。`-- 02:40:56 docs/02-playbook.md`、`02:40:59 adapters/opencodereview/src/ocr-pipeline.mjs`、`02:39:52 adapters/opencodereview/ci/github-actions.yml`、`02:39:40 package.json`、`02:38:26 .github/workflows/quality-gate.yml`、`02:35:52 schemas/config.schema.json` 均在评审窗口内被写入（`Get-ChildItem -Recurse | Where LastWriteTime -gt (Get-Date).AddMinutes(-15)` 实测）。

因此本报告区分两类发现：

- **结构性发现**（代码/契约级，与并发无关）：B1/B2/B3/B4/H1–H10/M1–M11，均给出 `文件:行号` 与可重复命令；
- **时点性事实**（在快照时刻为真，可能已被并发改动覆盖）：B5 的两个套件转红。playbook §6.12/§8 已独立记录同一现象。

被引用的关键文件 SHA256（前 16 位，02:41:06 采样）：

```
DD35D25AEEF7A25E  packages/qgate/src/core.mjs
CF4F09F9E4720DE8  packages/qgate/src/policy.mjs
65FC4C43507B39F4  packages/qgate/src/cli.mjs
1294C6DCA5DF9694  packages/qgate/src/config.mjs
BDE535000B818DC8  packages/qgate/src/contract.mjs
291BBF656422262B  packages/qgate/src/provider.mjs
C6FE3DA4256B84EE  packages/qgate/src/ledger.mjs
229B380E3BB27C54  adapters/opencodereview/src/filters.mjs
96C09F738125BD09  adapters/opencodereview/src/selection.mjs
9816402BAA7286F7  schemas/config.schema.json
4F55A41FBE3E8566  docs/01-architecture.md
A29CFF7DA67950AD  docs/02-playbook.md
CC9563C983352CA9  .github/workflows/quality-gate.yml
5D7082D947D6B996  package.json
```

另：`verification/.captain-freeze.json:26-30` 规定"t9 完成前除 verifier 外任何成员不得在 `verification/**` 下创建/修改/删除任何东西"，而 t6 任务文本要求把评审结论落到 `verification/review.md`。我按任务文本执行（该文件此前不存在，非覆盖他人产物），但**这条冲突需 captain 显式裁决**（见 M11）。

### 0.1 评审窗口内的修订增量（02:45:23 复查，必须与上面结论一起读）

评审过程中树又变了；对第 2 节的发现逐条复查后，有 2 项状态变化，已就地标注：

| 项 | 02:41 快照 | 02:45:23 复查 | 处理 |
|---|---|---|---|
| B5 适配层半边 | `tests 57 / pass 51 / fail 6` | **`tests 58 / pass 58 / fail 0`（exit 0）** —— 夹具与 CI 用例已被 owner 修正 | B5 降级为"引擎半边仍红"；适配层半边改记 **resolved during review** |
| B2 `check --stage` 多出 `skipped`/`skipReason` | 5 个门禁、含 2 个非冻结键 | **已修**（`core.mjs` mtime 02:46:26，sha256(16)=`62F0BF55E2B52F30`）：`check --stage requirements --json` 现只输出 1 个门禁（`req-spec:requirements`），对 `schemas/run-result.schema.json` 求值 `valid=true errors=0` | B2 改记 **resolved during review**；残留一处文档缺口（见 B2 末段） |
| H9 根 `package.json` 脚本指向不存在的配置 | 7 个脚本全指向 `demo/mini-service/.qgate/config.json` | **已修**（`package.json` mtime 02:43:53，sha256(16)=`805252A713FCF8A5`）：脚本改为 `demo/qgate.config.json`，实测 `check` 脚本 exit 0 / 5 门禁全绿 | H9 改记 **resolved during review** |
| B1/B2/H6/H7/M2/M3/M4 | 复现 | **复现不变**（`core.mjs` sha256 仍为 `DD35D25AEEF7A25E`、`policy.mjs` 仍为 `CF4F09F9E4720DE8`、`schemas/config.schema.json` 仍为 `9816402BAA7286F7`） | 维持 blocker/high/medium |

复查命令与结果：

```
node --test --experimental-test-isolation=none packages/qgate/test/config-and-run-result.test.mjs packages/qgate/test/pipeline-and-checks.test.mjs packages/qgate/test/acceptance.test.mjs
  => tests 39 / pass 39 / fail 0  (exit 0)        # 新版 package.json 的 "test" 脚本
node --test --experimental-test-isolation=none "packages/qgate/test/*.test.mjs"
  => tests 62 / pass 61 / fail 1  (exit 1)        # 新版 "test:all" 脚本
node adapters/opencodereview/tools/run-tests.mjs
  => tests 58 / pass 58 / fail 0  (exit 0)
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json
  => exit 0, overall_passed=true, 5/5 门禁 passed
```

**新发现 H11（medium，随 02:43:53 的 `package.json` 改动引入）**：新 `test` 脚本**不再包含** `schema-contract.test.mjs`（`package.json:14` 只列 3 个文件），把红着的契约漂移套件挪到单独的 `test:contract`；因此 `npm test` 变绿**不代表**契约套件变绿，而 `npm run test:all` 仍 exit 1。属于"验收入口把失败项移出默认路径"的风险，要求修复：要么修好 drift 期望表让全量转绿，要么在 README/playbook 明示 `test` 不覆盖契约套件。

---

## 1. 结论与理由

**结论：needs_revision。**

核心理由（每条都有第 2 节的可复现证据）：

1. **门禁会静默放过失败的必需检查**（B1，02:47 仍复现）：`severity ∈ {medium, low}` 的必需检查失败时，`gate.passed=true`、`overall_passed=true`、退出码 0，而 `checks[].passed=false` 明明写着失败。契约两处（§5.2 `gates[].passed` 定义、§9.2 伪代码）与需求文件§2 的"硬失败"定义都要求该门禁失败 ⇒ 门禁判定不可信，这是质检工具最不能有的缺陷。
2. **引擎自己的阶段输出违反自己的冻结 schema**（B2）：`check --stage <s>` 输出多出 `skipped`/`skipReason`，`schemas/run-result.schema.json` 判 `valid=false`（REQ-004 的键集合断言被打破）。CI 的四个阶段 job 正是这条命令。
3. **SAFE_001 检不出它声称要检的密钥读取**（B3）：`process.env.ANTHROPIC_API_KEY`（标准取 Key 写法）实测 **NOT-DETECTED**，而注释里出现 `apiKey` 反而被检出。即"无密钥读取"这条安全不变量目前是文档承诺，不是代码强制。
4. **冻结文档点名的验证资产大面积不存在**（B4）：`docs/00-requirements.md` §3 逐条写明的 11 个测试文件、`packages/qgate/gates/stage-order.json`、`adapters/opencodereview/bin/ocr-adapter.mjs`、REQ-009 的 `verification/end-to-end.json`、REQ-015 的 `verification/ci-parity.json` 全部缺失 ⇒ 12/16 条需求"验证方式"按原文不可执行。
5. **引擎交付套件在快照与复查时刻都是红的**（B5）：`tests 62 / pass 61 / fail 1`（02:45:23 复查，失败项恒为 `schema-contract.test.mjs:845` 的 `config:humanGate: surplus [gateId]`）；适配层半边在评审窗口内已由 owner 修到 `58/58`。t2/t8/t18 的"60/60 全绿"在其采样时刻为真、在 HEAD 上不可复现（`verification-t9/artifacts/engine-suite-official.txt:76-79` 采于 02:34:18，早于 02:35:52 的那次 schema 改动）。

同时**明确通过**的部分（每条有实测证据，见 §3）：五阶段顺序与三处人类门禁的强制、退出码 0/1/2/3 矩阵、`--json`/`--summary` 互斥、非法配置 exit 2、ocr 缺失降级 exit 0、四份 schema draft 2020-12 且无 `type:[...]` 联合、实现源码零网络调用面、零运行时依赖、`contract --check` 通过、playbook 与 verifier 报告的自我披露（§6.12/§7.2/§8、blocked 清单）。

---

## 2. 发现清单（按级别分组）

### blocker

**B1 — 必需检查失败可被静默放过（severity 门控与冻结契约冲突）**
- 证据：`packages/qgate/src/core.mjs:177`（`blocking = outcome.passed === false && required && onFail !== 'warn' && (check.severity === 'blocker' || check.severity === 'high')`）、`:218`（`hardBlockers` 过滤）、`:219`（`passed = hardBlockers.length === 0`）、`:243`（`overall_passed`）。
- 冲突处：`docs/01-architecture.md:521`（"全部 required 检查 passed=true（且人类门禁满足）时为 true"）、`:1086-1093`（§9.2 伪代码：任一 required 非 warn 失败即 `gate.blockers.push`）、`docs/00-requirements.md:40`（"硬失败 = 必需门禁中的必需检查失败"）、`:71-72`（REQ-003 的七类 check 失败语义）。
- 复现（实测）：配置 `{"version":"1.0","provider":{"type":"deterministic"},"gates":[{"id":"g1","stage":"build","required":true,"checks":[{"id":"c-medium","type":"regex","required":true,"files":["file.txt"],"pattern":"NEVER_MATCHES_XYZ","mode":"each"}]}]}` ⇒ **exit 0**、`overall_passed=true`、`gate g1 passed=true blockers=0`、`checks[0] = regex:passed=false:sev=medium`。
- 放大项：`regex` 的**默认 severity 就是 `medium`**（`docs/01-architecture.md:403`），而 §5.1 的合法示例 `req-ids-present`（`:237-241`）恰好没写 `severity` ⇒ 照文档写配置即落入静默放过。
- 要求修复：二选一并由 captain 裁决后再改——(a) 代码改为"required 且非 warn 的失败一律进 `blockers`"（同时按 severity 记录）；或 (b) 修改 §5.2:521 / §9.2:1086 / 需求§2:40，明确"仅 `blocker|high` 阻断"并同步 `docs/requirements-index.json`。当前 `docs/02-playbook.md:235` 已按 (b) 的口径叙述，等于三份文档互相矛盾。

**B2 — `check --stage` 的 RunResult 曾违反冻结 schema（02:46:26 已修，保留记录 + 1 项文档残留）**
- 02:41/02:45 证据：`packages/qgate/src/core.mjs:58-72`（`skippedGate()` 多写 `skipped`/`skipReason`）、`:231`；实测 `check --config demo/qgate.config.json --stage requirements --json` 输出 5 个门禁、后 4 个带 `skipped`/`skipReason`，对 `schemas/run-result.schema.json` 求值 `valid=false`（8 条 `additionalProperties` 错误）；`.github/workflows/quality-gate.yml:130/160/188/246` 的四个阶段 job 正是这条命令。
- 02:47 复查（`core.mjs` mtime 02:46:26，sha256(16)=`62F0BF55E2B52F30`）：同一命令输出 `top keys=version,run_id,…,gates`、`gates len=1`（只有 `req-spec:requirements`），schema 求值 `valid=true errors=0` ⇒ **resolved during review**（`skipped`/`skipReason` 仍存在于源码内部但不进入 RunResult）。
- 残留（medium，要求补文档）：`docs/01-architecture.md:512`（"gates 顺序 = 阶段顺序"）与 `:711`（`--stage` 只跑到该阶段）都**没有**说明过滤后 `gates[]` 只含被执行的门禁、其余门禁不再出现；这正是 CI 阶段 job 的机器可读制品形状，需显式写进 §5.2/§6.2，否则消费方会以为拿到了完整五阶段文档。

**B3 — SAFE_001 检不出契约声称要检的密钥读取**
- 证据：`packages/qgate/src/policy.mjs:29-36`（token 清单）、`:54-69`（`tokenRegExp` 在词尾追加 `\b`）；契约 `docs/01-architecture.md:423`（SAFE_001 断言不得出现 `apiKey`/`ANTHROPIC_API_KEY` 的读取）、`:1022`、`packages/qgate/src/contract.mjs:129`。
- 实测探针（见附录 A 的 `probe-policy.mjs`，逐样本单文件调用 `policySafe001`/`policySafe003`）：

```
NOT-DETECTED  const k = process.env.ANTHROPIC_API_KEY;        <- 标准取密钥写法
DETECTED      const k = process.env.ANTHROPIC;
NOT-DETECTED  const k = process.env['ANTHROPIC_API_KEY'];
NOT-DETECTED  const k = process.env.OPENAI_API_KEY;
DETECTED      // apiKey is read here                          <- 纯注释文本也命中（误报）
NOT-DETECTED  const k = process.env.PATH;
DETECTED      const t = process.env.TOKEN;
NOT-DETECTED  const t = process.env.TOKEN_SECRET;
DETECTED      const c = secrets.get('x');
```

- 配置级复现：把 `const k = process.env.ANTHROPIC_API_KEY;` 放进被 `policy.scanRoots` 覆盖的目录，`check` 输出 `safe1 passed=true … SAFE_001 metrics={"filesScanned":2,"violations":0,…}`。
- 根因：`\b` 加在 `ANTHROPIC` 之后，而 `_` 是单词字符 ⇒ `ANTHROPIC_API_KEY` 处无词边界；`process.env.X` 的**点号写法专用 token** 天然漏掉方括号与 `?.` 写法。
- 要求修复：以"标识符 + 后缀"方式匹配（如 `(?:process\.env|globalThis\.process\?\.env)[.[\s'"]*[A-Z_]*API_?KEY`、`*_API_KEY`、`secrets\.`），并补反向用例；修复前不得声称"零密钥读取由代码强制"。

**B4 — 冻结文档点名的验证资产缺失（需求覆盖证据断链）**
- 实测缺失清单（`Test-Path` 均为 `MISSING`）：
  - `packages/qgate/test/{checks,run-result-shape,determinism,trace-matrix,evidence-resolution,human-gate,zero-dep,cli,severity,provider,human-gate-required}.test.mjs` —— 分别被 `docs/00-requirements.md:73,81,89,97,105,113,129,137,153,161,177` 的"验证方式"点名；
  - `packages/qgate/gates/stage-order.json`（`docs/00-requirements.md:57` 的核对基准）；
  - `adapters/opencodereview/bin/ocr-adapter.mjs`（`:145` 的验证命令、`docs/01-architecture.md:947` 的布局）；
  - `verification/end-to-end.json`（`docs/requirements-index.json:20`，REQ-009 的强制交付物）、`verification/ci-parity.json`（`:26`，REQ-015 的强制交付物）；
  - `packages/qgate/src/run-result.mjs`（`docs/requirements-index.json:15`）、`packages/qgate/src/severity.mjs`（`:24`）—— codePaths 指向不存在的实现文件；
  - `verification/negative/secret-include.json`、`verification/negative/oom-unknown-type.result.json`（`docs/00-requirements.md:145`、`docs/01-architecture.md:294`）。
- 影响：12/16 条需求的"验证方式"按原文不可执行；REQ-009（P0）与 REQ-015（P1）的验收制品不存在，而 trace-matrix 仍把它们判为 `covered=true`（见 H8）。
- 要求修复：把文档中的测试文件名改为真实存在的四个套件（或补齐同名文件），并真实产出 `verification/end-to-end.json` / `verification/ci-parity.json`。

**B5 — 引擎套件在快照与复查时刻均为红（"全绿"结论不可复现；适配层半边已在评审窗口内修复）**
- 引擎：`node --test --experimental-test-isolation=none <4 个 test 文件>` ⇒ `tests 61 / pass 60 / fail 1`（02:41），02:45 复查为 `tests 62 / pass 61 / fail 1`（exit 1），失败项恒为同一条。失败用例 `packages/qgate/test/schema-contract.test.mjs:845`：`field-table drift detected: config:humanGate: surplus [gateId]`；成因是同一文件 `:771` 的硬编码期望表 `config:humanGate: ['role','approvalRecord','enforcement']` 未随 `schemas/config.schema.json:171`（新增 `gateId`，mtime 02:35:52）与 `docs/01-architecture.md:392` 同步。附带事实：`verification-t9/artifacts/engine-suite-official.txt:76-79` 记录的是 02:34:18 采样的 `tests 60 / pass 60`，即**该证据采集于破坏性改动之前**。
- 适配层：02:41 为 `tests 57 / pass 51 / fail 6`（exit 1）：3 条 `ci-workflow.test.mjs`（`:103` 要求 `check --config "$QGATE_FULL_CONFIG" --json` 与 `QGATE_ENTRY: packages/qgate/bin/qgate.mjs`，而 workflow 于 02:38:26 已被改成 `QGATE_CI_CONFIG` 三段式）＋ 3 条 `fixtures.test.mjs:53,63,67` 夹具失配；**02:45 复查为 `tests 58 / pass 58 / fail 0`**（owner 已修），故适配层半边记为 resolved during review，仅保留"同一类改动未同步期望值"的过程教训。
- 附注：字面量 `node --test packages/qgate/test/`（旧的根 `test` 脚本）在本沙箱因 `spawn EPERM` 失败（`errno:-4048`），与本项目代码无关；新的根 `test` 脚本改为显式列 3 个文件后已 exit 0（但它不再覆盖契约套件，见 H11）。
- 要求修复：同步 `schema-contract.test.mjs:771` 的期望表（补 `gateId`）或回退 t17 对 `humanGate.gateId` 的声明，然后让 `test:all` 转绿并重新采样证据；在此之前任何"套件全绿/契约冻结闭合"的结论都不可引用。

### high

**H1 — `--config` 相对路径按 cwd 解析，与 §6.1 "相对项目根"不符**
- 证据：`packages/qgate/src/config.mjs:583`（`path.resolve(cwd, configPath)`）、`packages/qgate/src/cli.mjs:209`（传入 `cwd: process.cwd()`）；文档 `docs/01-architecture.md:698`。
- 复现：`cd packages/qgate; node bin/qgate.mjs check --config demo/qgate.config.json --json` ⇒ **exit 2**（`CONFIG_NOT_FOUND`）；同一命令在仓库根 ⇒ exit 0。（t18 亦独立观测到同一现象，见 `verification-t9/review.md:36`。）
- 修复：文档改为"相对当前工作目录"，或实现按 `--root`/配置文件锚点解析。

**H2 — `--summary` 输出 JSON，而非文档承诺的人类可读表格**
- 证据：`packages/qgate/src/cli.mjs:150-158`（`if (ctx.options.json || ctx.options.summary) body = stringifyJson(value)`）；文档 `docs/01-architecture.md:701`（"人类可读表格摘要"）、`:711`（"每个门禁一行：stage | gate | passed | blockers | checks"）。
- 复现：`check --config demo/qgate.config.json --summary` ⇒ 输出 `{"overall_passed":true,"gates":[{...skipped...}],"run_id":…,"provider":…,"approvals_missing":0}`；人类可读表格只在**既不给 `--json` 也不给 `--summary`** 时打印（`cli.mjs:372` 的 `text` 分支）。
- 附带：`--summary` 的 gate 对象含 `skipped` 键（非冻结字段，见 B2），`approvals_missing` 也不在文档的摘要形状里。

**H3 — `preview --json` 顶层键与 §6.2.1 "恰好三项"不符**
- 证据：`packages/qgate/src/cli.mjs:456-465`；文档 `docs/01-architecture.md:721`。
- 复现：实测顶层键为 `ok,degraded,root,selection,groups,ruleMatch,rules,invariants`（8 个，含 `rules.sources[].path` 指向不存在的 `packages/qgate/gates/builtin-rule.json`，见 L4）。
- 修复：或补文档（把 `ok/degraded/root/rules/invariants` 正式列为输出面），或收缩实现。

**H4 — §6.6 的 `ok` 矩阵对 `check`/`trace` 不可满足**
- 证据：文档 `docs/01-architecture.md:896-903`（`check` ⇒ `ok = overall_passed`，`trace` ⇒ `ok = true`）；实测 `check --json` 顶层键为 `version,run_id,started_at,finished_at,duration_ms,overall_passed,provider,gates`（无 `ok`，与 §5.2 一致）、`trace --json` 顶层键为 `schemaVersion,generated_at,generated_by,run_id,pipeline,summary,requirements,violations`（无 `ok`）。
- 连带：`docs/00-requirements.md:136`（REQ-011 验收"`--json` 输出 top-level `ok` 取值符合 §6.6 矩阵"）按原文不可满足。

**H5 — 引擎校验比冻结 schema 松：四个嵌套对象接受未声明的键**
- 证据：`packages/qgate/src/config.mjs:330/339/345` 三处 `{ rejectUnknown: false }`（`provider`/`policy`/`selection`/`grouping`）；schema 侧 `schemas/config.schema.json:7,55,113,130,152,162` 全为 `additionalProperties:false`，且 `schemas/README.md:104-106` 明文承诺"任何仍未声明的字段名在 provider / policySettings / selectionSettings / groupingSettings 中仍被拒绝"。
- 复现（逐对象注入 `"zzz_extra":1`）：`provider` → `ENGINE-ACCEPTS / SCHEMA-REJECTS`；`policy`、`selection`、`grouping` 同。顶层未声明键**会**被引擎拒绝（`config.mjs:313-319`）。
- 影响：`confidencThreshold`、`evidenceDirr`、`maxFilesPerGrup` 之类的拼写错误被静默忽略并以默认值继续跑 ⇒ "配置严格校验"在嵌套层不成立。
- 修复：`rejectUnknown: true` + 与 schema 同源的允许键集。

**H6 — 账本审计链在门禁时刻不可验伪（sha256 从不复算）**
- 证据：`packages/qgate/src/ledger.mjs:71` 只在**写入时**计算 `sha256File`；`packages/qgate/src/trace.mjs:77-282`（`judgeTraceMatrix`）不触碰 ledger 哈希；`packages/qgate/src/checks/*` 无任何 ledger 校验分支。
- 复现（在 `demo` 副本上）：把 `ledger-index.json` 中 `ledgers[0].sha256` 首字符由 `3` 改 `0` ⇒ `check` 仍 **exit 0**；把某账本文件里的 `"passed": true` 改成 `false` ⇒ 仍 **exit 0**。
- 冲突处：`docs/01-architecture.md:626`（"`ledgers[].sha256` 必须等于该账本文件真实 sha256"）、`docs/02-playbook.md:185`（卡片 5 把该一致性列为**退出条件**）。
- 修复：新增一条 check（或在 `trace_matrix`/`verify` 门禁内）对每个 `ledgers[]` 复算哈希并在不一致时产出 blocker。

**H7 — provider 的 findings 从未进入流水线；fixture 未命中在 CLI 层静默通过**
- 证据：`packages/qgate/src/core.mjs:95` 创建 provider，仅 `:252` 用 `providerDescriptor(provider)` 取描述；全仓库 `grep 'findings(' | classifyFindings` 显示消费者只有测试（`packages/qgate/test/acceptance.test.mjs:146-185`），`packages/qgate/src/checks/**` 无调用点。
- 复现：`{"provider":{"type":"scripted","script":"sp.mjs","fixture":"fx.json"}}`，其中 `fx.json` 只有一条 `fingerprint:"deadbeef…"` 的录制、任何请求都命不中 ⇒ `check` **exit 0**、`overall_passed=true`、`provider={"type":"scripted","degraded":false,"detail":"scripted:fx.json"}`；`fixture` 文件整个不存在时同样 exit 0（detail 变 `… (empty)`）。API 层可见 `{ok:false, matched:false, error:"PROVIDER_FAILED"}`，但无人消费。
- 影响：REQ-013（finding 分级）与 REQ-014（provider 可替换/确定性 fixture）只到"库函数 + 测试"层级，未接线到门禁；"provider fixture 未命中 ⇒ 确定性可解释失败"在 CLI 上不成立。

**H8 — trace 覆盖率是"配置自证"而非"测试证据"**
- 证据：`packages/qgate/src/contract.mjs:192-224`（`checkTestIds`：check.id → testId 的硬编码映射）＋ `packages/qgate/src/core.mjs:195`（`testId: checkTestIds[check.id] ?? null` 写进账本）＋ `packages/qgate/src/ledger.mjs:75-81`（`testIds` = 账本条目 testId 的并集）＋ `packages/qgate/src/trace.mjs:323`（`covered` = testIds 全部出现在 ledgerIndex.testIds）。
- 实测：`T-QG-007`、`T-QG-015` **在任何测试文件里都不出现**（全仓库 grep；`selection.test.mjs` 仅含 `T-QG-012`），但 `demo/mini-service/.qgate/evidence/ledger-index.json` 与 `verification/evidence/ledger-index.json` 的 `testIds` 都包含它们 ⇒ 两个需求被记为 `covered=true`。
- 影响：`enforce:"strict"` 的 trace 门禁无法发现"某个 testId 根本没有测试"，与 REQ-006 的"需求→测试"追证意图不符。
- 修复：在账本条目里区分"check 执行"与"testId 由测试套件真实执行"（例如让测试运行器把 `T-QG-*` 结果写进证据文件并由 check 读入），或明确把 `testIds` 降级命名为 check 映射并同步文档。

**H9 — 根 `package.json` 的脚本曾全部指向不存在的配置（评审窗口内已修，保留记录）**
- 02:41 证据：`package.json:15-22` 全部使用 `--config demo/mini-service/.qgate/config.json`；`Test-Path demo\mini-service\.qgate\config.json` ⇒ `False`；`node packages/qgate/bin/qgate.mjs check --config demo/mini-service/.qgate/config.json` ⇒ exit 2 `CONFIG_NOT_FOUND`。影响面：M5/M6 的"一键入口"与 t7 的集成前提（`npm run check|trace|report|verify`）当时全部不可用。（t18 记为 I1；我在 02:41 独立复现确认当时仍未修。）
- 02:43:53 `package.json` 被 owner 改写（sha256(16) `805252A713FCF8A5`）：脚本改为 `demo/qgate.config.json`，并新增 `test`/`test:contract`/`test:all`。02:45 复查 `check` 脚本 exit 0、5/5 门禁 passed ⇒ **resolved during review**。
- 遗留要求：新增的 `test` 脚本不再覆盖 `schema-contract.test.mjs`，见 **H11**。

**H10 — `qgate trace --json` 与 demo 的 trace-matrix 违反自己的冻结 schema**
- 证据：`schemas/trace-matrix.schema.json:7`（根 `additionalProperties:false`）、`:82` 起 `requirementId` pattern `^REQ-[A-Z0-9-]+-[0-9]{3}$`；实现 `packages/qgate/src/cli.mjs:422`（`{...document, violations: judge.violations}`）；demo 的 id 是 4 位（`demo/mini-service/.qgate/requirements-index.json:13` `REQ-DEMO-0001`，需求文档 `docs/00-requirements.md:51` 却规定"三位数字"）。
- 复现：`node verification-t9/tools/schema-eval.mjs` 之外的独立求值显示 `trace --json` 输出 `valid=false errorCount=7`：6 条 `requirementId [pattern]` + 1 条根级 `additionalProperties`（多出的 `violations`）；`demo/mini-service/.qgate/trace-matrix.json` 同样因 4 位 id 判 `valid=false`。
- 修复：统一 requirementId 位数（`\d{3}` 还是 `\d{3,4}`）到 §5.3.3/§5.1 schema/`config.mjs:39`，并把 `violations` 正式声明或移出该文档。

### medium

**H11 — 默认 `test` 脚本不再覆盖契约漂移套件（`npm test` 变绿 ≠ 全绿）**
- 证据：`package.json:14-16`（02:43:53 改版）——`test` 只列 `config-and-run-result`/`pipeline-and-checks`/`acceptance` 三个文件，`schema-contract.test.mjs` 被单独挪到 `test:contract`，`test:all` 才用引号 glob 覆盖全部。
- 复现：`node --test --experimental-test-isolation=none packages/qgate/test/config-and-run-result.test.mjs packages/qgate/test/pipeline-and-checks.test.mjs packages/qgate/test/acceptance.test.mjs` ⇒ `tests 39 / pass 39 / fail 0`（exit 0）；`node --test --experimental-test-isolation=none "packages/qgate/test/*.test.mjs"` ⇒ `tests 62 / pass 61 / fail 1`（exit 1）。
- 要求修复：修好 B5 的 drift 期望表让 `test:all` 转绿；若坚持拆分脚本，必须在 `README`/`docs/02-playbook.md` 明示"`npm test` 不覆盖契约套件"，禁止用绿色 `npm test` 作为契约冻结已闭合的证据。

**H12 — SAFE_001/SAFE_003 在文档默认 `scanRoots: null` 下必然误报，只能靠手工收窄扫描根才"通过"**
- 证据：`docs/01-architecture.md:354`（`scanRoots` 默认 `null`，`null` 或空数组表示**扫描整个仓库**）＋ `packages/qgate/src/policy.mjs:111-131`（`scanCandidates`：`scanRoots` 为 null 时 `walkFiles(repoRoot)` 全树扫描，仅跳过 `.git/node_modules/.qgate/coverage/dist/build/.cache`）。
- 复现（同一仓库、仅切换扫描根）：
  ```
  demo 的 scanRoots = ["packages/qgate/src","packages/qgate/bin","packages/qgate/gates","demo/mini-service"]
     => SAFE_001 violations=0 / SAFE_003 violations=0（扫描 42 个文件）
  scanRoots = null（文档默认）
     => SAFE_001 violations=61 / SAFE_003 violations=55（扫描 252 个文件）
  ```
- 命中的全是**契约文档自己的散文与样例**，例如 `docs/01-architecture.md` 的 SAFE_003 语义行里写着 `` `fetch(`、`net.`、`https.request` `` 就被自己判定为"网络调用面"；`docs/00-requirements.md` 写 `` 不出现 `secrets.` 引用 `` 被判为"vault reference"。`verification-t9/artifacts/*runresult*.json`、`packages/qgate/test/pipeline-and-checks.test.mjs` 同样命中。
- 结论：本仓库根 `qgate.config.json` 之所以只启用 `CONTRACT_001`/`SAFE_002`（实测 `check` 的 policy 检查清单为 `build-deterministic/no-bypass:CONTRACT_001`、`build-deterministic/no-secret-paths:SAFE_002`，**没有** SAFE_001/SAFE_003），而 demo 的 SAFE_001/SAFE_003 之所以全绿，是因为 `demo/qgate.config.json:12-17` 把扫描根手工收窄到 4 个子树、**刻意排除了 `docs/**` 与 `verification*/**`**。因此"无密钥读取/无网络面由代码强制"目前只在"注解式排除文档"的前提下成立。
- 本评审文件自身也是命中源（`verification/review.md` 在 `scanRoots=null` 下贡献 16 条 SAFE_001 + 10 条 SAFE_003 命中），这是如实披露：任何引用这些 token 的评审/文档都会触发。
- 要求修复：给 token 匹配加"仅源码/脚本扩展名（`.mjs/.js/.cjs/.ts/.json/.yaml/.yml/.sh/.ps1`）"与"排除 `.md`、`verification*/artifacts/**`"的口径，或把"文档与证据制品不参与 SAFE 扫描"写成契约的一部分并在 `scanRoots` 默认值上体现；在此之前不得声称启用默认扫描根即可强制这两条不变量。

**M1 — 冻结文档点名的适配层入口不存在/命令不可用**：`docs/01-architecture.md:947` 写 `bin/ocr-adapter.mjs`，真实入口是 `adapters/opencodereview/bin/ocr-preview.mjs`（`package.json.bin.ocr-preview`）；`docs/00-requirements.md:145` 的验证命令 `ocr-adapter.mjs select --root demo --preview --json` 在本实现中不存在 `select` 子命令与 `--preview` 开关（`bin/ocr-preview.mjs:33-55` 的参数表只有 `--diff/--root/--rule/…/--json/--md`）。

**M2 — 适配层敏感路径清单区分大小写**：`adapters/opencodereview/src/filters.mjs:106-116`（`base === '.env'`、`startsWith('id_rsa')`、`segs.includes('secrets')`、`matchesAnyPattern` 走大小写敏感的 `globToRegExp`，`util.mjs:37-80`）。实测同一批路径下 `credentials.json` 被排除而 **`Credentials.json` 被选中**；`secrets/db.txt` 排除而 **`Secrets/db.txt` 选中**，且 `safety.no_sensitive_selected=true`。引擎侧同源（`packages/qgate/src/selection.mjs:38-47`）。

**M3 — 别名路径可把密钥内容带进评审上下文**：`filters.mjs:160-177` 只按**路径名**判定。实测把 `.env` 做硬链接为 `docs.txt` 后（`stat.nlink=2`，内容逐字节等于 `.env`），`ocr-preview` 输出 `INCLUDED docs.txt`，`safety.no_sensitive_selected=true`，而该文件内容正是 `ANTHROPIC_API_KEY=sk-ant-…`。本机创建符号链接被系统拒绝（`Administrator privilege required`），故此处用硬链接复现；在允许符号链接的环境（或 Linux/git 的 mode 120000 对象）该路径是等价可用的绕过手段。要求修复：对已选文件做 realpath/inode 去重与"目标是否落在敏感清单"的二次判定。

**M4 — `QGATE_REPO_ROOT` 环境变量可让 SAFE_001/SAFE_003 空转**：`packages/qgate/src/policy.mjs:91-92`（`globalThis.process?.env?.QGATE_REPO_ROOT`，且 `globalThis.process?.env?` 写法连 SAFE_001 自己的 token 也匹配不到）。实测：同一配置（含 `process.env.ANTHROPIC_API_KEY` 与 `https.request`）在默认情况下 `exit 1`（safe3 检出 1 条违规）；把该变量指向一个空目录后 **exit 0**，`safe1/safe3 passed=true`、`filesScanned:0`。文档从未提及该变量，它是一条可静默改变安全判定面的暗门。要求修复：删除该旁路，或至少把"扫描根被环境变量改道/扫描 0 文件"变成显式 blocker 并写进契约。

**M5 — SAFE_003 检不出动态/别名网络面**：同 B3 的探针，`await import('node:https')`、`const f = fetch; f(url)`、`globalThis['fe'+'tch'](url)`、`axios.get(url)` 全部 **NOT-DETECTED**（`fetch(`、`http.get`、`net.`、`https.request` 可检）。§5.1:425 的 token 枚举与实现一致，但 §8.3:1021（"网络访问 禁止"）与 `docs/02-playbook.md:204`（"排除'悄悄联网重试'"）是超出实现能力的表述。

**M6 — demo 的 requirements-index 用了与冻结交接 id 冲突的 `humanGates[].gateId`**：`demo/mini-service/.qgate/requirements-index.json:7-9` 写 `req-spec`/`interface-frozen`/`review-counterexample`，而 §3.2 冻结的交接 id 是 `req-to-design`/`design-to-build`/`review-to-verify`（`packages/qgate/src/contract.mjs:13-38`）。引擎不消费该字段，故不影响判定，但审计时会产生两份互相矛盾的交接身份。

**M7 — 人类门禁只是"形如批准的 JSON 存在"**：`packages/qgate/src/human-gate.mjs:34-74` 只校验 `gateId/role/decision/approvedBy/approvedAt/claims` 形状；实测任意人写的 `approvedBy:"whoever"` 即 `exit 0`。`readApproval` 甚至不校验 §9.1 要求的 `schemaVersion`。文档 §8.2:1006 已如实说明"以 approval 制品存在性 + 角色匹配判定"，但 playbook 卡片 1 的"签字记录"措辞可能被读成更强的保证。

**M8 — 账本 `configPath` 在"配置在被检根之外"时退化为 basename**：`packages/qgate/src/core.mjs:29-34,106`。demo 实例的账本里 `configPath="qgate.config.json"`，而 §5.3.2:606 定义为"相对项目根"。低风险但会让审计者无法从账本定位真正使用的配置。

**M9 — BOM 容错缺失**：`packages/qgate/src/config.mjs:586,595-601` 直接 `JSON.parse` ⇒ 带 UTF-8 BOM 的配置报 `configuration file is not parseable JSON`（对外表现为 `CONFIG_INVALID`）而不是"文件含 BOM"；适配层同样（`adapters/opencodereview/src/selection.mjs:38-41`，本人在构造 diff 夹具时实测 exit 2）。playbook §8:717 已记账，此处独立复现确认仍在。

**M10 — 契约自描述的默认审批路径与 demo 实例不一致**：`packages/qgate/src/contract.mjs:20-36` 的 `approvalRecord` 为 `verification/approvals/<gateId>/approval.json`，而 demo 使用 `.qgate/approvals/**`（`demo/qgate.config.json:57,114,232`）。`qgate contract --json` 因此对外发布的默认路径在 demo 实例中不存在（属"默认值 vs 覆盖"的常见情形，但契约自描述未标注可覆盖）。

**M11 — t6 的落盘要求与 captain 冻结标记冲突**：`verification/.captain-freeze.json:26-30` 规定 t9 完成前只有 verifier 可写 `verification/**`（`:6-13` 还把 `verification/review.md` 列为 verifier 受保护路径），而 t6 任务文本要求把结论写到该文件。本文件即冲突产物，需 captain 明确裁决归属，避免后续清理时误删本评审结论。

### low

**L1** — `docs/01-architecture.md:333` 写"上述 5 项"却列了 7 个字段（t18 已记 I4，未修）。
**L2** — `packages/qgate/src/rules.mjs` 的 `BUILTIN_RULE_PATH='packages/qgate/gates/builtin-rule.json'` 指向不存在的文件，`qgate preview` 会把它当"规则层路径"输出（playbook §8:729 已记）。
**L3** — 根 `verification/reports/` 目录不存在，而 §7:953 把它写成引擎的 `reportDir` 落点（`report` 命令会按需创建，故仅为描述与现状的偏差）。
**L4** — §5.1:343 说 `provider.endpoint`"离线时降级"，实现只在 `type="llm"|"external"` 分支整体降级（`packages/qgate/src/provider.mjs:146-160`），未使用 `endpoint`；表述与实现粒度不一致。
**L5** — `docs/00-requirements.md:57` 的核对基准 `packages/qgate/gates/stage-order.json` 与 `:136` 的 `ok` 矩阵（见 H4）属同类"引用了不存在的物/不可满足的判据"，可随 B4/H4 一并整修。

### 评审通过项（须有证据的 pass）

| 项 | 证据 |
|---|---|
| 五阶段顺序与"只跑到该阶段（含）"语义 | `check --stage requirements/design/build/review` 逐条 exit 0；`--stage requirements` 输出 5 个门禁且顺序 = requirements→design→build→review→verify |
| 三处人类门禁硬阻断 | 删 `req-to-design/approval.json` ⇒ exit 1，blocker `HUMAN_GATE_NOT_APPROVED`、`approvalState=missing`；`decision=rejected` ⇒ exit 1 且 `state=rejected`；`role=architect` 冒充 ⇒ exit 1 且 `state=role_mismatch`；恢复后 exit 0 |
| 退出码矩阵 | `check` 0；`--stage requirements` 0；`preview --json --summary` 2（`CONFIG_INVALID`）；未知选项/未知命令 2；`--config` 不存在 2（`CONFIG_NOT_FOUND`）；`explain --gate nope` 3（`INTERNAL_ERROR`）；`provider.script` 缺失 3（`PROVIDER_FAILED`） |
| 非法配置 exit 2 且不产生 `run_id` | 缺 `version`、`check.type="file_exist"` 等均 exit 2 + `error.code=CONFIG_INVALID`（另见 `verification-t9/artifacts/negative-B*.json`） |
| ocr 缺失降级确定性 | `--use-ocr --ocr-bin C:\nope\ocr.exe` ⇒ exit 0、`degraded=true`、`degraded_reason=OCR_CLI_NOT_FOUND`、`llm_called=false`、`selected=14` |
| 零运行时依赖 | `packages/qgate/package.json` 无 `dependencies`/`devDependencies`（`adapters/…/package.json` 为空对象 `{}`；根 `package.json` 无 deps） |
| 实现无可执行网络调用面（独立 grep） | `packages/qgate/src/**` 与 `adapters/opencodereview/src|bin` 中 `node:http|node:https|node:net|node:dns|fetch(|XMLHttpRequest|WebSocket` 命中 **0** |
| 密钥路径先于 include（字面写法） | 最宽 `--include '**/*' --include '.env*' --include 'secrets/**' --include '*credentials*' --include '*.pem'` 下 `.env`、`.env.production`、`.env.mjs`、`id_rsa`、`credentials.json`、`secrets/db.txt`、`.opencodereview/secrets/db-password.txt`、`C:/Users/…/.aws/credentials` 全部 `excluded: sensitive_path_never_included`；路径穿越 `src/../../.env`、`src\..\..\.env.production`、`src/nested/../../../id_rsa` 归一化后同样被排除 |
| 四份 schema 元数据与可空写法 | 4 份均 draft 2020-12 且带 `$id`；`schemas/**` 中 `"type": [ … ]` 联合命中 **0**（t18 的 I2 已修复） |
| schema 正反判定 | `demo/qgate.config.json`、根 `qgate.config.json`、`_canonical-config.json` 均 `valid=true`；`check.type="file_exist"`、RunResult 删基线字段/加 `stdout`、4 位之外的非基线字段均 `valid=false` |
| demo 端到端 | `check --config demo/qgate.config.json --json` ⇒ exit 0、`overall_passed=true`、5/5 门禁 passed、`approvals_missing=0`、`provider.degraded=false` |
| `contract --check` | exit 0，`contract self-check: OK`，五阶段/三人类门禁/七 check/四退出码/六命令全部与内置记录一致 |
| verifier 报告的诚实性 | `verification-t9/review.md:8,23,56-63,98-102` 明确列出 1 项 blocked 断言、6 项 blocked、11 条不一致与三类方法局限；`report.json` 的 `assertions` 为 11 pass / 1 blocked；未发现"把未验证项写成 pass" |
| playbook 的自我披露 | `docs/02-playbook.md:616`（复核时刻转红）、`:687-698`（仅设计未实现）、`:714-729`（14 条缺口，含 `skipped/skipReason` schema 违规、`durationMs=0`、CI 人类门禁步骤不阻断、`builtin-rule.json` 不存在） |
| demo 的 fixture 标注 | `.qgate/evidence/ocr-findings.json:3,11,21,32` 显式 `"provider":"scripted"` 与 `"source":"scripted-fixture"`；playbook `:199,:203` 说明该台账是夹具语义；未发现把它表述为真实 LLM 调用（但该文件无生成器，见 H7） |

---

## 3. 逐项核查对照（任务 1–8）

| 任务项 | 判定 | 关键结论 |
|---|---|---|
| 1) 契约一致性（config/RunResult/evidence/trace/CLI/退出码 vs 实现） | **不符合** | B2、H1、H2、H3、H4、H5、H10、M1、M8、L1、L3、L4；退出码本身（0/1/2/3）逐条吻合 |
| 2) 声称 vs 事实（零依赖/离线/确定性/密钥不可再纳入/无网络面/无密钥读取） | **部分不符合** | 零依赖 ✅、源码无网络调用面 ✅（独立 grep 命中 0）、确定性（同 cwd）✅；"无密钥读取"由 B3 证伪；"密钥路径不可再纳入"由 M2/M3 证伪；"无网络面"由 M5 收窄；"SAFE_001/003 可强制"由 H12 收窄（文档默认扫描根下必然误报）；"跨 cwd 一致"由 H1/GAP-5 收窄 |
| 3) 安全不变量绕过尝试 | **已执行 6 类** | 大小写（M2 绕过成功）、别名路径（M3 绕过成功）、路径穿越（被挡住）、Windows 反斜杠（被挡住）、双扩展名 `.env.mjs`（被挡住）、目录名伪装 `secrets/` 与 `.opencodereview/secrets/`（被挡住）；符号链接因本机权限不可创建，已如实记为"未能以符号链接复现，用硬链接等价复现" |
| 4) 降级行为（ocr 缺失 / provider fixture 未命中 / 配置非法） | **2/3 通过** | ocr 缺失 ✅（exit 0 + 原因枚举）；配置非法 ✅（exit 2 + jsonPointer）；**provider fixture 未命中 = 静默通过**（H7） |
| 5) 需求覆盖（P0/P1 是否都有实现证据与 testId 落地） | **不符合** | B4（11 个点名测试文件 + 2 个强制制品缺失）、H8（T-QG-007/T-QG-015 无任何测试却判 covered）、H9 |
| 6) 指标与门禁卡自洽性（五张卡 / OCR 映射 / 指标定义） | **基本自洽，2 处不可执行** | 卡片/映射表/指标大量自我披露（含 4/9 条 OCR 手法标"未接线"）；但卡片 5 的退出条件"账本 sha256 一致"无任何 check 强制（H6），卡片 4 的"无未处置 blocker/high finding"无 provider 接线（H7）；指标 1/2/6/9 可算、3/4/5/7 已标未实现 ✅ |
| 7) 诚实性（fixture 是否被当成真实调用 / verifier 是否把未验证写成 pass） | **通过（有时间戳例外）** | demo 台账显式标 fixture；verifier 报告有 blocked 清单与方法局限；唯一例外是"套件全绿"结论在其采样时刻为真、在当前 HEAD 已为假（B5），playbook §6.12 已自行更正 |
| 8) schemas 与 §5 字段表双向一致 | **不符合（3 处）** | H10（trace `violations` 多余键 + requirementId 位数）、B5（`config:humanGate` 期望表缺 `gateId`）、H5（引擎不拒绝嵌套未知键）；正向：四份 schema 的实体键集与 §5.1/§5.2/§5.3 字段表逐项一致（`packages/qgate/test/schema-contract.test.mjs:764-795` 的 29 个实体），枚举同步（七 check / 五 stage / 四 provider / 五 evidence.kind / 四 severity） |

---

## 4. 实际执行过的命令（均可复现，cwd=`E:\Desktop\ai-quality-gate` 除非注明）

```powershell
# 套件（B5）
node --test packages/qgate/test/                                   # exit 1（EPERM spawn，沙箱）
node --test --experimental-test-isolation=none packages/qgate/test/config-and-run-result.test.mjs packages/qgate/test/pipeline-and-checks.test.mjs packages/qgate/test/acceptance.test.mjs packages/qgate/test/schema-contract.test.mjs
node adapters/opencodereview/tools/run-tests.mjs

# 引擎行为（B1/B2/H2/H3/H4/H6/H7/H9/H10）
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --summary
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --stage requirements --json
node packages/qgate/bin/qgate.mjs preview --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs trace --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs report --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs explain --gate build-deterministic --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs explain --requirement REQ-QUALITY-GATE-001 --config demo/qgate.config.json --json
node packages/qgate/bin/qgate.mjs contract --check
node packages/qgate/bin/qgate.mjs check --config demo/mini-service/.qgate/config.json --json        # H9 => exit 2
cd packages\qgate; node bin\qgate.mjs check --config demo/qgate.config.json --json                 # H1 => exit 2
node --input-type=module -e "…validate(schemas/run-result.schema.json, <--stage 输出>)…"           # B2 => valid=false
node --input-type=module -e "…validate(schemas/config.schema.json, <demo 配置 + provider/policy/selection/grouping 各注一个未知键>)…"  # H5
node --input-type=module -e "…validate(schemas/trace-matrix.schema.json, <trace --json 输出>)…"    # H10 => valid=false, 7 errors

# 反向 / 篡改 / 降级（B1/H6/H7/M9）
#   自建最小配置（required + 默认 severity 的 regex 失败）=> exit 0      # B1
#   demo 副本：改 ledger-index.json 的 sha256 / 改账本条目 passed => exit 0  # H6
#   scripted provider：fixture 无命中 / fixture 文件不存在 => exit 0        # H7
#   scripted provider：script 缺失 => exit 3 PROVIDER_FAILED               # 通过项
#   配置带 UTF-8 BOM => exit 2 CONFIG_INVALID（"not parseable JSON"）       # M9

# 安全不变量（B3/M2/M3/M4/M5）
node <附录 A 的 probe-policy.mjs>                                      # SAFE_001/SAFE_003 逐样本探针
node adapters/opencodereview/bin/ocr-preview.mjs --diff <scratch>\diff.json --root <scratch> --json --quiet
node adapters/opencodereview/bin/ocr-preview.mjs --diff <scratch>\diff.json --root <scratch> --include '**/*' --include '.env*' --include 'secrets/**' --include '*credentials*' --include '*.pem' --json --quiet
node adapters/opencodereview/bin/ocr-preview.mjs --root <scratch> --json --quiet                    # 含 .env / secrets/ / .opencodereview/secrets/ 的真实树
node adapters/opencodereview/bin/ocr-preview.mjs --diff adapters/opencodereview/demo/diff.json --rule adapters/opencodereview/demo/rule.json --use-ocr --ocr-bin 'C:\nope\ocr.exe' --json --quiet
$env:QGATE_REPO_ROOT='<空目录>'; node packages/qgate/bin/qgate.mjs check --config <含密钥读取的配置> --json   # M4 => exit 0
New-Item -ItemType HardLink -Path <scratch>\docs.txt -Target <scratch>\.env                          # M3（符号链接被系统拒绝：Administrator privilege required）
New-Item -ItemType SymbolicLink -Path <scratch>\notes.txt -Target <scratch>\.env                     # 失败留证

# 文档一致性（B4/M1）
Test-Path packages/qgate/test/checks.test.mjs, …（11 个测试文件命中 MISSING）
Select-String -Path schemas\*.schema.json -Pattern '"type": \[|"oneOf"'
Select-String -Path packages\qgate\src\*.mjs,packages\qgate\src\**\*.mjs,adapters\opencodereview\src\*.mjs -Pattern "node:http|node:https|node:net|fetch\(|XMLHttpRequest"
Select-String -Path packages\qgate\src\*.mjs,adapters\opencodereview\src\*.mjs -Pattern "process\.env"
```

---

## 5. 方法局限与"could not confirm"

1. **无法以符号链接复现 M3**：本机创建 symlink 被拒（`Administrator privilege required`），只能用硬链接（同 inode、内容逐字节相同）证明"别名路径可绕过名称清单"。Linux/CI 上的 symlink 等价路径**未实测**（`could not confirm`，但机制同源）。
2. **GitHub Actions 真实执行未验证**：无 runner/无网络，只做静态检查（job 数、`uses` SHA、`permissions`、`secrets.` 命中 0）与本地等价命令复现（playbook §6.13 实测退出码与我抽查一致）。CI 的 artifact 上传、`|| true` 预热步骤的语义**未在真实 runner 上确认**。
3. **schema 求值用仓库自带的零依赖子集求值器**（`packages/qgate/test/helpers/json-schema.mjs`），未与 `ajv` 等完整实现交叉验证；我引用它的判定时一律写成"按该求值器求值"。
4. **`verification-t9/**` 的 12 条断言我未整体复跑**，只抽查了与套件结果、schema 求值、字段面相关的部分；其"pass 11/blocked 1"的时点性我按报告自身的 `generated_at`（2026-09-18T02:37:17+08:00）理解，不对其逐条背书。
5. **未评估**：`adapters/opencodereview/src/{grouping,ocr-pipeline,ocr-runner,reflection,rules}.mjs` 的逐行实现正确性（只按任务 1–8 的范围取证）；`packages/qgate/src/{report,trace,evidence}.mjs` 的渲染细节同理只在被引用处取证。
6. **评审用的临时目录已删除**：所有绕过/篡改实验都在 `E:\Desktop\review-scratch\`（项目根之外）进行，评审结束已整目录删除（其中含演示用的假密钥字符串与 demo 副本，不留在工作区）。B3 的探针脚本源码见附录 A，可直接落盘复跑，不依赖任何临时目录。

---

## 附录 A — B3/M5 的探针脚本（直接拷出即可复跑）

```javascript
// usage: node probe-policy.mjs   (cwd 任意；只读引用被评审的引擎)
import fs from 'node:fs';
import path from 'node:path';
import { policySafe001, policySafe003 } from 'file:///E:/Desktop/ai-quality-gate/packages/qgate/src/policy.mjs';

const dir = path.join(process.cwd(), 'probe-tree');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const keyCases = [
  ['dot-upper-underscore', 'const k = process.env.ANTHROPIC_API_KEY;'],
  ['dot-upper-exact', 'const k = process.env.ANTHROPIC;'],
  ['bracket-upper', "const k = process.env['ANTHROPIC_API_KEY'];"],
  ['dot-openai', 'const k = process.env.OPENAI_API_KEY;'],
  ['comment-apiKey', '// apiKey is read here'],
  ['dot-path-benign', 'const k = process.env.PATH;'],
  ['dot-TOKEN', 'const t = process.env.TOKEN;'],
  ['dot-TOKEN_SUFFIX', 'const t = process.env.TOKEN_SECRET;'],
  ['vault-dot', "const c = secrets.get('x');"],
  ['apikey-lower', 'const v = apikey;'],
  ['literal-APIKEY', 'const v = APIKEY;'],
  ['string-literal-name', 'const name = "ANTHROPIC_API_KEY";'],
];
const netCases = [
  ['fetch-call', 'const r = await fetch(url);'],
  ['https-request', 'const r = https.request(opts);'],
  ['http-get', 'const r = http.get(url);'],
  ['net-connect', 'const s = net.connect(80);'],
  ['dynamic-import-https', "const m = await import('node:https');"],
  ['fetch-alias', 'const f = fetch;\nconst r = await f(url);'],
  ['globalThis-bracket', "const r = await globalThis['fe' + 'tch'](url);"],
  ['axios', 'const r = await axios.get(url);'],
];

function probe(label, body, fn) {
  fs.writeFileSync(path.join(dir, 'sample.mjs'), body + '\n', 'utf8');
  const out = fn(dir);
  console.log(`${out.passed ? 'NOT-DETECTED' : 'DETECTED    '}  ${label.padEnd(24)} ${JSON.stringify(body).slice(0, 46)}`);
}

console.log('--- SAFE_001 (claims: no API-key reads) ---');
for (const [l, b] of keyCases) probe(l, b, (d) => policySafe001(d));
console.log('--- SAFE_003 (claims: no network call surface) ---');
for (const [l, b] of netCases) probe(l, b, (d) => policySafe003(d));
fs.rmSync(dir, { recursive: true, force: true });
```

