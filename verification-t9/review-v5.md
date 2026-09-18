# verification-t9/report-v5 — t49 摘要（人类可读）

`generated_at` 2026-09-18T04:33+08:00 ｜ `tree_fingerprint` **375f524b2f72dcc9afe3c4e85fc3c318893f2d23065f380a8ac0311772436bd5**（148 文件，newest `adapters/opencodereview/README.md` 04:25:16；**测量窗口前后两次读取一致**）
`supersedes` `verification-t9/report-v4.json`（v4/v3 与 t18 的 `report.json` 均保留不改）｜ cwd `E:\Desktop\ai-quality-gate`

## 结论

**pass 36 / fail 2 / blocked 1（共 39 = 23 项 + A1–A6 + B1–B4 + V1–V6）**
**放行建议：运行时/门禁层面可放行**；两条 fail 均为**文档同步类**（F8 medium、F9 low），须登记为已知偏差并由 architect 尽快修复。

## t36 两条 high 的复核（本轮最高优先）

| 项 | 结论 | 证据 |
|---|---|---|
| **V1 R3-H2** | **pass 12/12（自建，CLI 层）** | 未闭合 `/*` 后的 env 读取 / `fetch(url)` / `vault.API_KEY` / `expectedFiles` 内 `.md` ⇒ 全部 exit=1 DETECTED；`https://…` 同行后的读取 ⇒ DETECTED；CRLF、BOM 相邻、引号内 `//`、正则含 `/*` ⇒ DETECTED；闭合块注释、纯注释行、EOF 无换行行注释 ⇒ NOT-DETECTED。**层级**：每次都是 `qgate check` + policy 检查作用在临时树真实文件上（非单文件 helper）；**pre-fix 行为无法回放**（无 VCS），故只核 post-fix |
| **V2 R3-H1** | **pass（4/4 verdict）** | 自建 `.env`/`credentials.json`/`secrets/db.txt` 三类目标 + **两个新变体**（`secrets/db-copy.txt` 在 secrets/** 内的别名；`notes2.txt` 同一 inode 第三名）+ 中性对照 `plain.txt`↔`copy.txt`。preview：5 别名全 excluded、`invariants.secretPathsSelected=[]`、中性对照仍 selected；check：exit 0、SAFE_002 passed=true、**secretPathsExcluded=8**（3 按名 + 5 别名） |

## t47 / t48 复核

- **V3 pass**：§8.3.2（L1294-L1317）六项齐备——三类扫描面排除 + 代价、`expectedFiles` 反向纳入（0→2）与空扫失败、注释跳过含**未闭合 `/*`** 与 **`://`** 两条（L1304/L1305）并如实标注 pre-fix 值来源（L1306）、身份链两路径由构造共享（L1308）、Boundary 5 可寻址≠可重放（L1312）、免责口径（L1315）。
- **V4 fail（2 处）**：① `gates/README.md` L127-L131 只写引擎侧（`ino` 主 / `sha` 兜底且 “exact, not a shape heuristic”），未点名适配层兜底是**形状启发式**——该文件为引擎范围、**未写成「两侧相同」**，我判定**不构成不一致**（F10，info）；② **真正的不一致**：`docs/01-architecture.md` **L1311** 仍称适配层 README 有两处相反表述，而 **t48 已统一**（L367「唯一说法」）⇒ F9（low）。
- **V5 pass（6/6 verdict）**：`--diff` 与 `--root` 的 `selected_materialized`（3==3）与 `groups`（2==2）对齐、`groups[].files` 3==3、`unmaterialized[]` 6 项可查、6× `materialized=false`、`tokenSum`/`groupTokenSum` 两模式相等（302/302）、契约面 `included` 仍 9（语义未变）。
- **V6 pass**：适配层 README 只剩**一个**主判据说法（L367），旧反向句 0 命中；t42 要点保留（`scanChildren` 2、兄弟目录候选 1、`lowConfidence` 1、命中率 3）。

## 新发现（本轮）

| id | 级别 | 内容 | owner |
|---|---|---|---|
| **F8** | **medium** | `docs/01-architecture.md` §6.2.2（自称唯一权威映射表）**未列** t48 新增的 `selected[].materialized` 与 `groups[].excluded_unmaterialized`（`grep materialized docs/01-architecture.md` = 0 命中）⇒ 断言 12 判 fail | architect |
| **F9** | low | §8.3.2 L1311 仍称适配层 README 自相矛盾（t48 已修）⇒ 过期句 | architect |
| F10 | info | `gates/README.md` 未点名适配层兜底性质（**不构成不一致**，建议一行交叉引用） | architect/captain |

## 既有断言复跑（不得回退，均已通过）

demo exit 0 / 根 exit 0（索引 16 条、`covered=false`=0）；同 cwd 两运行规范化哈希一致；`--stage` 四阶段 RunResult `valid=true` ×4 且未运行 gate 缺席、包络含 `not_run_gates`；trace 6/6 + `valid=true`；`contract-fields` mismatch **0**；v3-cases **33/33**（含反向 A exit=1、B exit=2 ×3、BOM、未知键、R1/H8、账本篡改四式）；b1 **30/30**；b2 **8/8**（失败路径 `provider=null`）；t42-verify 7/7；schema-eval 三份 valid=true + 反向 `file_exist` valid=false。

## 三 cwd / 三入口 / CI / scripts

| 项 | 实测 |
|---|---|
| 适配层套件（canonical / junction / E:\Desktop） | **100/100/0** ×3 |
| `ocr-preview --json`（仅 stdout，四 cwd 含 `C:\`） | 同一 sha256 `0BC5CB5A2EA97272AC6CA783497AAB9D33B53A21DE9F8DBF827430DF5A8AD3DE` |
| `npm test` / `test:all` | **108/108/0** / **108/108/0**（同一条命令） |
| `npm run test:contract` | 25/25/0 |
| 适配层 `tools/run-tests.mjs` | **100/100/0** |
| 根 scripts（11 条） | **11/11 exit 0** |
| CI 三段式（fresh scratch） | stage 0×4 → warm-up **1**（预期）→ `trace --write` 0 → 权威 **0**（5/5 gate） |

## 残余项（带 owner）

F8 §6.2.2 补两键（medium，architect）｜F9 §8.3.2 L1311 过期句（low，architect）｜F10 gates/README 交叉引用（info，architect/captain）｜T43-1 根 `.qgate/out/**` 残留（low，captain）｜audit-boundary（info）｜F11 D06 理由串重叠（low，adapter-engineer）。

## 复核入口

```powershell
Set-Location E:\Desktop\ai-quality-gate
node -e "const r=require('./verification-t9/report-v5.json');if(!r.assertions||r.assertions.length<12)process.exit(1)"
node verification-t9/tools/v1-comment-boundary.mjs   # V1 12 例（CLI 层）
node verification-t9/tools/v2-engine-identity.mjs    # V2 引擎身份链（5 别名 + 负向对照）
node verification-t9/tools/v5-counting.mjs           # V5 计数口径
node verification-t9/tools/preview-crosscheck.mjs    # F8 复现（adapterSelected/Groups 各多一键）
node verification-t9/tools/b1-coverage-matrix.mjs    # 30 格
node verification-t9/tools/tree-fingerprint.mjs      # 应为 375f524b…
```
