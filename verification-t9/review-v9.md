# t66 复核报告（人读版）—— verifier / attempt 261b7f74

- 冻结修订：**92d56be67c93d24f942c07ad9ac2f797d5aa0eb306e25057c4c774ec748f0c22**（153 文件；两次采样一致，间隔 ~6s；`newest = packages/qgate/gates/README.md 11:25:53`）
- 结论：**62 pass / 0 fail / 1 blocked（共 63 条）**，产出 `verification-t9/report-v9.json`（supersedes report-v8.json）
- **根门禁已由红转绿**：`exit 0 / overall_passed=true / 5 of 5 / failingChecks=[]`
- 开工前提：t63/t64 均终态；t65（根 README）在窗口内落笔，但**根 `README.md` 不在指纹 scope 内** ⇒ 修订未移动、指针保持 FRESH（见 A02）

## Z1 重录过期指针（本轮解锁动作）

| | `tree_fingerprint` | files | expected | `content_sha256` | 文件 sha256 |
|---|---|---|---|---|---|
| before（t60 录制） | `74a28c906b73…` | 152 | `testFiles=14;tests=131;pass=131;fail=0;exit_code=0` | `8f01b6d6…` | `FB4B68F7…` |
| **after（本轮，cwd=仓库根）** | **`92d56be6…`** | **153** | **`testFiles=15;tests=145;pass=145;fail=0;exit_code=0`** | **`63d4c5ba…`** | **`415E9095…`** |

仍用 X1 的 `pointer+hash v1` 格式（`record_command` / `record_cwd` / `tree_fingerprint` / `content_sha256` / `argv_json` / `freshness_rule`），**只保留一份权威指针**（就地更新，避免两个 RECORDED）。

## Z2 根门禁转绿 + 同修订稳定

- run1：**exit 0 / overall_passed=true / 5 of 5 / failingChecks=[]**
- run2（其间在 `verification-t9/**` **新建文件**）：exit 0
- 规范化（删 `run_id/started_at/finished_at/duration_ms`）后两次**同哈希 `de593001…d29`**，`normalized-equal=true`

## Z3 F19 独立复验（四条对照）

| 对照 | 实测 |
|---|---|
| 新建文件 ⇒ 扫描面不变 | `check.selected` 与 `preview.included` 前后**均 143**、auditTree 0、`secretPathsExcluded` 17 |
| `preview` 不含审计树 | `included=143`，其中 `verification/**`=**0**、`.qgate/**`=**0**，`secretPathsSelected=0` |
| SAFE_002 未回退 | `passed=true`、`secretPathsExcluded=17`、`violations=0`；回退实验里 **17→17 不变** |
| **两路径同一张表**（行为验证） | 副本内仅删 `DEFAULT_EXCLUDED_PATHS` 的 `'verification'`+`'verification-t9'` 两项 ⇒ `check.selected` **143→819**、`preview.included` **143→819**、`preview.auditTree` **0→676**：**两条路径同时同量变化** |

（精确边界：verifier 写入会让**排除侧**计数增长 —— `default_excluded_path` 710→751 —— 但该数字不出现在 RunResult 的 SAFE_002 证据串里，所以 Z2 的哈希一致不受影响。）

## Z4 R5 门禁矩阵（副本内 7 场景，每场景跑完整根 check）

| 场景 | 退出码 | 唯一失败 check |
|---|---|---|
| A 旧修订指针 | **1 红** | `verify-coverage:baseline-freshness`（`exitCode=1 expected=0`） |
| B 重录 | **0 绿** | — |
| C 范围内写文件 | **1 红** | baseline-freshness |
| D 再重录（**恢复这一半是 verifier 的动作**） | **0 绿** | — |
| E 工具被删 | **1 红** | baseline-freshness（fail-closed） |
| **F 只删权威指针（5 个 SUPERSEDED 仍在）** | **1 红（exitCode=3）** | baseline-freshness —— **修之前这里是绿灯**（F21） |
| G 完全无指针 | **1 红（exitCode=3）** | baseline-freshness |

## Z5 全量回归（无回退）

引擎 `110/110/0`、`test:all 110/110/0`（≡）、`test:contract 25/25/0`；demo exit 0 5/5；**根 exit 0**；根 scripts **11/11**；适配层三 cwd **15 文件/145 用例/145 pass/0 fail**；`ocr-preview --json` 四 cwd（含 `C:\`）同哈希 **F445867E…A03F77**；`--stage` 四阶段 valid + RunResult 无 `not_run_gates` + 包络含（4/3/2/1）；trace 6/6 + `allChecksPass=true`；断言 12 **ALIGNED/exit 0**（9/9 键集）；BOM 2 例、未知键 **4×exit 2**、账本篡改 **4×exit 3**、空扫 failed；demo 输入树前后同哈希 `c5218675…`；CI 三段式：`0×5 → 预热 1（TRACE_GAP）→ trace 0 → 权威 0`。

## 本轮新发现

| id | 严重度 | owner | 内容 |
|---|---|---|---|
| **F20** | low | adapter-engineer | **复制路径的假失败已复现并定位**（GAP-6 同族）：`selection.test.mjs` L448-457 要求 `diff.json` 的**每个**路径在夹具根下存在，而夹具声明了 `node_modules/left-pad/index.js` ⇒ 任何"排除 node_modules"的干净复制都会 **1 fail / exit 1**（145 例中 144 通过）。整树如实复制则 145/145 通过 ⇒ 条件性缺陷，不是产品缺陷 |
| **F21** | low-medium | verifier（已修） | R5 的 fail-closed 有洞：**只删权威指针、保留 5 个 SUPERSEDED 副本**时 `fresh=0 superseded=5` 且 **exit 0** —— 被解除武装的门禁读成绿色。已改为「必须存在至少一个非 SUPERSEDED 指针」（`NO-AUTHORITATIVE-POINTER` exit 3），real repo 仍绿、副本 F 场景转红 exitCode=3 |

**已闭环**：F12（w45 词表同判）、F13（六项子检查全 true）、F14/F15/F16（Y1 60 格：6 格 adapter 更松 ⇒ **本轮全变两侧都报**，我把期望**重新基**为「两侧都报」，将来回退会直接 FAIL）、F19（Z3）、R5（Z4）。F17 **部分闭环**（t64 修好 ADS 族，名规则漏判 5→3）；F11 仍标「转述、未独立复测」。

## 残余项

R1 F20 夹具可移植性(adapter, low)｜R2 F17 残差：`.env `/` .env` 仅靠扩展名白名单兜底 + 8.3 别名本环境不可判定(adapter, low)｜R3 对称缺口 `fetch\n(url)` 两侧都漏(adapter+core, low)｜R4 决定根入口 `README.md` 是否应进入被测面(core, low)｜R5 F10 audit-boundary 交叉引用(architect, info)｜R6 纪律：owner 修好某个「已登记分歧」后，verifier 工具期望必须在同一轮重新基（本轮 Y1 已做）

## 放行建议

**可放行（release-ready）**：无 blocker/high；根门禁红↔绿两个方向均在自建场景中证明；F19/F15/F16 独立确认闭合；残余三条 low 且已证明不影响门禁判定。

## 复现入口

```powershell
Set-Location E:\Desktop\ai-quality-gate
node packages/qgate/bin/qgate.mjs check --config qgate.config.json      # 根门禁：exit 0
node verification-t9/tools/baseline-freshness.mjs --deep                # 一行新鲜度：fresh=1
node verification-t9/tools/z3-f19-scan-surface.mjs                      # Z3：selected=143 / auditTree=0
node verification-t9/tools/z3-revert-experiment.mjs --mirror-audit --copy E:\Desktop\_z3   # Z3④：143→819 两路径同步
node verification-t9/tools/z4-gate-matrix.mjs --copy E:\Desktop\_z4     # Z4：7 场景红/绿矩阵
node verification-t9/tools/y1-named-client-parity.mjs                   # Y1：60/60，exit 0
node verification-t9/tools/tree-fingerprint.mjs                         # 应为 92d56be6…
node verification-t9/check-report-v9.mjs                                # 报告自身 19 项验收自检
```
