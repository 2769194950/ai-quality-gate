# verification-t9/ — t18 端到端独立验证（重建版）

Owner: **verifier**（attempt `2701a07c-ffa1-4b7a-ba96-012490d010a4`）。本目录是 t18 的全部交付物；
`verification/**`（引擎审计链）本轮**未被写入**（详见文末「目录归属与清理」）。

## 1. 结论

`verification-t9/report.json`：**pass 11 / fail 0 / blocked 1（共 12 条断言）**，11 条实测不一致（I1–I11，其中 I11 已由 t16 改正）、6 项 blocked、1 条事故记录（不计 fail）。

执行口径：所有断言**默认在仓库规范路径 `E:\Desktop\ai-quality-gate` 下执行**，每条断言都带 `cwd` 字段；跨 cwd 只在断言 4 与 GAP-5 对照中刻意使用 `E:\ai-quality-gate`（junction 拼写）与 `E:\Desktop`。

| # | 断言 | status | 关键实测 |
|---|---|---|---|
| 1 | 两个测试套件全绿 | pass | 引擎 60/60（7+18+12+23，`--experimental-test-isolation=none`，exit 0）；适配层 57/57（`tools/run-tests.mjs`，exit 0）；字面量 `node --test <dir>` = spawn EPERM（裁决 C 标注） |
| 2 | demo 五阶段端到端 | pass | `check --summary` exit 0，overall_passed=true，stages 恰为 5 个，approvals_missing=0 |
| 3 | 同命令两次运行一致 | pass | 两次规范化 sha256 均为 `6e4999bf…b6c1ac`；239 叶子中仅 3 个运行时叶子不同 |
| 4 | 确定性①固定 cwd ②跨 cwd + 离线环境 | pass | ① 仅运行时叶子差异；② 引擎 check 跨 cwd **恰 1 个**语义叶子（CONTRACT_001 scannedConfig），适配层 preview **4 个**叶子；无 Key 环境变量、无 node_modules、三份 deps 全空 |
| 5 | 反向用例 A（删必需证据文件） | pass | A **exit=1**，唯一 blocker 精确指向 `.qgate/evidence/test-results.json`；对照 A-control exit=0 |
| 6 | 反向用例 B（非法配置） | pass | 缺 version **exit=2** CONFIG_INVALID(/version)；`check.type="file_exist"` **exit=2** CONFIG_INVALID(/gates/0/checks/0/type)；配置不存在 **exit=2** CONFIG_NOT_FOUND |
| 7 | SAFE_002 安全不变量 | pass | 默认/恶意 `--rule`/恶意 `--include` 三场景 included 均 14、泄漏 0；4 条密钥路径全在 excluded |
| 8 | traceability | pass | 6/6 covered、testIds 非空、summary {6,6,0,0,1}，13/13 一致性检查通过 |
| 9 | 文档 vs 实现字段面 | pass | mismatch **0**（29 个 schema 层级 + 真实 RunResult + 3 份真实配置）；不一致清单见 §3 |
| 10 | 未验证项如实标 blocked | blocked | 6 项清单见 §4 |
| 11 | 4 份 schema + 三项正反判定 | pass | demo / _canonical-config / five-stage 均 valid=true errors=[]；`file_exist` valid=false errors=2（enum + oneOf matched 0） |
| 12 | priority 归一化公式 | pass | 引擎 cli=0 / builtin=3，适配层 cli=1；同树同层 14 个文件 delta 全为 1 ⇒ `engine_priority = adapter_priority − 1` |

## 2. 两个 cwd 的实测计数（裁决 B 的对照）

| 命令 | cwd=`E:\Desktop\ai-quality-gate`（规范路径） | cwd=`E:\ai-quality-gate`（junction 拼写） | cwd=`E:\Desktop` |
|---|---|---|---|
| `node adapters/opencodereview/tools/run-tests.mjs` | **57 / 54 通过? → 57 通过 / 0 失败（全绿）** | **54 通过 / 3 失败** | **54 通过 / 3 失败** |
| 3 条失败 | — | `fixtures.test.mjs` 三条真实产物回归 | 同左 |
| 差异键（JSON 逐叶子） | — | `$.rules.layer_trace[0].file`、`$.rules.layer_trace[1].file`、`$.rules.loaded_layers[0].file`、`$.source.path`（4 个，均为存档的绝对路径） | 同左 |

非仓库根 cwd 的失败按裁决 B 记 **blocked（GAP-5 / cwd 依赖）**，不判 fail。引擎侧 `check --json` 的跨 cwd 差异只有 1 个语义叶子：`/gates/3/checks/3/evidence/0/excerpt`（CONTRACT_001 的 `scannedConfig` 绝对路径）。
t2 报告的对照口径（cwd=packages/qgate + 相对 `--config demo/qgate.config.json`）实测 **exit=2 CONFIG_NOT_FOUND**，即按原文不可复现；改用**绝对** `--config` 后 exit=0 且语义差异 0 个叶子——t2 的结论在绝对配置路径下成立。

## 3. 不一致清单（11 条，详见 report.json `inconsistencies`）

| id | 级别 | 一句话 | 建议 owner |
|---|---|---|---|
| I1 | high | 根 `package.json` 的 7 个脚本全部指向不存在的 `demo/mini-service/.qgate/config.json` | core-engineer (t7) |
| I2 | medium | `run-result.schema.json` 用 `type:["string","null"]`，与 §9.1/schemas README 声称的 `oneOf` 写法相反 | architect |
| I3 | medium | stdio 不可管道时 `command.stdoutRegex` 未评估却报 passed=true（静默通过） | core-engineer |
| I4 | low | §5.1 L333 写「上述 5 项」却列出 7 个字段 | architect |
| I5 | low | §6.2 L711 称 `check --summary` 输出人类表格，实测为 JSON | architect |
| I6 | low | 两侧 `--rule` 规则文件格式不兼容且失效方向不对称（引擎 exit 2 / 适配层静默忽略） | architect/captain |
| I7 | medium | §3.4 L127/L130 的「双 cwd RunResult 深度相等」与实测不符（引擎 check 差 1 个 scannedConfig 叶子） | architect |
| I8 | low | REQ-010 验证方式引用不存在的 `packages/qgate/test/zero-dep.test.mjs` | architect |
| I9 | low | GAP-5 的「恰 1 个叶子不同」比实测窄（相对调用实测 4 个叶子） | architect |
| I10 | low | 包内仍有临时探针脚本（如 `packages/qgate/test/_probe-t17-read.mjs`） | core-engineer |
| I11 | medium（已解决） | §6.2.3 早前的「两个 cwd 均 57/54/3」数字被复跑证伪，t16 已于 02:35:38 改正 | — |

未把以下三项记为缺陷（已裁决/已记账）：适配层字段名差异（§6.2.2 有意保留）、跨 cwd 缺口（GAP-5）、`node --test` 的 spawn EPERM（裁决 C）。

## 4. blocked 清单（6 项）

1. **非仓库根 cwd 下适配层 54/57** — cwd 依赖（GAP-5），按裁决 B 标 blocked。
2. **GitHub Actions 真实执行** — 无网络/runner。
3. **干净 checkout / commit 哈希复现** — 本项目不在 git 仓库内，改用同 workspace 重跑 + 规范化哈希 + 全文件指纹。
4. **§9.1 `approval.json` 的 schema 级校验** — 无该 schema 制品，只能文本 + RunResult 侧核验。
5. **引擎侧跨 cwd 叶子（CONTRACT_001 scannedConfig）的文档覆盖** — 已精确定位，等待 §6.2.3 增补。
6. **字面量 `node --test <dir>`** — spawn EPERM（裁决 C）。

## 5. 事故记录（不计 fail）

`INC-1`：2026-09-18T02:32:06 `verification/**` 被清空（core-engineer 承认执行 `Remove-Item verification -Recurse -Force`），丢失 `report.json`(34799 B) + 9 个 tools + 36 个 artifacts + negative 夹具；幸存 5 个引擎写出文件。结构性成因：引擎默认 `evidenceDir/reportDir` 指向 `verification/**`，仓库根「干净 e2e 跑」的清理会连带删除验证工作目录。处置：captain 把验证产物根迁到 `verification-t9/**` 并下发冻结标记。本报告为重跑后的重建版。

## 6. 目录归属与清理

- 交付物全部位于 `verification-t9/**`：`report.json`、`review.md`、`tools/`（9 个脚本）、`artifacts/`（原始捕获、指纹、leaf-diff、工具报告、`preview-compare/demo` 副本）、`negative/`（A-missing-evidence、A-control、B1、B2、safe002 恶意规则）。
- 迁移前（02:32:45–02:33:42）曾写入 `verification/{tools,artifacts,negative}` 的 11 个副本，经 captain 02:37 明确授权后**已删除**。
- 清理后计数：`verification/` = 3 个顶层条目（`evidence/`、`.captain-freeze.json`、`trace-matrix.json`）、12 个文件（全部为引擎写出物或 captain 制品）；`verification-t9/` = 4 个顶层条目、153 个文件。
- 本轮未修改 `packages/qgate/**`、`adapters/**`、`schemas/**`、`docs/**` 的任何字节。

## 7. 复现

```powershell
Set-Location E:\Desktop\ai-quality-gate   # 必须：所有断言的默认 cwd

node --test --experimental-test-isolation=none packages/qgate/test/config-and-run-result.test.mjs packages/qgate/test/pipeline-and-checks.test.mjs packages/qgate/test/acceptance.test.mjs packages/qgate/test/schema-contract.test.mjs
node adapters/opencodereview/tools/run-tests.mjs
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --summary
node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json   # ×2，写入 artifacts 后比对
node packages/qgate/bin/qgate.mjs trace --config demo/qgate.config.json --json

node verification-t9/tools/tree-fingerprint.mjs                 # 修订指纹
node verification-t9/tools/normalize-runresult.mjs verification-t9/artifacts/runresult-1.json verification-t9/artifacts/runresult-2.json
node verification-t9/tools/leaf-diff.mjs verification-t9/artifacts/runresult-1.json verification-t9/artifacts/runresult-cwd-junction.json
node verification-t9/tools/schema-eval.mjs                      # 断言 11
node verification-t9/tools/schema-meta.mjs                      # 4 份 schema + 可空写法
node verification-t9/tools/contract-fields.mjs                  # 断言 9（mismatch count = 0）
node verification-t9/tools/trace-check.mjs                      # 断言 8（allChecksPass=true）
node verification-t9/tools/preview-crosscheck.mjs               # 断言 7/12
node verification-t9/tools/fixture-diff.mjs                     # 适配层夹具回归漂移定位
```

## 8. 方法局限

- Schema 求值使用仓库自带的零依赖 draft 2020-12 **子集**求值器（Node 无内置校验器、项目要求零依赖）：未知关键字被忽略，因此只声称「按该求值器求值」，不声称完整规范合规。
- `contract-fields` 对真实 RunResult 的 blocker/check/humanGate/evidence 采用**整轮并集**；本次通过的运行里 blocker 对象数为 0，该层标为「本次运行未行使」，不计 mismatch。
- 受沙箱限制，`node --test <dir>` 不可用，全部测试证据来自进程内/隔离关闭的等价运行并已标注。
