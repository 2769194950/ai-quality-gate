# t68 复核报告（人读版，最终轮）—— verifier / attempt 80c894f5

- 冻结修订：**efbe6e05344ad9c37616729eb3049c3f43e8556af3be27c78d844a1794efb44d**（153 文件；四次采样一致；`newest = adapters/opencodereview/test/selection.test.mjs 11:57:11`）
- 结论：**67 pass / 0 fail / 1 blocked（共 68 条）**，产出 `verification-t9/report-v10.json`（supersedes report-v9.json）
- **根门禁由红转绿**：`exit 0 / overall_passed=true / 5 of 5 / failingChecks=[]`
- 开工前提：t67 终态；开工时指针按设计 STALE（`stale=1`），重录后 FRESH

## W1 最后一次重录（仓库根 live-run）

| | `tree_fingerprint` | files | expected | `content_sha256` | 文件 sha256 |
|---|---|---|---|---|---|
| before（t66/Z1） | `92d56be6…` | 153 | `testFiles=15;tests=145;pass=145;fail=0;exit_code=0` | `63d4c5ba…` | `415E9095…` |
| **after（本轮）** | **`efbe6e05…`** | **153** | **同左（计数未变：t67 修的是测试）** | **`e4907820…`** | **`57E765F0…`** |

- 我先自己跑了一遍 record_command：`共 15 个测试文件 / tests 145 / pass 145 / fail 0 / exit 0`（未照抄 t67）。
- `evidence-pointer check --deep`：**FRESH，payload_sha256_ok=true，counts expected == actual，exit 0**（无 COUNT-DRIFT）；聚合器 `fresh=1 superseded=5 stale=0 tampered=0 count_drift=0 authoritative_pointers=1`。
- **F21 加固仍在**：`baseline-freshness.mjs` L68 `NO-AUTHORITATIVE-POINTER … exit 3`、L76 `authoritative_pointers`。仍只有一份权威指针。

## W2 根门禁 + 同修订稳定

- run1：**exit 0 / overall_passed=true / 5 of 5 / failingChecks=[]**；其间在 `verification-t9/**` 新建文件后 run2 仍 exit 0
- 两次规范化同哈希 **`764a0b8a437b3b4640b20bb84337e27807a0e9b682c70d870fffc52c0cb1abab`**

## W3 t67 独立复验（本轮重点）

**矩阵 8/8 全绿**（每格 `exit=0 / 15 files / 145 tests / pass=145 / fail=0`）：

| # | 单元 | cwd |
|---|---|---|
| 1 | 仓库根 | 仓库根 |
| 2 | 仓库根 | `C:\` |
| 3 | 仓库根 | `demo/mini-service` |
| 4 | **副本（排除 node_modules）** | 副本 |
| 5 | 副本 | `demo/mini-service` |
| 6 | 副本 | `C:\` |
| 7 | 副本 | `E:\Desktop` |
| 8 | **深层嵌套副本**（无 node_modules） | 副本 |

**四个反例仍会失败（证明断言被加强、未被放松）**——全部在仓库外的副本里做：

| 反例 | 结果 | 首个失败断言 |
|---|---|---|
| **C1** 未物化且规则无法解释（`src/ghost-module.mjs`） | exit 1 | `未物化的夹具路径必须能由本层规则解释（默认排除目录/二进制/不支持扩展名）: src/ghost-module.mjs` |
| **C2** 4 条**规则可解释**的未物化路径 | exit 1 | `夹具必须基本物化：实际 22/27` |
| **C3** 物化但把 `node_modules` 移出默认排除目录 | exit 1 | `node_modules/left-pad/index.js 已物化时**必须被排除**（默认排除目录/二进制），不得进入 selected` |
| **C4** 把 `grouping-rules` 的隔离 root/homeDir 回退成 `process.cwd()` | 从副本根 **145/0（被录制路径隐藏）**；从 `demo/mini-service` **144/1** | 失败用例恰为 `规则: 内置层永远存在且不含 include` |

⇒ t67 的两处修法都是**载荷性的**；「未物化」只被容忍到「规则能解释它」的程度，分母与归宿断言都在。

## W4 假失败已消失（F20 闭合）

非录制路径副本 `E:\Desktop\t68-w4`（1027 文件，node_modules 已排除）：

- record_command 从 `cwd=<copy>` ⇒ 15 files / 145 tests / 145 pass / **0 fail**；从 `cwd=C:\` ⇒ 同样
- 副本内 `baseline-freshness --deep` ⇒ **exit 0**、`fresh=1 superseded=5 stale=0 tampered=0 count_drift=0`
- **副本内根 `check --config qgate.config.json` ⇒ exit 0 / overall_passed=true / 5/5 / failingChecks=[]**

## W5 全量回归（无回退）

引擎 `110/110/0` ≡ `test:all 110/110/0`、`test:contract 25/25/0`；demo exit 0 5/5；根 exit 0；根 scripts **11/11**；四 cwd preview 同哈希 **F445867E…A03F77**（与 v9 相同）；`--stage` 四阶段 valid + RunResult 无 `not_run_gates` + 包络含（4/3/2/1）；trace 6/6 + `allChecksPass=true`；断言 12 **ALIGNED/exit 0**；schema 4/4 valid；BOM、未知键 **4×exit 2**、账本篡改 **4×exit 3**、空扫 failed；demo 输入树同哈希；CI 三段式 `0×5 → 预热 1（TRACE_GAP）→ trace 0 → 权威 0`；19 个工具全 exit 0（y1 60/60、y2 六项、y5 0 broken、z3 五项、v3-cases 31 true + 2 信息态）。

**根 `README.md` 显式核对**：sha256 `DD57637F55B1DA50EBFAD93FE0CA6100575E69272FE5654C77E797A946AEC538`（27900 B）= 任务书给出的 `dd57637f…`，**未被改动**（它在指纹 scope 之外，这是唯一能发现"被悄悄改过"的方式）。`verification/` 顶层条目不变。

## 状态优先级独立确认（附带）

指针负例：n1 STALE 1 / n2 TAMPERED 2 / n3 STALE 1 / n4 UNPARSABLE 3 / n5 STALE 1 / **n6 COUNT-DRIFT 1**。n5 记录在旧修订 ⇒ 报 STALE；**n6 记录在**当前**指纹下、只改期望计数 ⇒ 报 COUNT-DRIFT** —— 独立确认 **TAMPERED > SUPERSEDED > STALE > COUNT-DRIFT** 的优先级属实（COUNT-DRIFT 只在指纹已匹配时评估）。

## 本轮新增工具

`verification-t9/tools/w3-path-cwd-matrix.mjs`：一条命令跑完 8 格路径×cwd 矩阵 + 4 个反例 + 1 个隐藏性对照（文档里 `exit 0` 表示"矩阵全绿且反例全部如预期失败"）。

## 残余项（带 owner，均为 low/info）

R1 F17 残差：`.env `/` .env` 仍只靠扩展名白名单兜底 + 8.3 别名本环境不可判定(adapter)｜R2 对称缺口 `fetch\n(url)` 两侧都漏(adapter+core)｜R3 根 `README.md` 在指纹 scope 之外，是否纳入被测面(core)｜R4 F10 audit-boundary 交叉引用(architect, info)｜R5 纪律：owner 修好「已登记分歧」后 verifier 期望须同轮重新基(verifier, info)

## 放行建议

**可放行（release-ready）—— 最终交付确认**：无 blocker/high；根门禁红↔绿两向均在真实仓库走通；t67 的两处缺陷独立复现并确认修复、且断言被证明是**加强**而非放松；干净副本（非录制路径）上整条门禁为绿；残余项全部 low/info 且带 owner。

## 复现入口

```powershell
Set-Location E:\Desktop\ai-quality-gate
node packages/qgate/bin/qgate.mjs check --config qgate.config.json        # 根门禁：exit 0 / 5 of 5
node verification-t9/tools/evidence-pointer.mjs check verification-t9/artifacts-v8/adapter-suite.txt --deep   # FRESH + countsMatch
node verification-t9/tools/baseline-freshness.mjs --deep                  # 一行新鲜度
node verification-t9/tools/w3-path-cwd-matrix.mjs                         # W3：8 格矩阵 + 4 反例（exit 0 = 全部如预期）
node verification-t9/tools/tree-fingerprint.mjs                           # 应为 efbe6e05…
node verification-t9/check-report-v10.mjs                                 # 报告自身 25 项验收自检
```
