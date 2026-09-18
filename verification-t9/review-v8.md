# t60 复核报告（人读版）—— verifier / attempt 1bac37d1

- 修订指纹：**74a28c906b7337967bf2d1aa6c0fb33c0cf5eac18277f1544e59d123b6540bc3**（152 文件，`--product-only` 补充值 `c39cf8e6…`/122 文件）
- 采样：窗口前 10:57 与窗口后 11:1x 两次一致；`newest = docs/01-architecture.md 10:54:29 (+08:00)`（t61 最后一笔）
- 开工前提：t58 终态；**t59（gates/README）与 t61（docs/01-architecture.md）本轮均已 completed**，Y2 因此可判而非 blocked；t62 正按「等 report-v8」持锁，测量窗口内无写入者
- 结论：**57 pass / 0 fail / 1 blocked（共 58 条）**，产出 `verification-t9/report-v8.json`（supersedes report-v7.json）

## X —— 证据卫生根治（本轮主任务）

| 项 | 结果 | 关键实测 |
|---|---|---|
| **X1** 基线降级为「指针 + 内容哈希」 | **pass** | 6 个 `adapter-suite.txt` 统一为 `pointer+hash v1`：1 个 RECORDED（v8，14/131）+ 5 个 SUPERSEDED（adopted 转换，payload 字节未改、哈希封存）。过期判定只剩三件事：重算 `tree_fingerprint`、复算 payload `content_sha256`、`--deep` 重跑比 counts |
| **X2** 重录为 14 文件 / 131 用例 | **pass** | before **11/109**（v7 权威副本 payload 实测）→ after **14/131/0**（本轮实测，三 cwd 一致）。中间态 13/121(t56)、14/131(t58) 是**转述**，已标 `measured_by_verifier:false` |
| **X3** 新鲜度成为「一行机器可判」 | **pass** | `BASELINE-FRESHNESS current=74a28c906b73 files=6 fresh=1 superseded=5 stale=0 tampered=0 count_drift=0` exit 0；四个自建负例 **STALE=1 / TAMPERED=2 / COUNT-DRIFT=1 / UNPARSABLE=3**。工具侧另有 `tool-hashes-check`（125 条 pinned 哈希全 MATCH；受控漂移 → `DRIFT` exit 1，字节还原后 exit 0） |
| **X4** 指纹选边 | **(b)** | 权威指纹**保留** test 树，并写明流程：**指纹变 ⇒ 基线必重录**。理由：选 (a) 会让新鲜度检查**瞎在它必须抓的事件上**（加测试文件会改 counts 却不改「对测试不敏感」的指纹 ⇒ 过期基线被判 FRESH） |

## Y —— 必验项

| 项 | 结果 | 关键实测 |
|---|---|---|
| **Y1** F14 复核（自建 60 格） | **pass** | 客户端调用 **20/20 两侧都报**；**良性对照 20/20 零误报**；碰撞 6/6 两侧都报；非 HTTP 成员 5/5 不报；**本层更严的 2 条仍报**（`XMLHttpRequest()`/`WebSocket()` = adapter true / engine false），方向未被抹掉。**同时新发现 6 格本层更松**（F15 跨行 4 格 + F16 星号行 2 格）与 1 格两侧都漏（`fetch\n(url)`）——按方向如实登记，不当成 pass |
| **Y2** F13 文档 + 独立复现 | **pass** | N1 复现：`['NOPE','src']` ⇒ `filesScanned=1, passed=true, exit 0`（守卫是**聚合**的）；只含不存在根 ⇒ 0 文件 + `empty scan set` + exit 1；原生 NTFS 上 `['SRC']` 解析成功且证据保留配置拼写 `SRC/app.mjs`；`expectedFiles:['NOPE/app.mjs']` 记 `declared scan target not found`，绝不静默通过。代码依据（`absOf`+`fileExists`、无大小写折叠）与披露（`wsl -l -v` = E_ACCESSDENIED、`fsutil file setCaseSensitiveInfo` = Access denied）均实测吻合 |
| **Y3** 三项基线 | **pass** | 引擎 **110/110/0**、**110/110/0**、**25/25/0**；demo exit 0 / 5 of 5；根配置 exit 0；适配层三 cwd **14/131/131/0**；`ocr-preview --json` 四 cwd（含 `C:\`）同哈希 **F445867E…A03F77**（18315 B，仅 stdout） |
| **Y4** 全量回归 | **pass（W4 翻转）** | 19 个 verifier 工具全 exit 0；**W4 由 fail→pass**（`sweepDisagreements=[]` ⇒ F12 真修）。另**自查出断言 9 原为静默跳过**（见 F18）并已修+用真实 RunResult 重测 |
| **Y5** 新绕过 + README §4 | **pass** | 新绕过族 = 路径拼写规范化（25 种：大小写/尾随点空格/`./`、`.\`/`..`/ADS `::$DATA`/8.3 短名），在最宽 include `**/*` 下 **无一敏感材料被纳入**（inode 比对）；引擎 `policySafe002` 同批变体 `passed=true`、`secretPathsExcluded=8`（对照 1）。README §4 = **11 行**、**G1 已是独立行**、24 表/191 行 **brokenRows=0** |

## 本轮新发现（均不阻塞放行）

| id | 严重度 | owner | 内容 |
|---|---|---|---|
| **F15** | medium | adapter-engineer | 适配层按**行**扫命名客户端调用，引擎按整段文本 ⇒ `const r = await ky\n  .get(url);`（prettier 风格链式调用）等 **4 格 engine=true/adapter=false** |
| **F16** | low | adapter-engineer | 以 `*` 开头的行被适配层当 JSDoc 续行跳过（fail-open）：未闭合 `/*` + ` * axios.get(url);` ⇒ engine=true/adapter=false（引擎侧 t46 已修） |
| **F17** | low | adapter-engineer | 名规则漏判 Windows 可规范化写法：`.env `/` .env`/`.env::$DATA`/`CREDEN~1.JSON`；前三者**仅靠扩展名白名单兜住**（换成更宽的配置即纳入），8.3 别名状态**无法判定**（`fsutil 8dot3name query` = Access denied） |
| **F18** | medium | verifier（已修） | 三个 verifier 工具静默消费旧修订/缺失输入：`contract-fields` 默认指向不存在的文件且整段比对被 `existsSync` 包着 ⇒ 报 `mismatches:0` 却是空转；`trace-check` 硬编码 `artifacts-v7` 连自述路径也是那个硬编码；`preview-crosscheck` 默认 `artifacts-v5`。三者已改为必填 + 缺失 exit 3 |
| **F19** | medium | core-engineer | 根配置无 `selection` ⇒ SAFE_002 扫描集含 `verification-t9/**`，`metrics.selected` 精确跟随 verifier 写入（585→643；对照实验 +1 文件 ⇒ +1）。**判定不变**（exit 0 / secretPathsExcluded=17），但**同一修订的 RunResult 文本不稳定** |

已闭环：**F12**（词表同判，W4 翻转）、**F13**（t59/t61 + 独立复现）、**F14**（60 格按声明方向成立，余 F15/F16）。

## 方法论教训（记账用）

- **M1**：PowerShell 文本往返**两次**损坏证据/源码（`Get-Content|Set-Content` 改写指针副本被机制正确判成 TAMPERED；`-replace` 插入模板字面量被 `${}` 插值打断）。code/evidence 一律不经过 PS 文本管线。
- **M2**：**采集文件必须写在被测树之外**。第一次测「根配置跨 cwd 一致性」得到 `normalized-equal=false`，根因是我的采集 JSON 写进了 `verification-t9/artifacts-v8/`，而该目录在 SAFE_002 扫描集内 ⇒ 每次运行 `selected` +1。改写外部目录后 `normalized-equal=true`。

## 放行建议

**可放行（release-ready）**：无 blocker/high 残留；F15/F16/F17 是适配层 pre-filter 的 fail-open 方向（同一输入上引擎侧 SAFE_003 仍 fail-closed），F19 只影响 RunResult 文本稳定性 —— 四条均由断言证明**不影响门禁判定**。

建议下一轮顺序：**R5**（把 `baseline-freshness.mjs` 注册为门禁 check —— X1 的结构性收口）→ **R4**（收窄根配置扫描集）→ **R1**(F15) → **R3**(F17) → **R2**(F16)。

## 复现入口

```powershell
Set-Location E:\Desktop\ai-quality-gate
node verification-t9/tools/baseline-freshness.mjs --deep          # X1/X3：一行新鲜度（0 FRESH）
node verification-t9/tools/evidence-pointer.mjs check verification-t9/artifacts-v8/adapter-suite.txt --deep
node verification-t9/tools/y1-named-client-parity.mjs             # Y1（exit 4 = 期望成立但有分歧）
node verification-t9/tools/y2-f13-scanroots.mjs                   # Y2
node verification-t9/tools/y5-bypass-windows-names.mjs            # Y5 绕过尝试
node verification-t9/tools/y5-table-integrity.mjs                 # Y5 表格完整性
node verification-t9/tools/preview-crosscheck.mjs --json --artifacts verification-t9/artifacts-v8
node verification-t9/tools/tree-fingerprint.mjs                   # 应为 74a28c90…
node verification-t9/check-report-v8.mjs                          # 报告自身的 18 项验收自检
```
