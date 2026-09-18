# verification-t9/report-v6 — 收尾复验摘要（v5 → v6）

`generated_at` 2026-09-18T10:26+08:00 ｜ `tree_fingerprint` **defa6e42dd6363172c6b7700e76f6de12a023a7c52f6f41137b3216dbbbcb1b0**（148 文件，newest 适配层夹具 04:39:43；窗口内 3 次读取一致，报告时复算一致）
`supersedes` `verification-t9/report-v5.json`（v5/v4/v3 与 t18 的 `report.json` 均保留不改）｜ cwd `E:\Desktop\ai-quality-gate`

## 结论

**pass 40 / fail 0 / blocked 1（共 41 条断言）**
**放行建议：可放行（release-ready，无条件）** —— v5 的两条 fail 全部闭合，无 blocker/high 残留；唯一 blocked 是 5 项环境限制项（GH Actions 真跑、干净 clone 全流程、跨任务「未触碰」的独立基线、§9.1 无 schema、字面量 `node --test <dir>`）。

## 相对 v5 的三处转绿

| 项 | v5 | v6 | 依据 |
|---|---|---|---|
| **断言 12** §6.2.1/§6.2.2 键集一致 | **fail**（`selected[]` 多 `materialized`、`groups[]` 多 `excluded_unmaterialized`；F8 medium） | **pass** | t50 逐键补齐 §6.2.2.2/.3/.5（含 7 个新键）+ t52 让工具**解析表格**生成期望（不再手抄）；本轮 `preview-crosscheck --artifacts verification-t9/artifacts-v6` ⇒ **verdict ALIGNED、exit 0**：engineTopLevel 8/8、engineRuleMatch 7/7、adapterRuleMatch 7/7、adapterSelected 9/9、adapterExcluded 7/7、adapterGroups 7/7、adapterSelection 2/2、adapterCounts subset 3/3、adapterTopLevelDeclared subset 2/2 |
| **V4** 三处文档的信号不对称 | **fail**（§8.3.2 L1311 过期句；F9 low） | **pass** | docs L1309 如实 + 适配层 README L367/L385-L394 如实 + gates/README 未声称两侧相同（F10 仍为 info）；**L1339 已更新**为「该不一致已由 t48 修复」 |
| — | — | **新增 V7 pass** | t51 收尾：三份夹具在**同一规范化规则**下与新鲜运行一致（3/3，exit 0；与适配层 harness 9/9 一致）；README L612「顶层 `unmaterialized`」与实测一致；适配层套件 **102/102** |

## 验证者工具自查（V8 / self_repairs）

- **SR-1（本轮）**：`fixture-diff.mjs` 原只抹 `<ADAPTER_ROOT>`，而 t51 的夹具合法使用 `<HOME>`/`<REPO_ROOT>` 占位符 ⇒ 会报 3/3「夹具不一致」的**假结论**。已改为**导入适配层权威 scrubber**（`adapters/opencodereview/test/portable.mjs`），删除本地副本 ⇒ 3/3 OK。与 t52 同源教训：**不保留第二份会漂移的权威副本**。
- **SR-2（t52）**：`preview-crosscheck.mjs` 期望改为解析 §6.2.1/§6.2.2 表格；DIFF ⇒ exit 1；解析失败 ⇒ exit 3（结构下限哨兵）。

## 既有断言（全部复跑通过，未回退）

demo exit 0 / 根 exit 0（索引 16 条、`covered=false`=0）；同 cwd 两运行规范化哈希一致；`--stage` 四阶段 RunResult valid ×4、未运行 gate 缺席、包络含 `not_run_gates`；trace 6/6 + valid；contract-fields mismatch 0；v3-cases **33/33**；B1 **30/30**；B2 **8/8**；t42-verify **7/7**；V1 **12/12**；V2 4/4 verdict（`secretPathsExcluded=8`）；V5 6/6；schema-eval 三份 valid + 反向 false；BOM 合法 0 / 非法 2；未知键 4×exit 2；账本篡改 4×exit 3；CI 三段式 stage 0×4 → warm-up 1（预期）→ `trace --write` 0 → 权威 0。

## 三 cwd / 三入口 / scripts

| 项 | 实测 |
|---|---|
| 适配层套件（canonical / junction / E:\Desktop） | **102/102/0** ×3 |
| `ocr-preview --json`（仅 stdout，四 cwd 含 `C:\`） | 同一 sha256 `0BC5CB5A2EA97272AC6CA783497AAB9D33B53A21DE9F8DBF827430DF5A8AD3DE` |
| `npm test` / `test:all` | 108/108/0 ≡ 108/108/0 |
| `test:contract` | 25/25/0 |
| 根 scripts | 11/11 exit 0 |

## 残余项（带 owner，均不阻塞放行）

F11 D06/D04 理由串重叠（low，adapter-engineer）｜T43-1 根 `.qgate/out/**` 残留（low，captain）｜F10 gates/README 可选交叉引用（info，architect/captain）｜audit-boundary「covered=true 仅证明承载 check 被执行」（info）。

## 复核入口

```powershell
Set-Location E:\Desktop\ai-quality-gate
node -e "const r=require('./verification-t9/report-v6.json');if(!r.assertions||r.assertions.length<12)process.exit(1)"
node verification-t9/tools/preview-crosscheck.mjs --artifacts verification-t9/artifacts-v6   # 断言 12：ALIGNED / exit 0
node verification-t9/tools/fixture-diff.mjs                                                 # V7：3/3 OK
node verification-t9/tools/v3-cases.mjs ; b1-coverage-matrix.mjs ; v5-counting.mjs
node verification-t9/tools/tree-fingerprint.mjs                                             # 应为 defa6e42…
```
