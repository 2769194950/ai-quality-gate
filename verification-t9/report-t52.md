# report-t52 — preview-crosscheck 改为解析契约表（消除「权威面 vs 工具副本」二次漂移）

范围：**只改 `verification-t9/tools/preview-crosscheck.mjs`**（+ 本目录证据文件）。
未改 `packages/qgate/**`、`adapters/**`、`schemas/**`、`docs/**`、`verification/**`。
另注：**夹具与实现的一致性问题不在本任务范围**——t52 只修工具；那部分已由 captain 另派 adapter-engineer（本报告不涉及、也不去改 `adapters/**`）。

## 1. 方案（首选方案，已采用）：解析冻结表，不再硬编码

**根因**：原工具 L54-L61 有一份手抄的 `docClaim` 键表，只读真实产物、**根本不读 `docs/01-architecture.md`** ⇒ 它构成**第二个权威面**，t48 加键后它必然漂移（architect 已证明：补文档无法翻转它的输出），而且它只覆盖 6 个容器、**完全没有**顶层键与 `counts`。

**修法**：工具现在**解析文档表格本身**并据此生成期望集：

| 期望组 | 解析来源 | 比较模式 |
|---|---|---|
| `engineTopLevel` | §6.2.1 顶层键表（L870-L879） | exact（8） |
| `engineRuleMatch` | §6.2.1 `ruleMatch[]` 字段表（L887-L895） | exact（7） |
| `adapterRuleMatch` | §6.2.2.1 映射表（L916-L924） | exact（7） |
| `adapterSelected` | §6.2.2.2 第 2 列（L934-L943） | exact（9，含 `materialized`） |
| `adapterExcluded` | §6.2.2.2 第 3 列 | exact（7） |
| `adapterGroups` | §6.2.2.3 第 2 列（L962-L968） | exact（7，含 `excluded_unmaterialized`） |
| `adapterSelection` | §6.2.2.4 第 2 列（L978-L979） | exact（2） |
| `adapterCounts` | §6.2.2.5 `counts.*`（L995-L999） | **subset**（3） |
| `adapterTopLevelDeclared` | §6.2.2.5 顶层清单键（L995-L999） | **subset**（2：`unmaterialized`、`selectedPathsMaterialized`） |

- 为什么 `counts` 与顶层用 **subset**：§6.2.2.5 明确只声明 **t48 新增**的那些键，不是 `counts`/顶层的完整清单（实测 counts 13 键、顶层 23 键）。用 exact 会产生假 DIFF；subset 恰好表达「文档声明的键必须真实存在」，而**声明来源仍是文档**，不是工具副本。
- t50 新增的 **7 个键全部由解析得到**：`selected[].materialized`、`groups[].excluded_unmaterialized`、`counts.selected_materialized`、`counts.unmaterialized`、`counts.groups_dropped_unmaterialized`、顶层 `unmaterialized`、顶层 `selectedPathsMaterialized`。

**为什么不用备选**：备选（把 `docClaim` 补全 + 加一条「文档键数 = docClaim 键数」自检）**仍然保留一份手抄副本**，只是加了个哨兵；而 §6.2.2/§6.2.2.x 的表格本身已是逐键 markdown 表（t50 已按格式补齐），解析是可行的——实测 9 个组全部可解析。因此我采用首选方案；若未来表格格式频繁变动，替代方案应是**机器可读契约源**（例如 `packages/qgate/gates/contract.json`），但那只读不写属 core-engineer 范围，需 captain 裁决后再动。

## 2. fail-closed 与退出码

- **解析失败即报错退出**：文档不可读、六个必需小节缺失、某表 0 行、或**某组解析出的键数低于结构下限**（`engineTopLevel≥8`、`engineRuleMatch≥7`、`adapterRuleMatch≥7`、`adapterSelected≥9`、`adapterExcluded≥7`、`adapterGroups≥7`、`adapterSelection≥2`、`adapterCounts≥3`、`adapterTopLevelDeclared≥2`）⇒ **exit 3**，stderr 打印组名、实际键数、下限与文档路径，**绝不**用空期望集继续比对（否则会变成「解析不到就全绿」）。
  - 下限是**结构哨兵**，不是键清单副本：文档将来合法增键仍可通过；只有解析出**少于**已知规模时才触发。
- **退出码语义**：`0` = 全部对齐；`1` = 存在 DIFF（契约声明 vs 真实产物不一致）；`3` = 契约读取/解析失败（fail-closed）。
  - 用 `1` 表达 DIFF，是为了让 CI 与读者**不可能**把「有 DIFF」看成通过；用 `3` 而非 `2`，与引擎自身「契约/自描述不一致 ⇒ 3（CONTRACT_DRIFT）」的习惯一致，且与「门禁失败=1」区分开（这里是检查工具自身无法建立判据，不是被检对象失败）。

## 3. 实测证据

**A. 对齐运行（真实文档 + 真实产物）：`exit 0`**

```
OK   engineTopLevel     [exact]  §6.2.1   lines 872-879  declared=8  actual=8  missing=[] extra=[]
OK   engineRuleMatch    [exact]  §6.2.1   lines 889-895  declared=7  actual=7  missing=[] extra=[]
OK   adapterRuleMatch   [exact]  §6.2.2.x lines 916-924  declared=7  actual=7  missing=[] extra=[]
OK   adapterSelected    [exact]  §6.2.2.x lines 934-943  declared=9  actual=9  missing=[] extra=[]
OK   adapterExcluded    [exact]  §6.2.2.x lines 934-943  declared=7  actual=7  missing=[] extra=[]
OK   adapterGroups      [exact]  §6.2.2.x lines 962-968  declared=7  actual=7  missing=[] extra=[]
OK   adapterSelection   [exact]  §6.2.2.x lines 978-979  declared=2  actual=2  missing=[] extra=[]
OK   adapterCounts      [subset] §6.2.2.x lines 995-999  declared=3  actual=13 missing=[] extra=[]
OK   adapterTopLevelDeclared [subset] §6.2.2.x lines 995-999 declared=2 actual=23 missing=[] extra=[]
verdict: ALIGNED (exit 0)
```
（同时 3 条 SAFE_002 安全场景 `invariantHolds=true`；priority 公式 `cli` 层 delta=[1]。）

**B. 退出码矩阵（构造用例，全部落在 `%TEMP%`，未触碰任何受保护文件）**

| 用例 | 构造 | exit | 输出 |
|---|---|---|---|
| `aligned_real_doc` | 真实文档 + 真实产物 | **0** | `verdict: ALIGNED (exit 0)` |
| `diff_expectation_side_renamed_key` | 文档副本把 `materialized` 改名为 `materializedRenamedByT52`（行数不变，避开下限） | **1** | `DIFF adapterSelected … missing=["materializedRenamedByT52"] extra=["materialized"]` |
| `diff_artifact_side_extra_key` | 产物副本给 `selected[0]` 加 `bogus_key_added_by_t52_test` | **1** | `DIFF adapterSelected … extra=["bogus_key_added_by_t52_test"]` |
| `parse_fail_heading_renamed` | 文档副本把 `##### 6.2.2.2` 改名 | **3** | `PARSE FAILURE (fail-closed): section heading … not found` |
| `parse_fail_table_broken` | 文档副本把 `materialized` 行改成散文（表格行变少） | **3** | `PARSE FAILURE (fail-closed): group adapterSelected parsed only 8 key(s), below its structural floor of 9` |

机器可读矩阵：`verification-t9/artifacts-v5/t52-exit-code-matrix.json`；对齐运行的完整 JSON：`verification-t9/artifacts-v5/preview-crosscheck-v2.json`。
「恢复」说明：B 表五个用例全部使用 `%TEMP%` 下的**副本**，真实 `docs/01-architecture.md` 与真实产物**全程未被修改**（因此无需恢复；第 6 步用真实文档复跑仍为 exit 0）。

## 4. 影响与局限

- 本工具现在**只以文档为期望来源**，文档一更新，期望立即跟随——T52 的直接目的（断言 12 的最后一条未转绿项）达成：`adapterSelected 9/9`、`adapterGroups 7/7`、`counts`/顶层 subset 全部覆盖。
- 局限 1：解析依赖 markdown 表结构（标题文本 + 表格列位）。已在 §2 用**下限哨兵 + exit 3** 把「格式变了」变成响亮失败，而不是静默通过。
- 局限 2：见 §1 末段——若表格格式将来频繁变动，应改读机器可读契约源（`packages/qgate/gates/contract.json` 等），但那属 core-engineer 写权，需 captain 裁决。
- 观测（与本任务无关，仅记录）：运行期间 `adapters/opencodereview/README.md` 于 04:38:16 被**其他成员**写入（与我 t47 记录的值不同，非我所为）；本工具只读 `docs/**` 与我自己的 `artifacts-v5/**`，故该写入**不影响**本次结论。
