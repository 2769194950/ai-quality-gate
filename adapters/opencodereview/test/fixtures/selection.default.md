# OpenCodeReview 选择预览（selection.md）

- provider: `local` ｜ degraded: `true` ｜ degraded_reason: `OCR_CLI_NOT_FOUND`
- llm_called: `false`
- 来源: `diff` `<ADAPTER_ROOT>/demo/diff.json`
- 候选 23 ｜ 选中 14 ｜ 排除 9 ｜ 分组 4（降级 0）
- 安全不变量: 敏感路径进入 selected = 0 条违规（必须为 0）

## 文件 / 决策 / 原因

| 文件 | 决策 | 原因 | 规则来源 | 模式 |
|---|---|---|---|---|
| `.env.production` | excluded | `sensitive_path_never_included` | SAFETY_INVARIANT | — |
| `.opencodereview/secrets/db-password.txt` | excluded | `sensitive_path_never_included` | SAFETY_INVARIANT | — |
| `assets/logo.png` | excluded | `binary_file:extension` | SAFETY_INVARIANT | — |
| `config/service-account.json` | excluded | `sensitive_path_never_included` | SAFETY_INVARIANT | — |
| `config/tls/server.pem` | excluded | `sensitive_path_never_included` | SAFETY_INVARIANT | — |
| `dist/bundle.js` | excluded | `default_excluded_dir:dist` | SAFETY_INVARIANT | — |
| `node_modules/left-pad/index.js` | excluded | `default_excluded_dir:node_modules` | SAFETY_INVARIANT | — |
| `src/chain/chain.test.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/chain/id_rsa` | excluded | `sensitive_path_never_included` | SAFETY_INVARIANT | — |
| `src/chain/user-handler.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/chain/user-handler.mjs.bak` | excluded | `unsupported_extension:.bak` | SAFETY_INVARIANT | — |
| `src/chain/user-mapper.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/chain/user-repository.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/chain/user-service.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/reader/reader-part-1.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/reader/reader-part-2.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/reader/reader-part-3.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/reader/reader-part-4.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/reader/reader-part-5.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/reader/reader-part-6.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/reader/reader-part-7.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/reader/reader-part-8.mjs` | included | `demo 源码参与评审` | cli:--rule | — |
| `src/util/format.mjs` | included | `demo 源码参与评审` | cli:--rule | — |

## 分组

| 组 | 文件数 | 估算 token | 降级 | 文件 |
|---|---|---|---|---|
| `bucket:injection-chain` | 4 | 306 | — | `src/chain/user-handler.mjs`<br>`src/chain/user-mapper.mjs`<br>`src/chain/user-repository.mjs`<br>`src/chain/user-service.mjs` |
| `src/chain` | 1 | 104 | — | `src/chain/chain.test.mjs` |
| `src/reader` | 8 | 672 | — | `src/reader/reader-part-1.mjs`<br>`src/reader/reader-part-2.mjs`<br>`src/reader/reader-part-3.mjs`<br>`src/reader/reader-part-4.mjs`<br>`src/reader/reader-part-5.mjs`<br>`src/reader/reader-part-6.mjs`<br>`src/reader/reader-part-7.mjs`<br>`src/reader/reader-part-8.mjs` |
| `src/util` | 1 | 20 | — | `src/util/format.mjs` |

## 规则层（高 → 低）

| 优先级 | 来源 | 文件 | 是否加载 |
|---|---|---|---|
| 1 | cli:--rule | `<ADAPTER_ROOT>/demo/rule.json` | true |
| 2 | project:.opencodereview/rule.json | `<ADAPTER_ROOT>/demo/.opencodereview/rule.json` | false |
| 3 | user:~/.opencodereview/rule.json | `<HOME>/.opencodereview/rule.json` | false |
| 4 | builtin:opencodereview-default | — | true |

> 本表格由 `adapters/opencodereview/bin/ocr-preview.mjs --md` 真实运行生成；
> 同一输入重复运行结果字节级一致（详见 README「确定性」一节）。

