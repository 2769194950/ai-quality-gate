# verification-t9/report-v3 — t40 摘要（人类可读）

`generated_at` 2026-09-18T03:52+08:00 ｜ `tree_fingerprint` **16bf3d65f8b099880ab36540a59641ee017fed4187b9b60971ad8bf16a5f5095**（149 文件，newest `packages/qgate/src/cli.mjs` 03:42:24；03:44 与 03:50 两次读取一致）
`supersedes` verification-t9/report.json（t18 历史，保留不改）｜ `supersedes_blocked` t24｜ cwd `E:\Desktop\ai-quality-gate`

## 结论

**pass 27 / fail 1 / blocked 1（共 29 项 = 23 项 + A1–A6）**
**放行建议：不推荐无条件放行** —— 存在 1 条 blocker 级安全绕过与 1 条 high；其余核心门禁、确定性、schema、CI/scripts、以及 t26/t28/t34/t37/t39 的修复均可复现。

| 断言 | 结论 | 关键实测 |
|---|---|---|
| 1 | pass | demo `check --json` exit 0、overall_passed=true、5/5 gate；RunResult schema valid=true |
| 2 | pass | `--summary` 人类表格 5 行，全 passed、blockers 0 |
| 3 | pass | 两次运行规范化哈希 `52315a63…6693` 一致；239 叶子仅 4 个运行时叶子不同 |
| 4 | pass | ① 固定 cwd 一致；② 相对 `--config` 跨 cwd 有 9 个**绝对路径回显**叶子；固定绝对 config 后归零（见 18）；③ 无 Key 变量、无 node_modules、零依赖 |
| 5 | pass | 删必需证据文件 ⇒ **exit 1** + 精确 `FILE_MISSING: .qgate/evidence/test-results.json`；对照 exit 0 |
| 6 | pass | 缺 version / 非法 check.type / 配置不存在 ⇒ **exit 2**（CONFIG_INVALID ×2、CONFIG_NOT_FOUND） |
| 7 | pass | 默认/恶意规则/`--include` 三态 included=14、泄漏 0；含大小写变体规则仍 0 |
| 8 | pass | trace 6/6 covered、summary 自洽、schema valid=true |
| 9 | pass | 字段面 mismatch **0**（29 schema 层级 + 真实 RunResult + 3 配置）；humanGate 的 `gateId` 是我 t18 的转写遗漏，已按 §5.1 L416 修正 |
| 10 | blocked | 5 项无法验证（GH Actions 真跑、干净 clone 全流程、12 配置基线 diff、approval.json 无 schema、字面量 `node --test`） |
| 11 | pass | 4 份 schema 2020-12；demo/`_canonical-config`/`five-stage` valid=true；`file_exist` valid=false（errors=2） |
| 12 | pass | 引擎 cli=0/builtin=3 vs 适配层 cli=1 ⇒ `engine = adapter − 1`；同树同层 14/14 delta=1 |
| 13 | pass | 四阶段 RunResult **valid=true ×4**；未运行 gate 缺席（不记 false/true） |
| 14 | pass | `npm test` 104/104、`test:all` 104/104（一致）、`test:contract` 24/24、适配层 **87/87** |
| 15 | pass | `check → preview → preview` 的 `selection.included` 哈希一致，fullPayloadEqual=true |
| 16 | pass | BOM 合法 ⇒ exit 0；BOM+截断 ⇒ exit 2 CONFIG_INVALID |
| 17 | pass | 三 cwd 套件全 87/87；四 cwd（含 `C:\`）stdout 哈希全为 `D04B3832…C15B8`，路径键差异 **0** |
| 18 | pass | 固定绝对 `--config`、只变 cwd ⇒ normalized-equal=true（仅运行时叶子）|
| 19 | pass | stage job 全 0；verify 三段式：预热 **exit 1**（预期）→ `trace --write` 0 → 权威 **exit 0** |
| 20 | pass | 11 个根脚本 exit 全 0 |
| 21 | **fail** | 通过项：required+默认 severity ⇒ exit 1；SAFE_001 三种 env 写法检出；注释示例不报违规、字面量仍检出；`expectedFiles` 反向纳入 `.md`；空扫 ⇒ failed；账本篡改四式 ⇒ exit 3 EVIDENCE_UNRESOLVED；scripted provider 缺模块 ⇒ PROVIDER_FAILED；`QGATE_REPO_ROOT` 惰性；大小写变体被排除；`metrics.scanSurface` 进入证据（candidates=139/scanned=96）。**失败项：① 硬链接别名绕过 3/3；② provider.fixture 不存在时静默回退** |
| 22 | pass | 根配置 exit 0 且索引 `covered=false` 计数 **0**（未被绕过）；两类自证见 A3 |
| 23 | pass | T-QG-007 → `evidence-resolution.test.mjs` L57/75/103/148/174/197/221（33 条 assert）；T-QG-015 → `ci-template.test.mjs` L240/258/275/291（22 条 assert） |
| A1 | pass | `--summary --out` **包络**含 `not_run_gates:[{id,stage,reason}]`（四阶段递减，与人类行逐字一致）；`--json` 恰 8 键且不含该字段 |
| A2 | pass | R1 ⇒ **TRACE_GAP** fail-closed；对照 A 齐全 ⇒ 0；对照 B `trace-only` ⇒ 0 且带机器可读标记 |
| A3 | pass | ① 结构性自证仍在（14 个映射 id、6/6 covered，无根侧测试）② 实现性缺口已由 t39 修 |
| A4 | pass | 历史存在时删掉承载 `T-QG-003` 的 `req-index-valid` ⇒ **exit 1**，blocker 指名该 check 与 `T-QG-003` |
| A5 | pass | provider/policy/selection/grouping 各加未知键 ⇒ **exit 2 CONFIG_INVALID**；demo/根仍 0 |
| A6 | pass | 注释不报/代码报/字面量报；`gates/README.md` L23 + L61-L79 并列记账并写明扩展假阴性面 |

## 三个 cwd 的实测计数（断言 14/17）

| cwd | 适配层 `tools/run-tests.mjs` | `ocr-preview --json`（绝对输入，仅 stdout） |
|---|---|---|
| `E:\Desktop\ai-quality-gate`（规范） | 87 / 87 / 0，exit 0 | sha256 `D04B3832…C15B8` |
| `E:\ai-quality-gate`（junction） | 87 / 87 / 0，exit 0 | 同上 |
| `E:\Desktop` | 87 / 87 / 0，exit 0 | 同上 |
| `C:\` | 未跑套件 | 同上（路径键差异 0） |

（t18 时 junction cwd 为 54/57 —— GAP-5/GAP-6 已修。）

## 根 scripts 逐条退出码（断言 20）

`test 0`、`test:all 0`、`test:contract 0`、`check 0`、`check:json 0`、`check:summary 0`、`contract 0`、`trace 0`、`preview 0`、`report 0`、`verify 0`（11/11）。

## findings

| id | 级别 | 一句话 |
|---|---|---|
| F1 | **blocker** | 硬链接别名绕过仍成立：`docs.txt`→`.env`、`notes.txt`→`.env`（密钥形态内容）、`handbook.txt`→`Credentials.json` 三种变体全部进入 `selection.included`（`detectHardlinkSecret` 的身份链在 `--diff` 路径未生效） |
| F2 | high | `provider.fixture` 指向不存在文件 ⇒ 静默回退内置 fixture、exit 0、degraded=false |
| F3 | low | `packages/qgate/examples/scratch.config.json` 遗留 |
| F4 | low | 相对 `--config` 跨 cwd 会回显 9 个绝对路径叶子；字节比对前应固定 `--config` 拼写 |
| F5 | medium | 「12 个配置逐行 diff = IDENTICAL」无基线可复核（无 git），只能标 blocked |
| F6 | info | 方法学：`--summary` 人类 stdout ≠ `--summary --out` 包络（A1 的误判来源，留档） |

## 事故

- **INC-1**（02:32:06）：`verification/**` 被清空，t9 产物全失；结构性成因=引擎默认 evidenceDir 落在 `verification/**`。`counted_as_delivery_failure=false`。
- **INC-2**（03:22–03:44）：t24 两次冻结等待 → 终态 failed 无法 re-claim → captain 新建 t40。性质为冻结等待，非验证失败。

## 复核入口

```powershell
Set-Location E:\Desktop\ai-quality-gate
node -e "const r=require('./verification-t9/report-v3.json');if(!r.assertions||r.assertions.length<12)process.exit(1)"
node verification-t9/tools/v3-cases.mjs --json        # 负例/安全/篡改/H8/R1/provider 33 例
node verification-t9/tools/hardlink-probe.mjs         # F1 复现（exit 1，三变体全泄漏）
node verification-t9/tools/tree-fingerprint.mjs       # 修订指纹（应为 16bf3d65…）
```

**取证纪律留档**：本轮共 11 个指纹，其中 `f51bca35… → 06096768…`（17 秒内）与 `e948c917… → ba575fef…`（25 秒内）两次变化直接证明「树未冻结」，是本项目「不在变动树上出报告」这条纪律的最好证据。
