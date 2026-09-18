# verification-t9/report-v7 — t55 最终正式复验摘要

`generated_at` 2026-09-18T10:37+08:00 ｜ `tree_fingerprint` **91c689dd0577f46ade5373aff9554fbc4d2c38f7b76b4e02198b91a5dde67624**（149 文件，newest `packages/qgate/gates/README.md` 10:28:35；窗口开始/结束/报告时三次复算一致）
`supersedes` `verification-t9/report-v6.json`（v3–v6 与 t18 的 `report.json` 均保留不改）｜ cwd `E:\Desktop\ai-quality-gate`

## 结论

**pass 47 / fail 1 / blocked 1（共 49 条 = v6 的 41 条 + W1–W8）**
**放行建议：可放行（release-ready）**，并把本轮新发现的 **F12（medium）** 登记为残余项（不阻塞：门禁判定由引擎侧覆盖，仓库实测 0 命中）。

## W1–W8 逐条

| 项 | 结论 | 关键实测 |
|---|---|---|
| **W1** R3-B1 引擎侧大小写 | **pass**（自建同构两树，7/7 verdict） | UPPER/lower 两棵同构树：preview/check 均 exit 0、included 均仅 `src/app.mjs`、`secretPathsExcluded` 两侧**均为 6**；逐项 **reason=`secret_path`**、rule=`secret-env`/`secret-credentials`/`secret-dir`/`secret-pem`/`secret-key`，**无一条 `extension`**；`NODE_MODULES/dep.mjs`→`default_excluded_path`；`invariants.secretPathsSelected=[]`。**新变体 2 个**：`.Env.Production`、`Secrets/API.KEY`（大写扩展名） |
| **W2** R3-H1 大写目标别名 | **pass**（5/5 verdict） | `notes.txt` → `Credentials.json` 排除，形态为 **`reason=secret_path` + `rule=alias:secret-credentials:same-inode-as-sensitive-path`**（**不是** `hardlink_secret_alias`）；SAFE_002 passed、`secretPathsExcluded=2`。自建绕过尝试：`CREDENTIALS.JSON` 的两个硬链接 `Handbook.txt`/`MANUAL.TXT` 亦被身份链排除（count=3） |
| **W3** 11 行对照表抽查（≥4 行）+ 两处故意不改 | **pass** 4/4 行 rationaleHolds | 敏感路径行（W1 复现）、默认排除目录行（`NODE_MODULES`→`default_excluded_path`）、二进制扩展名行（`.PNG`/`.png` 均 `reason=binary`）、用户白名单行（`extensions=['.MJS']`⇒included=[]、reason=`extension`；`['.mjs']`⇒选中 ⇒ **改成 CI 会让文件回到 selected**）；第二处：`NODE_MODULES/dep.mjs` 今日**被扫描**（filesScanned=1、命中 1 条），改 CI 会跳过 ⇒ **减少覆盖** |
| **W4** R3-L3 裸模块导入两侧同判 | **fail**（12 例中 11 同判） | `import 'node:dns';`（副作用导入、从不调用）⇒ **引擎报、适配层不报**。22 格词表扫描：**4/22 不同判**，全部是 **`dns`/`undici`** 的两种形态。根因：引擎 `NET_MODULE_NAMES=['https?','net','dns','tls','dgram','undici']` vs 适配层 `NET_MODULES` 缺 `dns`/`undici` ⇒ **F12（medium）** |
| **W5** 边界未松绑 | **pass** | `node:fs`/`os`/`node:path`、注释行、否定行、纯模块名字符串字面量 **两侧均不报**（boundaryLoosened=[]） |
| **W6** 重录过期适配层基线 | **pass** | before→after：`artifacts/` 5 files/57 tests、`artifacts-v3/` 8/87、`artifacts-v4/` 9/94、`artifacts-v6/` 10/102 ⇒ **11 files/109 tests**（权威新副本 `artifacts-v7/adapter-suite.txt`）；4 份旧副本加 `SUPERSEDED BASELINE` 头并附新鲜输出 |
| **W7** 同算法同范围复算指纹 | **pass** | 复算 `91c689dd…`（149 文件），与报告值逐字符一致 |
| **W8** 指纹范围与算法写明 | **pass** | targets 9 项；排除 node_modules/.git 与 `demo/mini-service/.qgate/{evidence,reports}`；**不含 verification/**、verification-t9/**；算法=逐文件 sha256 → `<sha256>  <posix 路径>` 清单 → 排序 → sha256；`--code-only` 另跳 `packages/qgate/scripts/**` 与 `test/_probe-*.mjs` |

## 既有断言（v6 起沿用，本轮全部复跑通过）

断言 12（`preview-crosscheck` **ALIGNED / exit 0**，9/9 组）、V1 12/12、V2（`secretPathsExcluded=8`、无别名选中）、V3、V4、V5 6/6、V6、V7 夹具 3/3、V8、demo exit 0 / 根 exit 0（索引 16 条 `covered=false`=0）、同 cwd 规范化哈希一致、`--stage` 四阶段 valid + 未运行 gate 缺席 + 包络含 `not_run_gates`、trace 6/6 + valid、contract-fields mismatch 0、v3-cases 33/33、B1 30/30、B2 8/8、t42-verify 7/7、schema-eval（三份 valid + 反向 `file_exist` false）、BOM、未知键 4×exit 2、账本篡改 4×exit 3、空扫 failed。

## 三 cwd / 三入口 / CI / scripts

| 项 | 实测 |
|---|---|
| 适配层套件（canonical / junction / E:\Desktop） | **109/109/0** ×3 |
| `ocr-preview --json`（仅 stdout，四 cwd 含 `C:\`） | 同一 sha256 `0BC5CB5A…8AD3DE` |
| `npm test` ≡ `test:all` | **110/110/0** ≡ **110/110/0** |
| `test:contract` | 25/25/0 |
| 根 scripts | 11/11 exit 0 |
| CI 三段式（fresh scratch） | stage 0×4 → warm-up **1**（预期）→ `trace --write` 0 → 权威 **0** |

## 残余项（带 owner）

| id | 级别 | owner | 内容 |
|---|---|---|---|
| **F12** | medium | adapter-engineer | 适配层 `NET_MODULES` 缺 `dns`/`undici`，与引擎不同判；建议补词表 + 22 格对照回归 |
| F13 | low | architect | `gates/README` L173 的 `scanRoots` 行把「大小写不匹配不解析」写成无条件（本机 Windows 会解析；仅不存在的根 fail-closed） |
| F11 | low | adapter-engineer | D06/D04 理由串重叠 |
| T43-1 | low | captain | 根 `.qgate/out/**` 残留引用已删 scratch 配置 |
| F10 / audit-boundary | info | architect/captain | 交叉引用 / `covered=true` 审计边界声明 |

## 自查与留档

- **W6 的教训**：我的第一版重录把头里原始的 `共 N 个测试文件` 行保留下来，复验 grep 先命中旧值——已改为叙述式 `previous baseline: 10 test file(s), 102 test(s).` 并复验五份文件的首个 files 行均为 11/109。
- **W1 的夹具注意点**：Windows 大小写不敏感，`SECRETS/API.KEY` 会落进既有的 `Secrets/` 目录（实测显示 `Secrets/API.KEY`）；已在工具内注释，属夹具构造注意点而非产品缺陷。
- **W3/W4 的自建探针修正**：首版把「SKIP_DIRECTORIES 对照树应 passed=true」写成期望（实际空扫描集本就 fail-closed），以及把 Windows 上的 scanRoots 大小写解析当成产品失败——均已改为以 `filesScanned` 为核心判据，并把后者记为文档措辞项 F13。
