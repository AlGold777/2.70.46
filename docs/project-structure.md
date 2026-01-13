# Структура проекта (Codex LLM Extension)

```
.
├── manifest.json
├── package.json
├── background.js
├── popup.html
├── popup.js
├── result_new.html
├── results.js
├── styles.css
├── scroll-toolkit.js
├── selector-manager.js
├── selector-manager-strategies.js
├── selectors-config.js
├── selectors-override.json
├── content-scripts/
│   ├── content-bootstrap.js
│   ├── selectors-finder-lite.js
│   ├── selectors-metrics.js
│   ├── selectors-circuit.js
│   ├── pragmatist-core.js
│   ├── pragmatist-runner.js
│   ├── unified-answer-pipeline.js
│   ├── unified-answer-watcher.js
│   ├── pipeline-config.js
│   ├── content-chatgpt.js
│   ├── content-claude.js
│   ├── content-gemini.js
│   ├── content-grok.js
│   ├── content-qwen.js
│   ├── content-lechat.js
│   ├── content-deepseek.js
│   ├── content-perplexity.js
│   └── notes-sidebar-inject.js
├── selectors/
│   ├── chatgpt.config.js
│   ├── claude.config.js
│   ├── gemini.config.js
│   ├── grok.config.js
│   ├── qwen.config.js
│   ├── lechat.config.js
│   ├── deepseek.config.js
│   └── perplexity.config.js
├── shared/
│   ├── storage-budgets.js
│   └── budgets.js
├── scripts/
│   └── build-bundles.js
├── docs/
│   ├── change-log-codex.md
│   ├── tabs-and-selectors.md
│   ├── tech-stack-overview.md
│   └── project-structure.md  ← этот файл
├── Modifiers/
│   ├── modifiers-basic.json
│   └── modifiers_*.json
├── notes/
│   ├── notes-constants.js
│   ├── notes-idb.js
│   ├── notes-orderkey.js
│   ├── notes-chunks.js
│   ├── notes-client.js
│   └── notes-service.js
├── icons/
├── dist/
├── tests/
│   ├── command-executor.test.js
│   ├── integration-command-flow.test.js
│   ├── integration-end-to-end.test.js
│   ├── integration-stream-watcher.test.js
│   ├── scroll-coordinator.spec.js
│   ├── scroll-metrics.test.js
│   ├── state-manager.test.js
│   ├── storage-budgets.test.js
│   └── selector-manager.spec.js
└── node_modules/
```
