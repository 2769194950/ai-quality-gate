# verification-t9/report-v4 — t45 摘要（人类可读）

`generated_at` 2026-09-18T04:06+08:00 ｜ `tree_fingerprint` **ef3712333ac335d65c03adfc2ac999b31c544ebdb419a171446d120a55e19bb0**（147 文件，newest `packages/qgate/gates/README.md` 03:59:32；测量窗口前后多次复算一致）
`supersedes` `verification-t9/report-v3.json`（v3 与 t18 的 `report.json` 均保留不改）｜ cwd `E:\Desktop\ai-quality-gate`

## 结论

**pass 31 / fail 1 / blocked 1（共 33 = 23 项 + A1–A6 + B1–B4）**
**放行建议：可放行（release-ready）** —— 原 blocker（F1 硬链接别名）与原 high（F2 provider 静默回退）均已修复并经我独立复跑确认；唯一 fail 是 B4 的 F7（low：计数口径，token 未受影响）。

## 本轮增量

| 项 | 结论 | 证据 |
|---|---|---|
| **F1 改判** | **已修（t42）** | `t42-verify.mjs` 7/7；3/3 别名变体排除，理由 `hardlink_secret_alias:same-inode-as-sensitive-path`（身份链）。根因两个：① `inferDiffRoots()` 覆盖不到「diff 与仓库并列 / diff 在子目录、仓库是其父的兄弟」；② 旧「命中率<50% 即丢弃根」。我自建的**成因②**用例（diff 8 项含 6 个不存在路径，命中率 3/9）**原样保留**，别名仍被排除 |
| **B1** | **30/30 ✅** | 10 项安全判定 × 3 路径（`--diff` / `--root` / `--diff --root`）逐格复核，理由串逐格记录；D09 中性硬链接与 D10 普通文件按预期 selected（负向对照） |
| **B2** | **8/8 ✅** | 缺失/不可解析/空 recordings/无 recordings 键/scripted+缺失/llm+缺失 ⇒ exit 3 `PROVIDER_FAILED`；可用 fixture 与无 fixture 键 ⇒ exit 0；失败路径 provider=null，**不存在** `detail:"offline-fixture"` 静默回退 |
| **B3** | **pass** | L598 明示结构化 `not_run_gates` 只在 `--out` 包络；L618/624/634 两面样例且 4/3/2/1 逐字一致；§6.6 L1084/L1092/L1099 三面表；GAP-7 L998 前置；L1026-L1032 sha256 成对纪律；**L1108 过期注记已更新**（t41 修正、t44 复核） |
| **B4** | **fail（F7，low）** | 未物化路径进入 `included`/`selected[]`/`groups[].files`（各 6 个，size=0/tokens=0）；counts 9 vs 真实 3、groups 3 vs 2 ⇒ **计数类审计数字偏高 3 倍**；**token 未膨胀**（302 == 302，missingTokens=0）——captain 的「token 预算偏高」假设**不成立** |

## 其余断言（v4 复跑）

demo exit 0 / 根 exit 0（索引 16 条、`covered=false` 计数 **0**）；同 cwd 两运行规范化哈希一致（239 叶子仅 4 个运行时）；`--stage` 四阶段 RunResult `valid=true` ×4 且未运行 gate 缺席；trace 6/6 covered 且 schema valid；`contract-fields` mismatch **0**；`preview-crosscheck` 键集/安全/公式全绿（delta=[1]，14 对）；`v3-cases` **33/33 OK**（v3 的 2 个失败项已修）；`t42-verify` 7/7；schema-eval 三份 valid=true + 反向控制 valid=false（只用实际存在的 `five-stage.json`）。

## 三 cwd 计数与 CI / scripts

| cwd | 适配层套件 | ocr-preview stdout 哈希 |
|---|---|---|
| `E:\Desktop\ai-quality-gate` | 94/94/0 | `D04B3832…C15B8` |
| `E:\ai-quality-gate` | 94/94/0 | 同 |
| `E:\Desktop` | 94/94/0 | 同 |
| `C:\` | 未跑套件 | 同（路径键差异 0） |

CI（scratch 树，fresh）：stage requirements/design/build/review **0/0/0/0**；verify 三段式 warm-up **1**（预期，fail-closed）→ `trace --write` **0** → 权威 **0**（overall_passed=true，5/5 gate）。根 scripts **11/11 exit 0**；套件 `npm test` **106/106/0**、`test:contract` 25/25/0、适配层 94/94/0。
夹具：复位前 ledger 85（峰值 97）→ 复位后 3/runIds=2/testIds=14 → 冻结时同为 3/2/14。

## 残余项（含 owner）

| id | 级别 | owner | 内容 |
|---|---|---|---|
| F7 | low | adapter-engineer | 未物化 diff 路径计入 included/selected/groups，抬高计数类审计数字（token 正确） |
| B1-note | info | adapter-engineer | D06「不支持扩展名」与 D04「二进制扩展名」共用理由串 `binary_file:extension`，建议拆分以便逐项审计 |
| T43-1 | low | captain | 根 `.qgate/out/**` 残留引用已删除的 `examples/scratch.config.json` |
| audit-boundary | info | architect/captain | `covered=true` 仅证明承载 check 被执行，不代表根侧测试存在 |
| T29 | info | captain | t29 `needs_revision` 保留为信息性记录（阻塞点已由本轮复验覆盖） |

## 复核入口

```powershell
Set-Location E:\Desktop\ai-quality-gate
node -e "const r=require('./verification-t9/report-v4.json');if(!r.assertions||r.assertions.length<12)process.exit(1)"
node verification-t9/tools/b1-coverage-matrix.mjs     # B1：10×3，全绿
node verification-t9/tools/b2-provider-fixture.mjs    # B2：8 例
node verification-t9/tools/b4-unmaterialized.mjs      # B4：未物化路径影响
node verification-t9/tools/t42-verify.mjs             # F1 回归（含成因②用例）
node verification-t9/tools/v3-cases.mjs               # 负例/安全/篡改/H8/R1（33 例）
node verification-t9/tools/tree-fingerprint.mjs       # 应为 ef371233…
```

**冻结纪律留档**：`fingerprint_history` 现含 13 个指纹；其中 `f51bca35… → 06096768…`（17 s）与 `d6b32d50… → f9e0f497…`（11 s）两次变化直接证明树在写入，是本项目「不在变动树上出报告」纪律的证据。
