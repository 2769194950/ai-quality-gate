#!/usr/bin/env node
// verification-t9/make-report-v8.mjs — generates verification-t9/report-v8.json (t60).
// Counts are computed from the assertions array so the summary can never disagree with it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFingerprint, SCOPE } from './tools/tree-fingerprint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CWD = 'E:\\Desktop\\ai-quality-gate';
const A = 'verification-t9/artifacts-v8';
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''));
const fp = computeFingerprint();

const v7 = readJson('verification-t9/report-v7.json');
const y1 = readJson(`${A}/y1-named-client-parity.json`);
const y2 = readJson(`${A}/y2-f13-scanroots.json`);
const y5n = readJson(`${A}/y5-bypass-windows-names.json`);
const y5t = readJson(`${A}/y5-table-integrity.json`);
const fresh = readJson(`${A}/baseline-freshness.json`);
const toolHashes = readJson(`${A}/tool-hashes-check.json`);
const pc = readJson(`${A}/preview-crosscheck.json`);
const cf = readJson(`${A}/contract-fields-warmup.json`);
const cf2 = readJson(`${A}/contract-fields-rootcheck.json`);
const freshLegend = `BASELINE-FRESHNESS current=${fresh.current_tree_fingerprint.slice(0, 12)} files=${fresh.pointer_files} fresh=${fresh.fresh} superseded=${fresh.superseded} stale=${fresh.stale} tampered=${fresh.tampered} count_drift=${fresh.count_drift}`;

const HEADER_SAMPLE = [
  '# evidence: adapter-suite-baseline',
  '# format: pointer+hash v1',
  '# status: RECORDED',
  '# record_command: node adapters/opencodereview/tools/run-tests.mjs',
  '# record_cwd: E:\\Desktop\\ai-quality-gate',
  '# record_at_utc: 2026-09-18T02:55:39.951Z',
  '# tree_fingerprint: 74a28c906b7337967bf2d1aa6c0fb33c0cf5eac18277f1544e59d123b6540bc3',
  '# tree_fingerprint_files: 152',
  '# fingerprint_tool: node verification-t9/tools/tree-fingerprint.mjs',
  '# expected: testFiles=14;tests=131;pass=131;fail=0;exit_code=0',
  '# exit_code: 0',
  '# argv_json: ["node","adapters/opencodereview/tools/run-tests.mjs"]',
  '# content_sha256: 8f01b6d62777a785917c2cca2b05ee5deceb5d7d6eb3f038c4f2abada76c9d64',
  '# freshness_rule: FRESH iff recomputed tree_fingerprint == tree_fingerprint above AND content_sha256 matches the payload;',
  '#   check with: node verification-t9/tools/evidence-pointer.mjs check verification-t9/artifacts-v8/adapter-suite.txt [--deep]   (0 FRESH / 1 STALE / 2 TAMPERED)',
  '# note: t60/X2 re-record; previous authoritative copy verification-t9/artifacts-v7/adapter-suite.txt = 11 files / 109 tests (t55)',
  '# --- payload (content_sha256 covers the bytes after this line) ---',
  'run-tests: 共 14 个测试文件（进程内执行） ...',
].join('\n');

const a = (id, claim, command, expected, actual, status, evidence) => ({ id, claim, command, cwd: CWD, expected, actual, status, evidence });

const assertions = [
  // ─────────────────────────────── X: evidence hygiene (the root fix) ───────────────────────────────
  a('X1', 'The live-data baseline is demoted to a POINTER + CONTENT HASH so its expiry is machine-decidable instead of depending on someone remembering to re-record',
    'node verification-t9/tools/evidence-pointer.mjs check verification-t9/artifacts-v8/adapter-suite.txt [--deep] ; node verification-t9/tools/baseline-freshness.mjs --deep',
    'each pointer file carries record_command + tree_fingerprint + content_sha256, and one command yields FRESH/STALE/TAMPERED as an exit code',
    `**pass**。六个文件统一改为 pointer+hash v1：\`artifacts-v8/adapter-suite.txt\`（status=RECORDED，14 文件/131 用例）+ \`artifacts/adapter-suite.txt\`、\`artifacts-v3/v4/v6/v7/adapter-suite.txt\`（status=SUPERSEDED，adopted 转换，payload 字节未改）。判定只做三件事：重算 \`tree_fingerprint\`、复算 payload \`content_sha256\`、（\`--deep\`）按 header 里的 \`argv_json\` 重跑并比 counts。实测：authoritative FRESH exit 0；五个 SUPERSEDED exit 0（只校验完整性，不把历史修订当过期）；四个自建负例 STALE=1 / TAMPERED=2 / COUNT-DRIFT=1 / UNPARSABLE=3。改后格式样例见本报告 \`x1_pointer_format_sample\`。`,
    'pass', [`${A}/adapter-suite.txt（HTTP 头 + payload）`, `${A}/baseline-freshness.json`, `${A}/pointer-negatives/n1-stale.txt`, `${A}/pointer-negatives/n2-tampered.txt`, `${A}/pointer-negatives/n3-countdrift.txt`, `${A}/pointer-negatives/n4-nomarker.txt`]),
  a('X2', 'Re-record the adapter baseline to the current truth and record before → after',
    'node adapters/opencodereview/tools/run-tests.mjs ; node verification-t9/tools/evidence-pointer.mjs record verification-t9/artifacts-v8/adapter-suite.txt ...',
    'current truth 14 test files / 131 cases, with before → after recorded',
    `**pass**。before = **11 文件 / 109 用例**（v7 权威副本的 payload 实测，记于 tree_fingerprint 91c689dd…）；after = **14 文件 / 131 用例 / pass 131 / fail 0 / exit 0**（本轮实测，三 cwd 一致）。中间态 13/121（t56）、14/131（t58）**是转述 t56/t58 的报告，非我在该修订上的实测**，已在 \`x2-baseline-rerecord.json\` 里逐条标 \`measured_by_verifier\`。当前 14 个测试文件名与 131 计数见 artifacts-v8/adapter-suite.txt 的 payload 与 \`adapter-suite-current.txt\`。`,
    'pass', [`${A}/x2-baseline-rerecord.json`, `${A}/adapter-suite.txt`, `${A}/adapter-suite-current.txt`, `${A}/adapter-suite-3cwd.json`]),
  a('X3', 'Baseline freshness becomes a check-list item with a one-line machine comparison (catches "hand-cleaned file whose content is stale")',
    'node verification-t9/tools/baseline-freshness.mjs --deep ; node verification-t9/tools/tool-hashes-check.mjs',
    'one line per run; non-zero exit when any authoritative pointer is stale/tampered/count-drifted, or when a pinned verifier tool drifted',
    `**pass**。数据侧一行：\`${freshLegend}\`（exit 0）；负例侧：把 v7 副本的 \`status\` 改成 RECORDED 后立刻变 STALE exit 1，把 payload 里 \`tests 131\` 改成 999 后变 TAMPERED exit 2，把 header 的期望值改成 999 后 \`--deep\` 报 COUNT-DRIFT exit 1 —— 即「文件看起来干净但内容过期」会被抓出。工具侧新增 \`tool-hashes-check.mjs\`：${toolHashes.entries} 条 pinned 哈希全 MATCH（drift 0 / missing 0）exit 0；受控负例（给 \`tools/trace-check.mjs\` 追加一行注释）→ \`DRIFT tools/trace-check.mjs\` exit 1，按字节备份还原后 exit 0 且 sha256 与改动前逐字符相同。注：manifest 由 verifier 可再生（与任何基线一样），它的价值是**漂移可判定**，不是「重钉不可能」。`,
    'pass', [`${A}/baseline-freshness.json`, `${A}/tool-hashes-check.json`, `${A}/verifier-tool-hashes.json`, `${A}/tool-hashes-drift-negative.txt`]),
  a('X4', 'Choose a side for `tree_fingerprint` scope w.r.t. `adapters/opencodereview/test/**`, state the reason, and update `fingerprint_scope_and_algorithm`',
    'node verification-t9/tools/tree-fingerprint.mjs --scope-json ; node verification-t9/tools/tree-fingerprint.mjs [--product-only]',
    'an explicit decision + a documented process, not an implicit side effect',
    `**选 (b)：权威指纹保留 test 树，并把「指纹变 ⇒ 基线必重录」写成显式流程**。理由：选项 (a)（把 \`adapters/opencodereview/test/**\` 排除）会让新鲜度检查**恰好瞎在它必须捕获的那个事件上** —— 增/删/改一个测试文件会改变被录的 testFile/test 计数，却不改变「对测试不敏感」的指纹，于是过期的基线会被判 FRESH。代价如实登记：任何测试改动都会让权威指针变 STALE（这是 fail-closed 方向）。补充信号（非权威）：\`--product-only\` 排除任何 \`test/\` 段，本轮 122 文件 / \`c39cf8e6…\`，仅用于「两修订只差测试树」的说明。\`fingerprint_scope_and_algorithm\` 已由工具的 \`--scope-json\` **生成**（不再手抄），本轮实测默认 152 文件 / 74a28c90…。`,
    'pass', [`${A}/fingerprint-scope.json`, `verification-t9/tools/tree-fingerprint.mjs（SCOPE 常量 + --scope-json）`]),

  // ─────────────────────────────── Y1: F14 verification ───────────────────────────────
  a('Y1', 'F14 re-check with SELF-BUILT cells: named network client calls agree, benign controls have zero false positives, and the two deliberately-stricter adapter cells still report',
    'node verification-t9/tools/y1-named-client-parity.mjs [--json]',
    '≥12 cells incl. ≥3 benign controls and ≥2 name collisions; both layers same verdict on client calls; zero false positives; XMLHttpRequest()/WebSocket() still reported by the adapter',
    `**pass**（自建 60 格，全部按声明方向成立）。client_call **20/20 两侧都报**（12 个客户端名 × 成员 + \`axios.post\`/\`client.request\`/\`httpAgent.connect\`/\`got.send\`/\`fetch\` 全局控制 + 跨行模块成员面）；**良性对照 20/20 零误报**（含 \`new Map().get\`、\`this.cache.get\`、\`headers.get\`、闭合块注释、字符串/模板字面量与行注释）；碰撞 **6/6 两侧都报**（\`request\`/\`client\` 同名继承引擎 fail-closed 取舍）；非 HTTP 成员 5/5 两侧都不报。**本层刻意更严的 2 条仍报**且方向未被「同判」抹掉：\`new XMLHttpRequest()\` / \`new WebSocket('wss://…')\` = adapter true / engine false（via=\`global-network-call\`），该方向的回归用例在适配层套件里也是绿的。同时新发现 **6 格本层更松**（见 F15/F16）与 1 格两侧都漏（\`fetch\\n(url)\`），均按方向如实登记，未当成 pass 掩盖。`,
    'pass', [`${A}/y1-named-client-parity.json`]),

  // ─────────────────────────────── Y2: F13 verification ───────────────────────────────
  a('Y2', 'F13: verify the t59/t61 document fix is truthful and independently reproduce N1 and the two filesystem semantics',
    'node verification-t9/tools/y2-f13-scanroots.mjs [--json] ; read packages/qgate/gates/README.md L172/L173 + Boundary 6 (L181-L204) ; read docs/01-architecture.md GAP-7',
    'platform-dependent wording + basis of the case-sensitive figures + explicit disclosure that no Ubuntu run was claimed; N1 reproduced',
    `**pass**（依赖已终态：t59 completed、t61 completed）。① **N1 独立复现**：\`scanRoots:['NOPE','src']\` ⇒ \`filesScanned=1, check_passed=true, exit 0\` —— 空扫守卫确实是**聚合**而非逐根。② 只含不存在根 ⇒ \`filesScanned=0\` + \`empty scan set\` 违规 + exit 1（这正是「大小写敏感文件系统上错拼根」走的同一条代码路径：readdir/stat 失败 ⇒ 该根贡献 0 文件）。③ 原生 NTFS 上 \`['SRC']\` **解析到 \`src\`** ⇒ filesScanned=1、exit 0，且证据里保留**配置拼写** \`SRC/app.mjs\`（与 README L192-L194 一致）。④ \`expectedFiles:['NOPE/app.mjs']\` ⇒ 记 \`declared scan target not found\` + 空扫失败，**绝不静默通过**。⑤ 代码依据自查：\`checks/policy.mjs\` L38-L42 用 \`absOf\`+\`fileExists\`（\`util/fsx.mjs\` L34，纯 existsSync），\`scanSurface/scanCandidates\` L463/L497 只做反斜杠与 \`./\` 归一、**无大小写折叠**。⑥ 文档披露为**真**：\`wsl -l -v\` 实测返回 \`E_ACCESSDENIED\`、\`fsutil file setCaseSensitiveInfo\` 实测返回 \`Access is denied (0x5)\` —— 与 Boundary 6 「No Ubuntu/Linux run is claimed」一致。`,
    'pass', [`${A}/y2-f13-scanroots.json`, 'packages/qgate/gates/README.md L172-L173/L181-L204', 'docs/01-architecture.md GAP-7 L1026']),

  // ─────────────────────────────── Y3: three baselines ───────────────────────────────
  a('Y3', 'Three baselines: engine suites, demo/root configs, three-cwd adapter suite, four-cwd ocr-preview stdout parity',
    'npm test ; npm run test:all ; npm run test:contract ; npm run check ; node packages/qgate/bin/qgate.mjs check --config qgate.config.json --json ; node adapters/opencodereview/tools/run-tests.mjs（3 cwd）; node …/ocr-preview.mjs --diff … --rule … --json（4 cwd）',
    '110/110/0, 110/110/0, 25/25/0; demo exit 0 5 of 5; root exit 0; adapter 14 files/131 cases at 3 cwds; one identical stdout hash at 4 cwds',
    `**pass**。引擎：\`npm test\` **110/110/0 exit 0**、\`npm run test:all\` **110/110/0 exit 0**、\`npm run test:contract\` **25/25/0 exit 0**。demo \`check --config demo/qgate.config.json\` \`overall_passed=true\`、5 gate 全 passed、exit 0；根配置同命令 \`overall_passed=true\`、exit 0。适配层（绝对路径调用，故 cwd 无关）：仓库根 / junction / \`E:\\Desktop\` 三处均 **14 文件 / 131 tests / 131 pass / 0 fail / exit 0**。\`ocr-preview --json\` 在 canonical / junction / \`E:\\Desktop\` / \`C:\\\` 四处（仅 stdout，18315 B）sha256 **同为 \`F445867EB613FED4D3BC489A5C1ECEC345C277DC174B1A404A047C995CA03F77\`**（较 v7 的 0BC5CB5A… 变化，原因是 t56/t58 改了 payload，属预期；四 cwd 一致这一性质未变）。`,
    'pass', [`${A}/engine-suite-test.txt`, `${A}/engine-suite-test-all.txt`, `${A}/engine-suite-test-contract.txt`, `${A}/demo-check.json`, `${A}/root-check.json`, `${A}/adapter-suite-3cwd.json`, `${A}/cwd-parity.json`]),

  // ─────────────────────────────── Y4: full regression ───────────────────────────────
  a('Y4', 'Full regression: no v7 assertion may fall back',
    'node verification-t9/tools/<each tool>.mjs --json ; plus the CLI/Negative battery (see each carried assertion)',
    'every v7 assertion re-measured on this revision, or explicitly marked as carried-with-reason',
    `**pass（无回退；W4 由 fail 转 pass）**。19 个 verifier 工具全部 exit 0（w12 / w3 / w45 / v1 / v2 / v3 / b1 / b2 / b4 / v5 / t42 / contract-fields / schema-eval / schema-meta / trace-check / fixture-diff / preview-crosscheck / hardlink-probe / baseline-freshness）。**W4 翻转**：\`w45-net-parity\` 的 22 格词表扫描 \`sweepDisagreements=[]\`、12 格形态采样 \`verdictsAgree=true\` ⇒ F12（t56）真修。**本轮还自查出断言 9 此前是「静默跳过」**：\`contract-fields\` 的默认 \`--runresult\` 指向不存在的文件且整段运行时比对被 \`if (fs.existsSync(...))\` 包着 ⇒ 报 \`mismatches:0\` 却是空转。已修（缺失输入 fail-closed exit 3），并用**两个真实 RunResult** 重测：通过态（root-check，5 gate/18 check/48 evidence，blocker 与 humanGate 如实标 \`match:null\`=未触发）与失败态（ci-warmup，1 blocker 对象 ⇒ blocker 字段集**真实比对** match=true）均 \`mismatches=0\`。`,
    'pass', [`${A}/w12-engine-case.json`, `${A}/w45-net-parity.json`, `${A}/contract-fields-rootcheck.json`, `${A}/contract-fields-warmup.json`, `${A}/preview-crosscheck.json`, `${A}/v3-cases.json`]),

  // ─────────────────────────────── Y5: new bypass attempt + README table ───────────────────────────────
  a('Y5', 'At least one NEWLY constructed bypass attempt, plus a re-check of the t58 in-passing README §4 invariant-table fix (G1 row) and its rendering',
    'node verification-t9/tools/y5-bypass-windows-names.mjs [--json] ; node verification-t9/tools/y5-table-integrity.mjs [--json]',
    'a new bypass family actually attempted and reported with its direction; §4 table renders and G1 is its own row',
    `**pass（两半都做）**。① 新绕过族 = **路径拼写规范化**：自建 25 种拼写（大小写、尾随点/空格、前导空格、\`./\` 与 \`.\\\` 前缀、\`..\` 穿越、NTFS ADS \`::$DATA\`/\`::stream\`、8.3 短名 \`CREDEN~1.JSON\`）在**最宽 include \`**/*\`** 下跑适配层权威选择器 \`selectFiles()\`：**无一敏感材料被纳入**（按 inode 比对，\`admittedSensitive=[]\`、\`safety.no_sensitive_selected=true\`、\`sensitive_paths_never_reincludable=true\`）；引擎侧 \`policySafe002\` 在同一批变体根上 \`passed=true\` 且 \`secretPathsExcluded=8\`（对照根 1）⇒ 两侧都未纳入任何变体拼写。同时如实登记 5 处**名字规则漏判**（\`.env \`、\` .env\`、\`.env::$DATA\`、\`.env::stream\`、\`CREDEN~1.JSON\`）与 on-disk 事实（本机 Node/NTFS 下 \`.env.\`、\`.env \` 是**独立目录项**，不会被自动剥离），见 F17。② README §4 不变量表：**11 行** \`["S1","S2","S3","S4","G1","G2","G3","G4","S5","S6","S7"]\`，**G1 已是独立行**（不再并入 S4），该表每行 5 根管道一致；全文件 24 张表 / 191 行 **brokenRows=0**（其中一处 \`auto\\|single\\|per-file\` 的转义管道最初被我自己的检查器误判，已修检查器，见 self_repairs）。`,
    'pass', [`${A}/y5-bypass-windows-names.json`, `${A}/y5-table-integrity.json`, 'adapters/opencodereview/README.md L346-L360']),

  // ─────────────────────────────── carried v7 assertions (re-measured) ───────────────────────────────
  a('W1', 'R3-B1: engine secret-path rules are case-insensitive; every sensitive entry is excluded by the sensitive-name rule, NOT by the extension whitelist',
    'node verification-t9/tools/w12-engine-case.mjs --json', 'both isomorphic trees clean; every sensitive exclusion carries reason=secret_path + a secret-* rule',
    `**pass**（本轮复跑）：\`upperIncludedClean=true\`、\`lowerIncludedClean=true\`、\`includedSetsIsomorphic=true\`、\`secretCountsEqual=true\`、\`saf002PassedBoth=true\`、\`everySensitiveReasonIsSensitiveNotExtension=true\`、\`invariantsCleanBoth=true\`。`, 'pass', [`${A}/w12-engine-case.json`]),
  a('W2', 'R3-H1 retest with an UPPER-CASE sensitive target, using the accurate reason/rule shape',
    'node verification-t9/tools/w12-engine-case.mjs --json（w2 块）', 'alias excluded with reason=secret_path and rule=<alias:…>',
    `**pass**：\`aliasExcluded=true\`、\`reasonIsFrozenSecretPath=true\`、\`ruleIsAliasOfCredentials=true\`、\`reasonIsNotAdapterVocabulary=true\`、\`countIsTwo=true\`；自建旁路 \`CREDENTIALS.JSON → Handbook.txt/MANUAL.TXT\` 亦 \`bothAliasesExcluded=true\`、\`aliasesUseIdentityChain=true\`。`, 'pass', [`${A}/w12-engine-case.json`]),
  a('W3', 'Spot-check the t53 per-item audit table (≥4 rows) and reproduce the two deliberately-unchanged rationales',
    'node verification-t9/tools/w3-audit-rows.mjs --json ; read packages/qgate/gates/README.md L163-L175', '≥4 rows match measurement',
    `**pass**：\`rows=4\`、\`allRationalesHold=true\`（含用户 \`selection.extensions\` 与扫描面 \`SKIP_DIRECTORIES\` 两处「刻意不改」的实证）。`, 'pass', [`${A}/w3-audit-rows.json`]),
  a('W4', 'R3-L3 / F12: bare network-module imports are judged the same by engine and adapter (self-built samples + module-vocabulary sweep)',
    'node verification-t9/tools/w45-net-parity.mjs --json', 'no disagreement on either the 12 syntactic samples or the 22-cell vocabulary sweep',
    `**pass（v7 为 fail，本轮翻转）**：\`samples=12\`、\`verdictsAgree=true\`、\`allMatchExpectation=true\`、\`disagreements=[]\`、\`boundaryLoosened=[]\`、\`sweepSamples=22\`、**\`sweepDisagreements=[]\`** ⇒ t56 补的 dns/undici 词表已与引擎同判。`, 'pass', [`${A}/w45-net-parity.json`]),
  a('W5', 'The t54 boundaries were not loosened', 'node verification-t9/tools/w45-net-parity.mjs --json（W5 块）', 'clean samples stay clean',
    `**pass**：\`boundaryLoosened=[]\`（5 条良性样本两侧均不报）。`, 'pass', [`${A}/w45-net-parity.json`]),
  a('W6', 'Re-record the stale adapter baseline (now as a pointer, and freshness-checked rather than remembered)',
    'node adapters/opencodereview/tools/run-tests.mjs ; node verification-t9/tools/baseline-freshness.mjs --deep', 'baseline matches the current revision and can be shown to be fresh by one command',
    `**pass**：权威指针 = \`artifacts-v8/adapter-suite.txt\`（14/131，tree_fingerprint 74a28c90…）；\`${freshLegend}\`。旧副本转为 SUPERSEDED 指针（保留可读 payload）。`, 'pass', [`${A}/adapter-suite.txt`, `${A}/baseline-freshness.json`]),
  a('W7', 'Recompute tree_fingerprint with the same algorithm and file scope', 'node verification-t9/tools/tree-fingerprint.mjs', 'identical to the value in this report',
    `**pass**：窗口前 10:57 与窗口后 11:1x（间隔 ≥8s，两次采样）均为 **${fp.fingerprint}**，${fp.fileCount} 文件，newest \`${fp.newest.path}\`；与报告值逐字符相同。`, 'pass', [`${A}/fingerprint-scope.json`]),
  a('W8', 'Document the fingerprint scope and algorithm so a reader can recompute it', 'node verification-t9/tools/tree-fingerprint.mjs --scope-json', 'scope + algorithm stated, including the X4 decision',
    `**pass**：本报告 \`fingerprint_scope_and_algorithm\` **由工具的 \`--scope-json\` 输出生成**（targets 9 项；排除 node_modules/.git 与 demo 的 .qgate/{evidence,reports}；不含 verification/** 与 verification-t9/**；算法 = 逐文件 sha256 → 排序清单 → 清单 sha256），并含 X4 的选择与流程后果。`, 'pass', [`${A}/fingerprint-scope.json`]),
  a('12', '§6.2.1/§6.2.2 key-set consistency via parsed tables', 'node verification-t9/tools/preview-crosscheck.mjs --json --artifacts verification-t9/artifacts-v8', 'ALIGNED, exit 0, no DIFF group',
    `**pass**：\`verdict=aligned\`、\`diffs=0\`、9/9 组 \`match=true\`（引擎顶层 8 键 / 引擎 ruleMatch 7 键 / 适配层 ruleMatch·selected·excluded·groups·selection 均与 docs 解析出的冻结表一致，docLines 872-999）、3 条安全场景 \`invariantHolds=true\`、§6.2.2.4 优先级公式 \`deltas=[1]\`。工具默认 \`--artifacts\` 原指向已被取代的 v5，本轮已改为**必填**（缺失即 exit 3）。`, 'pass', [`${A}/preview-crosscheck.json`]),
  a('V1', 'Unterminated `/*` / `://` blind spots (CLI layer, self-built 12 cases)', 'node verification-t9/tools/v1-comment-boundary.mjs --json', '12/12 as declared',
    `**pass**：\`cases=12\`、\`failures=[]\`。`, 'pass', [`${A}/v1-comment-boundary.json`]),
  a('V2', 'Engine-side hardlink identity chain (self-built aliases + neutral control)', 'node verification-t9/tools/v2-engine-identity.mjs --json', 'alias excluded, neutral control still selected',
    `**pass**：\`ok=true\`、\`previewCoversAliases=true\`、\`checkCoversAliases=true\`、\`invariantsClean=true\`、\`neutralStillSelected=true\`（5 别名 vs 中性对照 \`plain.txt\`/\`copy.txt\`）。`, 'pass', [`${A}/v2-engine-identity.json`]),
  a('V3', 't47 §8.3.2 boundary list', 'read docs/01-architecture.md L1294-L1317', 'six items present',
    `**pass**（沿用 v6/v7 核对；本轮 §8.3.2 未变，另本轮实测「未闭合 /* + 名规则漏判」等新证据与该边界一致，未发现过期句）。`, 'pass', ['docs/01-architecture.md L1294-L1317']),
  a('V4', 'Signal asymmetry documented in all three places', 'read docs §8.3.2 / adapters README / gates README', 'asymmetry truthful, no stale sentence',
    `**pass**：docs L1309 如实、适配层 README L367/L385-L394 如实（本轮 §4 表格与其后说明已重新渲染校验）、gates/README 不声称两侧相同。`, 'pass', ['docs/01-architecture.md L1309', 'adapters/opencodereview/README.md L367-L396']),
  a('V5', 'Unmaterialised-path counting', 'node verification-t9/tools/v5-counting.mjs --json', 'counts aligned, token logic unchanged',
    `**pass**：\`ok=true\`、\`countsAligned=true\`、\`groupFileCountAligned=true\`、\`unmaterialisedQueryable=true\`、\`selectedFlagsPresent=true\`、\`tokenLogicUnchanged=true\`、\`contractSurfaceUnchanged=true\`。`, 'pass', [`${A}/v5-counting.json`]),
  a('V6', 'Adapter README single main criterion + t42 content preserved', 'read adapters/opencodereview/README.md', 'single statement, no contradictory sentence',
    `**pass**：L367 唯一说法仍成立（「身份链优先、内容形态兜底」），§4.2 两处指向 t42 的两布局对照表保留；表格完整性见 Y5。`, 'pass', ['adapters/opencodereview/README.md L367-L414']),
  a('V7', 'Adapter fixtures reproduce under the authoritative scrubber', 'node verification-t9/tools/fixture-diff.mjs --json', '3/3 equal',
    `**pass**：\`preview.default.json\`/\`preview.token-budget-300.json\`/\`selection.default.md\` 三夹具 \`equal=true\`、\`firstDifference=null\`（58/58 行）。`, 'pass', [`${A}/fixture-diff.json`]),
  a('V8', 'Verifier self-repair recorded (fixture-diff uses the adapter authoritative scrubber)', 'read verification-t9/tools/fixture-diff.mjs', 'imports portable.mjs, no local partial copy',
    `**pass**：L16 \`import { portableize, portableizeText } from '../../adapters/opencodereview/test/portable.mjs'\`（L21/L22 直接使用），无二次实现。`, 'pass', ['verification-t9/tools/fixture-diff.mjs L16/L21-L22']),
  a('1', 'demo five-stage gate', 'node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --json', 'exit 0, overall_passed, 5 of 5',
    `**pass**：\`overall_passed=true\`、gates 5 全 passed、exit 0。`, 'pass', [`${A}/demo-check.json`]),
  a('2', '`--summary` human table', 'node packages/qgate/bin/qgate.mjs check --config demo/qgate.config.json --summary ; … --config qgate.config.json --summary', 'human table with one row per gate',
    `**pass**：demo 5 行 + 表头（requirements/design/build/review/verify 全 true/0 blockers），根配置同构 5 行，\`overall_passed=true\`。`, 'pass', [`${A}/demo-summary.txt`]),
  a('3', 'same-cwd determinism', 'two consecutive demo `check --json` runs + node verification-t9/tools/normalize-runresult.mjs', 'normalized-equal=true',
    `**pass**：两次运行规范化后同哈希 \`e64e0d7c…\`、\`droppedKeys=["duration_ms","finished_at","run_id","started_at"]\`、\`leakedPrefix=null\`、\`normalized-equal=true\`。`, 'pass', [`${A}/determinism.txt`, `${A}/run1.json`, `${A}/run2.json`]),
  a('4', 'determinism split + offline', 'env inspection + the whole battery run without network access', 'no API key required, no network call',
    `**pass**：环境变量中无任何 \`*KEY*/*TOKEN*/*SECRET*/*ANTHROPIC*/*OPENAI*/*OCR_*\`（实测为空集）；全部断言在离线状态下通过；\`ocr-preview\` 输出 \`provider=local degraded=true(OCR_CLI_NOT_FOUND)\` 即无外部 CLI 也降级成功。另本轮新发现：SAFE_002 的扫描集把 \`verification-t9/**\` 计入（F19），这与「离线/确定性」无关但影响 RunResult 文本稳定性 —— 已如实登记。`, 'pass', [`${A}/demo-check.json`, `${A}/cwd-parity.json`, 'env probe（无密钥变量）']),
  a('5', 'negative case A (real exit code)', 'node verification-t9/tools/v3-cases.mjs --json（negA 组）', 'missing evidence ⇒ exit 1；intact control ⇒ exit 0',
    `**pass**：\`negA_missing_evidence_file\` status=1、\`negA_control_intact\` status=0。`, 'pass', [`${A}/v3-cases.json`]),
  a('6', 'negative case B (real exit code)', 'node verification-t9/tools/v3-cases.mjs --json（negB 组）', 'invalid configs ⇒ exit 2',
    `**pass**：\`negB1_missing_version\`/\`negB2_bad_check_type\`/\`negB3_config_not_found\` 三例 status=**2/2/2**。`, 'pass', [`${A}/v3-cases.json`]),
  a('7', 'adapter security decisions 10×3', 'node verification-t9/tools/b1-coverage-matrix.mjs --json ; node verification-t9/tools/hardlink-probe.mjs --json', '30/30 and 3/3 aliases excluded',
    `**pass**：B1 矩阵 \`cellCount=30\`、\`okCount=30\`、\`failures=[]\`；硬链接探针 3/3 变体 \`aliasSelected=false\`、\`exit=0\`。`, 'pass', [`${A}/b1-coverage-matrix.json`, `${A}/hardlink-probe.json`]),
  a('8', 'traceability', 'node verification-t9/tools/trace-check.mjs --trace verification-t9/artifacts-v8/trace.json --json', 'covered=true for every requirement, summary counters consistent',
    `**pass**：\`allChecksPass=true\`、\`requirements=6 covered=6 uncovered=0 orphanTestIds=0 coverageRatio=1\`、13 项一致性检查全 true、与 v7 的 requirements 集合逐项相同。工具原先**硬编码** v7 trace（且自己报的 \`traceFile\` 也是那个硬编码路径），本轮改为 \`--trace\` 必填 + 缺失 fail-closed，并让 \`traceFile\` 如实回显输入。`, 'pass', [`${A}/trace-check.json`, `${A}/trace.json`]),
  a('9', 'field-surface consistency', 'node verification-t9/tools/contract-fields.mjs --runresult verification-t9/artifacts-v8/{root-check,ci-warmup}.json --json', 'mismatch 0 against doc + schema + a REAL RunResult',
    `**pass（但 v7 的方法有缺陷，本轮已修并重测）**：根因是工具默认 \`--runresult\` 指向不存在的 \`artifacts-v7/runresult-1.json\`，而运行时比对整段被 \`if (fs.existsSync(...))\` 包着 ⇒ 缺文件时静默跳过却报 \`mismatches: 0\`（**静默跳过被读成通过**）。修复后 fail-closed（无参/文件缺失均 exit 3），并以真实 RunResult 重测：root-check（通过态）top/gate \`match=true\`、blocker/humanGate 显式 \`match:null\`（未触发，附注说明）；ci-warmup（失败态，1 blocker）blocker 字段集 \`match=true\`；两者 \`mismatches=0\`。`, 'pass', [`${A}/contract-fields-rootcheck.json`, `${A}/contract-fields-warmup.json`]),
  a('10', 'unverifiable items marked blocked', '(record)', 'not written as pass',
    `**blocked**（7 项，逐项给出具体原因）：① GitHub Actions 真跑（无 runner/网络）；② 真正的干净 clone（工作区无 VCS）—— 本轮以 fresh scratch 树重放 CI 顺序作为**近似**（见断言 19），仍不称「clone」；③ 跨任务「未触碰」声称的独立基线（无 VCS，只能用同一会话内的成对 sha256）; ④ \`§9.1 approval.json\` 无 schema，无法做 schema 级校验；⑤ 字面量 \`node --test <dir>\`（沙箱 piped stdio EPERM），等价入口 \`run-tests.mjs\`；⑥ **NTFS 8.3 短名生成策略**（\`fsutil 8dot3name query\` 实测 \`Access is denied\`）⇒ \`CREDEN~1.JSON\` 只能按「字面文件名」登记，无法判定它是否可能是敏感文件的 8.3 别名；⑦ **大小写敏感文件系统**（\`wsl -l -v\` = E_ACCESSDENIED、\`fsutil file setCaseSensitiveInfo\` = Access denied）⇒ 该列由代码路径 + 不存在根模拟，文档已如实披露。`, 'blocked', [`${A}/y5-bypass-windows-names.json`, `${A}/y2-f13-scanroots.json`]),
  a('11', 'four schemas + three-config positive/negative', 'node verification-t9/tools/schema-eval.mjs --json ; node verification-t9/tools/schema-check-v3.mjs …', '3 valid + 1 invalid; 4 real artifacts valid',
    `**pass**：四份 schema 存在且被真实求值（3 个正例 \`valid=true\`、反向 \`file_exist\` \`valid=false\`）；真实产物 schema 校验 demo-check/root-check/stage-build（run-result）与 trace（trace-matrix）**4/4 valid=true errors=0**。`, 'pass', [`${A}/schema-eval.json`, `${A}/schema-checks.txt`]),
  a('13', '`--stage` legality + not_run_gates envelope', 'node packages/qgate/bin/qgate.mjs check --config qgate.config.json --stage <s> --json ; … --summary --out …', 'four stages valid; un-run gates absent from RunResult; envelope carries not_run_gates',
    `**pass**：四阶段 \`check --stage\` exit 0/overall_passed=true、RunResult 恰为 8 个冻结键且**无** \`not_run_gates\`；包络（\`--summary --out\`）键为 \`overall_passed,gates,not_run_gates,run_id,provider,approvals_missing\`，\`not_run_gates\` 长度依阶段 4/3/2/1（合计 10 = 未运行门禁数）。`, 'pass', [`${A}/stage-requirements.json`, `${A}/envelope-requirements.json`, `${A}/envelope-build.json`]),
  a('14', 'three entries + adapter suite', 'npm test / npm run test:all / npm run test:contract ; node adapters/opencodereview/tools/run-tests.mjs', 'all green',
    `**pass**：110/110/0、110/110/0、25/25/0；适配层 14 文件 / 131 用例 / 0 fail。`, 'pass', [`${A}/engine-suite-test.txt`, `${A}/adapter-suite.txt`]),
  a('15', 'output does not change the input', 'hash the demo input tree before/after a `check` run', 'input tree unchanged',
    `**pass**：\`demo/mini-service\` 输入树（排除引擎自身产物 \`.qgate/evidence\`、\`.qgate/reports\`）清单 sha256 \`c5218675…\` → 运行 check（exit 0）后仍 \`c5218675…\`，\`unchanged=true\`。`, 'pass', [`${A}/input-unchanged.txt`]),
  a('16', 'BOM tolerance', 'node verification-t9/tools/v3-cases.mjs --json（bom 组）', 'BOM-prefixed valid JSON accepted; BOM then invalid rejected with exit 2',
    `**pass**：\`bom_valid\` status=0、\`bom_then_invalid_json\` status=2。`, 'pass', [`${A}/v3-cases.json`]),
  a('17', 'three-cwd suites + four-cwd stdout parity', 'adapter suite at 3 cwds ; ocr-preview --json at 4 cwds (incl. `C:\\`)', 'identical counts and one identical stdout hash',
    `**pass**：三 cwd 计数一致（14/131/131/0）；四 cwd stdout 同哈希 \`F445867E…A03F77\`（18315 B，仅 stdout，stderr 另存）。`, 'pass', [`${A}/adapter-suite-3cwd.json`, `${A}/cwd-parity.json`]),
  a('18', 'GAP-7 (fixed `--config` ⇒ cwd-invariant)', 'absolute-config `check` from 3 cwds, captures written OUTSIDE the repo, then normalize', 'normalized-equal=true',
    `**pass（并纠正一个方法论陷阱）**：3 个 cwd（仓库根 / \`C:\\\` / \`E:\\Desktop\`）各跑一次，\`selected=643\` 三次相同，规范化后同哈希 \`42ff6556…\`、\`normalized-equal=true\`。**第一次测出 false 的原因是采集文件写在仓库内**：根配置没有 \`selection\`，SAFE_002 的扫描集包含 \`verification-t9/**\`，我把上一轮的采集 JSON 写进 \`artifacts-v8/\` 后，下一次运行的 \`selected\` 就 +1（585→633→634→635 逐次 +1，与写入文件数一一对应；对照实验：往 \`verification-t9/\` 加 1 个文件 ⇒ selected +1，往 \`verification/evidence/\` 加账本 ⇒ 不变）。已登记为 F19 并给出修法。`, 'pass', [`${A}/rootcwd-canonical.json`, `${A}/rootcwd-cdrive.json`, `${A}/rootcwd-desktop.json`, `${A}/absconfig-*.json`]),
  a('19', 'CI three-step on a fresh scratch tree', 'contract → check --stage {requirements,design,build,review} → full check (warm-up, expect 1) → trace --write → authoritative check', 'stage 0×4, warm-up 1 (expected), trace 0, authoritative 0',
    `**pass**：在 \`E:\\Desktop\\_t60-scratch\`（复制品，已剔除 \`.qgate/evidence\`、\`.qgate/reports\`，跑完已删除）实测 \`contract --json\` 0、四阶段 0/0/0/0、整流水线预热 **1**（唯一 blocker：\`TRACE_GAP: trace matrix is missing or not parseable JSON\`，verify 门禁 required+high）、\`trace --write\` 0、权威 check **0**（overall_passed=true，5/5）。与 workflow 注释所描述的依赖顺序一致。`, 'pass', [`${A}/ci-three-step.json`, `${A}/ci-warmup.json`, `${A}/ci-authoritative.json`, `${A}/ci-trace-write.txt`]),
  a('20', 'root scripts', 'npm run <11 scripts>', '11/11 exit 0',
    `**pass**：test / test:all / test:contract / check / check:json / check:summary / contract / trace / preview / report / verify **11/11 exit 0**。`, 'pass', [`${A}/root-scripts.json`]),
  a('21', 'prior security fix re-verification (t26/t28/t34/t39/t42/t43/t46/t53/t54/t56/t58)', 'w12 / w45 / hardlink-probe / t42-verify / b2 / v1 / v3-cases / y1 (fresh runs)', 'all still green',
    `**pass**：硬链接身份链 3/3 排除、t42 七例 \`ok\`、B2 provider 失败模式 8/8、V1 12/12、v3-cases 33 例（31 true + 2 信息态）、F12 词表同判、F14 客户端面 60 格按声明方向成立。另：本轮我自己也踩到并改掉了同类缺陷（工具默认读旧修订 / 缺输入静默跳过），见 \`self_repairs\`。`, 'pass', [`${A}/w12-engine-case.json`, `${A}/hardlink-probe.json`, `${A}/t42-verify.json`, `${A}/b2-provider-fixture.json`]),
  a('22', 'root config exit 0 and its justification', 'node packages/qgate/bin/qgate.mjs check --config qgate.config.json --json', 'exit 0, overall_passed=true',
    `**pass**：\`overall_passed=true\`、5/5 gate、exit 0（16 条需求全部 \`covered=true\`，\`covered=false\`=0 —— 由 trace 断言与 trace-check 的 \`missingFromIndex/missingFromTrace\` 空集共同支撑）。附带登记 F19（SAFE_002 的 \`selected\` 计数受 verifier 写入影响）。`, 'pass', [`${A}/root-check.json`, `${A}/trace-check.json`]),
  a('23', 'T-QG-007 / T-QG-015 real tests', 'Select-String in packages/qgate/test/*.test.mjs ; the suites themselves', 'file:line carriers exist and the suites are green',
    `**pass**：T-QG-007 承载于 \`packages/qgate/test/evidence-resolution.test.mjs\` **L57/L75/L103/L148/L174/L197/L221**（另 L1 文件头）；T-QG-015 承载于 \`packages/qgate/test/ci-template.test.mjs\` **L240/L258/L275/L291**（另 L1）；两份套件随 110/110 全绿。`, 'pass', ['packages/qgate/test/evidence-resolution.test.mjs', 'packages/qgate/test/ci-template.test.mjs']),
  a('A1', '`--summary --out` envelope carries not_run_gates; RunResult does not', '见断言 13', 'envelope-only key',
    `**pass**：包络含 \`not_run_gates\`（4/3/2/1），RunResult 8 键无该字段。`, 'pass', [`${A}/envelope-design.json`, `${A}/stage-design.json`]),
  a('A2', 'R1 fail-closed + controls', 'node verification-t9/tools/v3-cases.mjs --json（A2 组）', 'missing ledger basis ⇒ fail; intact/explicit-trace-only ⇒ pass',
    `**pass**：\`A2_R1_missing_ledger_basis\` status=1、\`A2_control_A_intact_basis\` status=0、\`A2_control_B_explicit_trace_only\` status=0。`, 'pass', [`${A}/v3-cases.json`]),
  a('A3', 'two kinds of self-certification separated', 'node verification-t9/tools/v3-cases.mjs --json（A3 组）', 'structural self-consistency ≠ root-side coverage closure',
    `**pass（按 v7 记账，含边界说明）**：\`A3_1_structural_self_certification\` status=0 且列出 ledger testIds 与 ran checkIds；\`A3_2_declared_covered_without_test\` 为信息态（无 status）。**边界仍然成立**：index 与 ledger 的 testIds 共享引擎的静态 \`checkTestIds\` 映射 ⇒ \`covered=true\` 只证明「承载 check 跑过」，不证明根侧覆盖闭合（audit-boundary，信息级）。`, 'pass', [`${A}/v3-cases.json`]),
  a('A4', 'H8 history must not mask the current config gap', 'node verification-t9/tools/v3-cases.mjs --json（A4 组）', 'deleting the carrying check ⇒ exit 1 with history intact',
    `**pass**：\`A4_control_history_intact_carrier\` status=0、\`A4_H8_deleted_carrying_check\` status=1。`, 'pass', [`${A}/v3-cases.json`]),
  a('A5', 'unknown keys rejected', 'node verification-t9/tools/v3-cases.mjs --json（unknown_key 组）', '4 × exit 2',
    `**pass**：provider/policy/selection/grouping 四处 unknown key 全部 status=**2**。`, 'pass', [`${A}/v3-cases.json`]),
  a('A6', 'comment-skip boundaries', 'node verification-t9/tools/v3-cases.mjs --json（A6 组）', 'comments are prose; real reads/other spellings/literals/expectedFiles behave as documented',
    `**pass**：6 例全按声明 —— \`comment_only_is_prose\` 0、\`real_code_env_read_detected\` 1、\`other_env_spellings_detected\` 1、\`string_literal_detected\` 1、\`expectedFiles_reincludes_markdown\` 1、\`empty_scan_set_must_fail\` 1。`, 'pass', [`${A}/v3-cases.json`]),
  a('B1', 'adapter 10×3 coverage matrix', 'node verification-t9/tools/b1-coverage-matrix.mjs --json', '30/30',
    `**pass**：\`cellCount=30\`、\`okCount=30\`、\`failures=[]\`。`, 'pass', [`${A}/b1-coverage-matrix.json`]),
  a('B2', 'provider.fixture failure modes', 'node verification-t9/tools/b2-provider-fixture.mjs --json', '8/8 as declared',
    `**pass**：\`cases=8\`、无 not-ok（含 fixture 缺失 exit 3、scripted 模块缺失 exit 3）。`, 'pass', [`${A}/b2-provider-fixture.json`]),
  a('B3', 't44 doc corrections', 'read docs/01-architecture.md (§6.6 / §5.2.1 / GAP-7)', 'present',
    `**pass**：§6.6 与 §5.2.1 关于 \`--summary\` 两个输出面（包络需 \`--out\`）的说明仍在；GAP-7 的比对前置条件本轮由 t61 补上「平台相关」限定（已在 Y2 独立核对）。`, 'pass', ['docs/01-architecture.md']),
  a('B4', 'unmaterialised paths do not pollute counts', 'node verification-t9/tools/b4-unmaterialized.mjs --json', 'groups must not carry missing paths; token sum not inflated',
    `**pass**：\`groupsCarryMissingPaths=false\`、\`tokenSumInflatedBy=0\`、\`tokenInflationPct=0\`、\`rootModeIncludedMissing=[]\`、\`rootModeTokenSum=302\`。`, 'pass', [`${A}/b4-unmaterialized.json`]),
];

const summary = {
  pass: assertions.filter((x) => x.status === 'pass').length,
  fail: assertions.filter((x) => x.status === 'fail').length,
  blocked: assertions.filter((x) => x.status === 'blocked').length,
};
summary.total = assertions.length;

const report = {
  task: 't60 — evidence-hygiene root fix (pointer+hash, kill recurring baseline expiry) + final release basis: F14/F13 re-check and full regression',
  kind: 'work',
  verifier: 'verifier',
  attempt_id: '1bac37d1-af12-4fde-8809-295d6eb088e5',
  generated_at: new Date().toISOString(),
  cwd: CWD,
  tree_fingerprint: fp.fingerprint,
  tree_fingerprint_file_count: fp.fileCount,
  tree_fingerprint_newest: fp.newest,
  tree_fingerprint_mode: 'default',
  supplementary_product_only_fingerprint: {
    fingerprint: 'c39cf8e69665609fda9e5d1652265b14e29dd867bb4f3ef65ddb7eea0566fab1',
    fileCount: 122,
    how: 'node verification-t9/tools/tree-fingerprint.mjs --product-only',
    role: 'SUPPLEMENTARY only: it excludes any path segment named test/tests/__tests__ and is used solely to show whether two revisions differ only in test trees. It is never the revision identity — see x4_decision.',
  },
  supersedes: 'verification-t9/report-v7.json',
  why_v8_exists:
    'v7 closed t55 and left four open debts: (a) the adapter baseline was a live-data snapshot inside a verifier-only directory, so its expiry was structural rather than accidental (57→87→94→102→109→121→131); (b) F12 (adapter vocabulary missing dns/undici) was fixed by t56 but never re-measured by the verifier; (c) F13 (scanRoots wording) was a proposal only; (d) t58 added the named-network-client surface (F14) after v7 froze. This report re-records the baseline as a pointer+hash, closes F12/F13/F14 by measurement, and adds the full battery on the frozen revision.',
  fingerprint_scope_and_algorithm: {
    generated_from: 'node verification-t9/tools/tree-fingerprint.mjs --scope-json (single authority; no hand-copied scope text)',
    ...SCOPE,
    revision: { fingerprint: fp.fingerprint, fileCount: fp.fileCount, newest: fp.newest },
    history_note: 'verification/** and verification-t9/** are excluded, so verifier artefacts cannot change the revision id; the paired-hash record for verifier tooling is artifacts-v8/verifier-tool-hashes.json (checked by tools/tool-hashes-check.mjs).',
  },
  fingerprint_history: [
    ...v7.fingerprint_history,
    { when: '11:0x → 11:1x (t60 measurement window, identical across two samples 8s apart)', fingerprint: fp.fingerprint, note: 'post t59 (gates/README.md 10:53:39) and t61 (docs/01-architecture.md 10:54:29) tree; no writer active while t60 measured (t62 was holding off, waiting for report-v8)' },
  ],
  environment: { node: process.version, platform: `${process.platform} ${process.arch}`, caseSensitiveFilesystemAvailable: false, apiKeyEnvironmentVariables: 'none matched *KEY*/*TOKEN*/*SECRET*/*ANTHROPIC*/*OPENAI*/*OCR_*' },
  x1_pointer_format_sample: HEADER_SAMPLE,
  x1_machine_check: {
    command: 'node verification-t9/tools/baseline-freshness.mjs --deep',
    output_line: freshLegend,
    exit_code: 0,
    per_file: fresh.rows.map((r) => ({ file: r.evidence, status: r.status, declared_status: r.declared_status })),
    negatives: [
      { file: 'pointer-negatives/n1-stale.txt', mutation: 'a SUPERSEDED pointer promoted to RECORDED (same bytes)', expected_exit: 1, observed: 'STALE' },
      { file: 'pointer-negatives/n2-tampered.txt', mutation: 'one payload token changed (tests 131 → 999)', expected_exit: 2, observed: 'TAMPERED' },
      { file: 'pointer-negatives/n3-countdrift.txt', mutation: 'header expectation changed to tests=999 (payload untouched)', expected_exit: 1, observed: 'COUNT-DRIFT (--deep)' },
      { file: 'pointer-negatives/n4-nomarker.txt', mutation: 'no pointer header at all', expected_exit: 3, observed: 'UNPARSABLE' },
    ],
  },
  x4_decision: SCOPE.x4_decision,
  assertions,
  summary,
  findings: [
    { id: 'F15', severity: 'medium', owner: 'adapter-engineer', status: 'open',
      problem: 'The adapter names the network surface per LINE while the engine matches the whole text, so a named-client call whose dot sits on another line is reported by the engine and missed by the adapter. Four self-built cells: `const r = await ky\\n  .get(url);`, `const r = await client\\n  .request(opts);`, `const r = await ky.\\n  get(url);`, `const r = ky .\\n  head (url);` → engine=true / adapter=false. Prettier-style chained calls make this realistic rather than contrived.',
      requiredFix: 'Run NET_CLIENT_CALL_RE (and the import/member scans that are still per-line) over the whole masked text, or join a line with its continuation when the previous line ends with a `.`/identifier. Add the four cells to test/network-client.test.mjs.' },
    { id: 'F16', severity: 'low', owner: 'adapter-engineer', status: 'open',
      problem: 'The adapter treats a line starting with `*` as JSDoc continuation and skips it, while the engine treats it as code. With an unterminated `/*` (the exact case t46 fixed on the engine side) the engine reports `* const r = await axios.get(url);` and the adapter reports nothing: `/*\\n * const r = await axios.get(url);` → engine=true / adapter=false. A bare ` * …` line outside any comment behaves the same.',
      requiredFix: 'Track block-comment state instead of guessing from a leading `*`, and mirror the engine t46 rule: an unterminated `/*` must not blank the rest of the file. Lock it with a test.' },
    { id: 'F17', severity: 'low', owner: 'adapter-engineer', status: 'open',
      problem: 'The adapter sensitive-NAME rules miss Windows-normalizable spellings. Measured: `.env ` (trailing space), ` .env` (leading space), `.env::$DATA`, `.env::stream` are NOT sensitive by name and are excluded only by the extension whitelist (right answer for the wrong reason — if `allowUnsupportedExtensions` or the whitelist changes they are admitted); `CREDEN~1.JSON` is not sensitive by name and IS admitted (its content is secret-shaped; the content heuristic only runs on nlink>1 files). On-disk fact measured here: Node/NTFS keeps `.env.`/`.env ` as distinct directory entries — they are not auto-stripped. Whether an 8.3 alias of a sensitive file can exist on this volume could NOT be established (`fsutil 8dot3name query` → Access is denied), so the 8.3 cell is recorded as an unverified alias risk.',
      requiredFix: 'Normalize on comparison (trim, upper-case, split off `::$` streams) inside the sensitive-name rule, and decide explicitly whether short names are in scope; if they are, resolve them (e.g. via a GetLongPathName-style lookup) instead of pattern-matching.' },
    { id: 'F18', severity: 'medium', owner: 'verifier (self-repaired this round)', status: 'fixed',
      problem: 'Three verifier tools silently consumed a superseded or missing revision input: contract-fields defaulted `--runresult` to a non-existent artifacts-v7 file AND wrapped the whole runtime comparison in `if (fs.existsSync(...))` so a missing input reported `mismatches: 0` (silent skip read as a pass — the same defect class as a stale baseline); trace-check hardcoded `artifacts-v7/trace.json` and even echoed that hardcoded path as its `traceFile` while checking it; preview-crosscheck defaulted `--artifacts` to the superseded `artifacts-v5`.',
      requiredFix: 'Done: all three inputs are required and missing files fail closed (exit 3); trace-check reports the file it actually read; the found-and-fixed list is in `self_repairs`. Lesson F6-class: a default that points at an older revision turns a fresh check into a replay of history.' },
    { id: 'F19', severity: 'medium', owner: 'core-engineer', status: 'open',
      problem: 'The root config declares no `selection`, so SAFE_002 scans the whole project root — including `verification-t9/**` (the verifier private area, deliberately outside the revision fingerprint). Measured: the SAFE_002 evidence string `metrics.selected` tracked verifier writes exactly (585 → 633 → 634 → 635 → 642 → 643 as artefacts were written; controlled experiment: +1 file under `verification-t9/` ⇒ +1 selected, +1 ledger under `verification/evidence/` ⇒ unchanged). Consequence: the RunResult TEXT is not revision-stable — two captures of the same revision differ — although no gate decision changes (exit 0, overall_passed=true, secretPathsExcluded=17 constant).',
      requiredFix: 'Add an explicit `selection` (include/exclude) to `qgate.config.json` that excludes `verification-t9/**` and root `.qgate/**`, or drop the raw `selected` count from the SAFE_002 evidence excerpt. Either way, keep the invariant that verifier-side writes cannot perturb the reported RunResult.' },
    { id: 'F12', severity: 'medium', owner: 'adapter-engineer', status: 'closed (verified this round)',
      problem: 'Adapter module vocabulary lacked dns/undici, so 10 of 22 sweep cells disagreed with the engine.',
      requiredFix: 'Fixed by t56; re-measured here: w45-net-parity `sweepDisagreements=[]`, assertion W4 flips fail → pass.' },
    { id: 'F13', severity: 'low', owner: 'architect + core-engineer', status: 'closed (verified this round)',
      problem: 'gates/README L173 stated scanRoots behaviour as if it were platform-independent.',
      requiredFix: 'Fixed by t59 (L172/L173 wording + new Boundary 6 L181-L204) and t61 (GAP-7 platform qualifier). Independently re-checked: N1 reproduced, both semantics reproduced, the no-Ubuntu disclosure matches this machine (wsl E_ACCESSDENIED, fsutil Access is denied), and the code basis (`absOf`+`fileExists`, no case folding) verified at source.' },
    { id: 'F14', severity: 'medium', owner: 'adapter-engineer', status: 'closed (verified this round, with two residuals F15/F16)',
      problem: 'The adapter had no named-network-client surface, so `axios.get(url)` / `client.get(url)` were 10 cells engine=true / adapter=false.',
      requiredFix: 'Fixed by t58 and independently reproduced here on 60 self-built cells (client calls 20/20 both report, benign controls 20/20 zero false positives, non-HTTP members 5/5 not reported, collisions 6/6 both report, the two adapter-stricter cells still report). Residual gaps found in the same family: F15 (line-split) and F16 (`*`-led lines).' },
    { id: 'F11', severity: 'low', owner: 'adapter-engineer', status: 'carried, not re-measured this round',
      problem: 'Unsupported-extension and binary files shared the reason string `binary_file:extension`.',
      requiredFix: 't56 reports it fixed; the locking test exists (`test/reason-vocab.test.mjs`) and the suite is green (14 files / 131 cases), but this round the verifier did NOT re-derive the two reason strings — recorded as carried rather than as an independently verified pass.' },
    { id: 'F10', severity: 'info', owner: 'architect', status: 'open (informational)',
      problem: 'Index and ledger testIds share the engine static `checkTestIds` map, so `covered=true` proves the carrying check ran, not root-side coverage closure.',
      requiredFix: 'Optional cross-reference in gates/README to the audit boundary; no code change proposed.' },
  ],
  self_repairs: [
    { tool: 'verification-t9/tools/contract-fields.mjs', before: 'default --runresult = artifacts-v7/runresult-1.json (does not exist) + `if (fs.existsSync(path))` around the whole runtime comparison ⇒ missing input reported mismatches:0', after: '--runresult required; missing/absent file exits 3; comparison always executed', evidence: [`${A}/contract-fields-rootcheck.json`, `${A}/contract-fields-warmup.json`, 'no-arg and missing-file runs both exit 3'] },
    { tool: 'verification-t9/tools/trace-check.mjs', before: 'trace file hardcoded to artifacts-v7/trace.json; the report echoed that same hardcoded path (so it misdescribed what it read)', after: '--trace required; missing file exits 3; `traceFile` reports the actual input', evidence: [`${A}/trace-check.json`, 'no-arg and missing-file runs both exit 3'] },
    { tool: 'verification-t9/tools/preview-crosscheck.mjs', before: 'default --artifacts = superseded artifacts-v5 (a no-flag run would print ALIGNED about an old capture)', after: '--artifacts required; missing dir exits 3', evidence: [`${A}/preview-crosscheck.json`, 'no-arg and missing-dir runs both exit 3'] },
    { tool: 'verification-t9/tools/y5-table-integrity.mjs', before: 'first version split table rows on every pipe character, so the escaped-pipe cell (--group-mode auto|single|per-file) was reported as a broken row (4 cells vs a 2-cell header)', after: 'splits on unescaped pipes only; 24 tables / 191 rows / brokenRows=0', evidence: [`${A}/y5-table-integrity.json`] },
    { tool: 'verification-t9/tools/tree-fingerprint.mjs', before: 'script-only, scope text hand-copied into each report', after: 'exports computeFingerprint/SCOPE, adds --scope-json and --product-only (supplementary), and the report scope block is generated from it; default-mode output verified byte-identical to the pre-refactor value (74a28c90…)', evidence: [`${A}/fingerprint-scope.json`] },
    { tool: 'verification-t9/tools/baseline-freshness.mjs', before: '--deep recorded counts but did not upgrade the verdict, so COUNT-DRIFT could never surface; the deliberate negative fixtures were also discovered as if they were real baselines', after: 'the deep verdict replaces the shallow one; `pointer-negatives/` is excluded from discovery', evidence: [`${A}/baseline-freshness.json`, `${A}/pointer-negatives/`] },
  ],
  residual_items: [
    { id: 'R1', owner: 'adapter-engineer', severity: 'medium', item: 'F15 line-split named-client scan (4 self-built cells engine=true/adapter=false)' },
    { id: 'R2', owner: 'adapter-engineer', severity: 'low', item: 'F16 `*`-led line / unterminated `/*` blind spot' },
    { id: 'R3', owner: 'adapter-engineer', severity: 'low', item: 'F17 Windows-normalizable sensitive names + unverifiable 8.3 alias status' },
    { id: 'R4', owner: 'core-engineer', severity: 'medium', item: 'F19 root config scan set includes verification-t9/** ⇒ RunResult text not revision-stable' },
    { id: 'R5', owner: 'core-engineer', severity: 'medium', item: 'X1 completion: register `node verification-t9/tools/baseline-freshness.mjs` (and optionally `tool-hashes-check.mjs`) as a `command` check so a stale baseline is a RED GATE for everyone, not an observation only the verifier makes' },
    { id: 'R6', owner: 'core-engineer', severity: 'low', item: 't7/t62 integration README + one-command entry (not verifier work; t62 was holding off for this report)' },
    { id: 'R7', owner: 'architect', severity: 'info', item: 'F10 audit-boundary cross-reference (optional)' },
  ],
  incidents: [
    { id: 'M1', kind: 'method', severity: 'info', title: 'PowerShell text round-trip corrupts evidence and source',
      detail: 'Two separate occurrences this round: (a) `Get-Content -Raw | Set-Content -Encoding utf8` silently rewrote a pointer file it was meant to copy as a negative fixture (BOM + byte growth), which the mechanism then correctly reported as TAMPERED — the negative test had to be redone with byte-faithful `[IO.File]`/Node writes; (b) a `-replace` patch that inserted a template literal into trace-check.mjs was mangled by PowerShell `${...}` interpolation and broke the file, repaired via the edit tool. Rule reinforced: never round-trip code or evidence bytes through PowerShell text pipelines.',
      counted_as_delivery_failure: false },
    { id: 'M2', kind: 'method', severity: 'info', title: 'Verifier captures must be written outside the measured tree',
      detail: 'The first cross-cwd root-config comparison reported normalized-equal=false. Cause: the captures were written into `verification-t9/artifacts-v8/`, which the root config SAFE_002 scan set includes, so each run saw the previous run\'s capture (+1 selected). Re-done with captures outside the repo: normalized-equal=true. See F19.',
      counted_as_delivery_failure: false },
  ],
  informational_records: [
    'verification/ top-level entries unchanged: .captain-freeze.json, evidence, review-round2.md, review-round3.md, review.md, trace-matrix.json (assertion 18 of the acceptance). The verifier authored or deleted nothing under verification/**; the mandated root-config check appends one ledger per run under verification/evidence/ (measured: exactly 1 file added per run) and rewrites ledger-index.json, which is the engine\'s designed behaviour.',
    'A01 (positive control, incidental): writing an unregistered `ledger-*.json` into `verification/evidence/` made the scratch-tree check fail with `EVIDENCE_UNRESOLVED` exit 3 — t28\'s ledger-chain verification is live.',
    'A02: verification-t9/artifacts-v8/pointer-negatives/ holds the four deliberate negative fixtures; they are excluded from the freshness aggregator by design.',
    'A03: n1-stale proves the freshness judgement is a *content* property, not a file-name one: the same bytes are FRESH when declared SUPERSEDED and STALE when declared RECORDED.',
  ],
  release_recommendation: {
    verdict: '可放行（release-ready）',
    basis: `${summary.pass} pass / ${summary.fail} fail / ${summary.blocked} blocked（共 ${summary.total} 条断言），全部在冻结修订 ${fp.fingerprint.slice(0, 12)}…（${fp.fileCount} 文件，两次采样一致）上实测。无 blocker/high 残留；本轮新发现三条为 medium/low 且均已被同一断言证明「不影响门禁判定」（F15/F16/F17 属适配层 pre-filter 的 fail-open 方向，引擎侧 SAFE_003 在同一输入上仍为 fail-closed；F19 只影响 RunResult 文本稳定性，exit 与 overall_passed 不变）。F12/F13/F14 均已闭环复核。`,
    blocking_conditions_if_any: 'none',
    recommended_next_round_order: ['R5 (make baseline freshness a gate check — this is the structural completion of X1)', 'R4 (scope the root config scan set)', 'R1 (F15 line-split)', 'R3 (F17 name normalisation)', 'R2 (F16 block-comment state)'],
  },
};

fs.writeFileSync(path.join(HERE, 'report-v8.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`report-v8.json written: ${summary.total} assertions (pass ${summary.pass} / fail ${summary.fail} / blocked ${summary.blocked}), fingerprint ${fp.fingerprint}, files ${fp.fileCount}`);
