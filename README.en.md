# dsh-chatgpt-to-memory

[中文](README.md)

A complete memory-import plugin for DeepSeek Harness. It transports the official ChatGPT export, deduplicates conversations, distills durable facts, and merges them into local memory. All memory writes go through `memory_import_candidates` in `dsh-long-term-memory`; this plugin never edits memory files directly.

Current version: v0.2.0 (complete pipeline).

---

## Pipeline

1. **Export**: invokes the official data-export flow; when a recent-login check occurs, it reads the verification code from the registered mailbox and re-authenticates automatically.
2. **Transfer**: waits for the ready email, downloads and extracts the archive, and verifies the archive digest and conversation counts.
3. **Deduplication**: compares conversation IDs and message text against processed records stored in `profile/import-runs/processed-conversations.json`.
4. **Distillation**: extracts facts, interests and viewpoints in batches through the host LLM service and writes a candidate JSON; sensitive and low-confidence items are classified by sensitivity.
5. **Merge**: calls `memory_import_candidates` in `dsh-long-term-memory`, which routes items into `MEMORY.md`, `INTERESTS.md`, `USER-PROFILE.md`, or the pending queue.

When there is no new export or no new conversation, the pipeline skips automatically and produces no side effects.

## Tools

| Tool | Purpose |
|---|---|
| `import_run` | Runs the complete pipeline; skips when there is no new data |
| `import_distill` | Runs LLM distillation on an existing dataset, optionally merging |
| `import_scan` | Scans and deduplicates only, producing a dataset |
| `import_status` | Read-only view of the export directory, latest archive, candidates, and the last scan report |
| `import_configure` | Reads or writes plugin configuration with a backup before each write |

## Configuration

```yaml
- id: chatgpt-to-memory
  config:
    exportRoot: D:\ChatGPT-Backups
    workdir: D:\deepseek workspace
    autoMerge: true
    distill:
      provider: deepseek-official
      model: ''
      batchConvs: 20
```

- `exportRoot`: root directory of export archives.
- `workdir`: workspace whose `profile/` receives candidates and datasets.
- `autoMerge`: whether to merge automatically after distillation.
- `distill.provider` / `distill.model`: model used for distillation; an empty `model` selects the provider's first available model.
- `distill.batchConvs`: conversations per batch.

## Security and scope

- Accesses only local data: the export directory and the workspace `profile/`.
- Does not write memory files; all writes are performed by `dsh-long-term-memory`.
- Network traffic occurs only within the user's own Chrome login state; proxy settings follow the user environment.
- Distillation rules: only user (`role=user`) messages are treated as fact sources; no profession inference; no ownership inference from hypothetical questions; assistant replies are never facts.
- Auditable: each import writes `profile/import-runs/<timestamp>/` and keeps the processed-conversation records.

## Installation

1. Desktop: Plugins page → Add plugin → select the local directory.
2. Command line: `dsh plugin --profile desktop add github:wojiao42/dsh-chatgpt-to-memory`.
3. Local development: `dsh plugin --profile desktop add link:D:/dsh-plugins/dsh-chatgpt-to-memory`.

Reload the plugin after changing Host-side code; local link installations do not hot-reload.

## Self-test

```powershell
node --check index.js
node smoke.mjs
```

## Compatibility

- Verified on DSH 0.2.2-rc.5.
- Requires host-provided `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm`.
- Export and download use the bundled `weekly.mjs`, which requires Playwright and the user's own Chrome login state.

## Known limits

- Distillation quality depends on the selected model; low-confidence items go to the pending queue.
- `.dat` attachments are not parsed.
- Import and download depend on the local Chrome login state; expired sessions require one manual login.

## Version

- **v0.2.0** (2026-11-20): complete pipeline inside the plugin; new `import_distill` and processed-conversation cursor.
- **v0.1.0**: scan, dedupe, dataset, and configuration.

## Listing status

- Entry submitted: awesome-dsh-plugin [#17270](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17270), awaiting maintainer merge.

## License

MIT
