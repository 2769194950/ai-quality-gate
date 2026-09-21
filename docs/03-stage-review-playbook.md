# 阶段语义审查手册

`qgate stage` 将 OpenCodeReview 作为五阶段流水线的语义审查器。它只产出 finding 和建议补丁；最终门禁仍由 `qgate check` 的确定性检查、人类审批和证据追踪决定。

## 日常调用

在仓库根目录执行离线开发检查：

```text
node packages/qgate/bin/qgate.mjs stage requirements review --mode offline --json
node packages/qgate/bin/qgate.mjs stage design review --mode offline --json
node packages/qgate/bin/qgate.mjs stage build review --mode offline --json
node packages/qgate/bin/qgate.mjs stage review review --mode offline --diff .qgate/diff.json --json
node packages/qgate/bin/qgate.mjs stage verify review --mode offline --json
```

真实 OpenCodeReview 由外部受控执行器调用。执行器必须先使用同一阶段输入生成 manifest，调用完成后再导入：

```text
node tools/ci/write-stage-context.mjs review \
  .qgate/ocr/review.md .qgate/ocr/review.manifest.json .qgate/diff.json
node adapters/opencodereview/bin/ocr-stage-review.mjs \
  --stage review --root . --manifest .qgate/ocr/review.manifest.json \
  --diff .qgate/diff.json --background-file .qgate/ocr/review.md \
  --out .qgate/ocr/review.json
node packages/qgate/bin/qgate.mjs stage review ingest \
  --result .qgate/ocr/review.json --diff .qgate/diff.json --json
```

阶段证据默认写入：

```text
.qgate/evidence/ai/<stage>.json
```

查看某个阶段：

```text
node packages/qgate/bin/qgate.mjs stage review explain --evidence .qgate/evidence/ai/review.json
```

## 阶段输入

| 阶段 | 主要上下文 | 关注点 |
|---|---|---|
| `requirements` | 需求文档、需求索引 | 完整性、可验收性、冲突和追踪 |
| `design` | 架构文档、schema、需求索引 | 需求覆盖、契约一致性和可测试性 |
| `build` | package、构建配置、依赖 | 构建风险、依赖风险和实现偏差 |
| `review` | diff、代码、需求、设计、构建结果 | 逻辑缺陷、边界、安全、回归和测试缺口 |
| `verify` | 测试结果、证据账本、追踪矩阵 | 测试与证据是否真的覆盖需求 |

## 结果处理

每个阶段证据包含 `executed`、`valid`、`degraded`、`findings`、`counts` 和三个可供门禁断言的布尔值：

```json
{
  "ocrExecuted": true,
  "ocrResultValid": true,
  "ocrNoBlockers": true
}
```

第一版所有 finding 默认告警。缺少结果、结果格式错误、路径越界或无法解析的 JSON 则 fail-closed，不能转换成“没有发现问题”。

在项目门禁配置中使用现有 `json_assert` 接入阶段证据，不需要新增 `llm_review` 类型：

```json
{
  "id": "ai-review-valid",
  "type": "json_assert",
  "required": true,
  "file": ".qgate/evidence/ai/review.json",
  "assertions": [
    { "pointer": "/summary/ocrExecuted", "equals": true },
    { "pointer": "/summary/ocrResultValid", "equals": true }
  ]
}
```

`ocrNoBlockers` 第一版建议使用 `onFail: "warn"`；完成误报校准后，再将选定的高置信类别切换为阻断检查。

## 修复闭环

1. 运行当前阶段审查并查看 finding。
2. 人工确认是否采纳 `suggestionCode`。
3. 由开发者、IDE 或 Agent 应用修改。
4. 重新运行当前阶段审查。
5. 重新运行后续确定性门禁和测试。
6. 只有重新验证后才能关闭 finding。

`qgate` 本身不会修改源码，也不会把 AI 的自然语言结论写入 `overall_passed`。

## GitHub Actions 分层

仓库提供三个职责不同的 workflow：

| Workflow | 触发 | OCR 模式 | 用途 |
|---|---|---|---|
| `quality-fast.yml` | 所有 push、Pull Request | offline | 快速测试、受影响阶段选择和离线 evidence；不读取任何 secret |
| `quality-gate.yml` | `main`、`release/**`、`v*` tag、手动/复用调用 | deterministic + offline evidence | 五阶段完整 qgate、账本、trace、baseline 和安全策略 |
| `quality-live.yml` | 可信分支、发布 tag、手动触发 | requirements/design/review/verify 使用 live OCR，build 保持确定性 | 受保护环境中的真实语义审查 |

启用 `quality-live.yml` 前，在 GitHub Environment `ocr-live` 中配置：

- Secret：`OCR_AUTH_TOKEN`
- Variable：`OCR_BASE_URL`（Atria Chat Completions 使用 `https://api.atria-asi.ai/v1`）
- Variable：`OCR_MODEL`（例如 `Atria-Dawn-Preview`）
- Workflow 会将它们映射为 OpenCodeReview CLI 的 `OCR_LLM_URL`、`OCR_LLM_TOKEN`、`OCR_LLM_MODEL`，并设置 `OCR_USE_ANTHROPIC=false`，走 Atria 官方 OpenAI-compatible Chat Completions 接口。
- Required reviewers、可信分支限制和最小 `contents: read` 权限

真实 token 只在 live OCR 那一个 step 注入，qgate、测试、证据、ledger 和 Artifact 都不会继承它。原始 OCR JSON 只存在 `.qgate/tmp/ocr/`，ingest 完成或 job 失败后都会清理；Artifact 只上传规范化 evidence。Fork PR 永远只进入 fast workflow，不能触发 live OCR。
