# dsh-chat-to-memory

[中文](README.md)

Unified memory-import plugin for DeepSeek Harness. It imports the official exports of both web clients — ChatGPT and DeepSeek — deduplicates conversations, distills durable facts through the host LLM service, and merges them through `dsh-long-term-memory`. The plugin never edits memory files directly.

Current version: v1.0.0 (dual source: ChatGPT + DeepSeek).

---

## Pipeline

Both sources share one post-processing chain:

1. **Obtain the export**
   - ChatGPT: invokes the official export flow; when a recent-login check appears it reads the mailbox verification code and re-authenticates; waits for the ready email, then downloads, extracts and verifies.
   - DeepSeek: calls the official export endpoints (`export_all` / `download_export_history`) inside a dedicated Chrome login state, waits for generation, downloads and extracts the ZIP.
2. **Deduplication**: the DeepSeek source deduplicates by **user-message hashes** (`profile/import-runs/deepseek-imported-turns.jsonl`) — only messages that were never distilled are imported, including newly added messages inside existing conversations; the ChatGPT source compares conversation IDs and message text.
3. **Distillation**: extracts facts, interests and viewpoints in batches through the host LLM service; sensitive and low-confidence items are classified by sensitivity.
4. **Merge**: calls `memory_import_candidates` in `dsh-long-term-memory`, which routes items into `MEMORY.md`, `INTERESTS.md`, `USER-PROFILE.md`, or the pending queue.

When there is no new export or no new conversation, the pipeline skips automatically and produces no side effects.

## Tools

| Tool | Purpose |
|---|---|
| `import_run` | Complete ChatGPT pipeline; skips when there is no new data |
| `import_deepseek` | Complete DeepSeek pipeline; reports a login requirement when the session expired |
| `import_distill` | LLM distillation on an existing dataset, optionally merging |
| `import_scan` | Scan and deduplicate only, producing a dataset (ChatGPT source) |
| `import_status` | Read-only view of the export directory, latest archive, candidates and the last scan report |
| `import_configure` | Read or write plugin configuration with a backup before each write |

## Configuration

```yaml
- id: chat-to-memory
  config:
    exportRoot: D:\ChatGPT-Backups
    workdir: D:\deepseek workspace
    autoMerge: true
    distill:
      provider: deepseek-official
      model: ''
      batchConvs: 20
    deepseek:
      profile: D:\ChatGPT-Backups\profile-deepseek
```

- `exportRoot`: root directory of ChatGPT export archives.
- `workdir`: workspace whose `profile/` receives candidates and datasets.
- `autoMerge`: whether to merge automatically after distillation.
- `distill.provider` / `distill.model`: model used for distillation; an empty `model` selects the provider's first available model.
- `distill.batchConvs`: conversations per batch.
- `deepseek.profile`: directory of the dedicated Chrome login state for DeepSeek.

## Security and scope

- Accesses only local data: the export directories, the workspace `profile/`, and the dedicated browser login directories.
- Does not write memory files; all writes are performed by `dsh-long-term-memory`.
- Network traffic occurs only within the user's own Chrome login states; proxy settings follow the user environment.
- Distillation rules: only user (`role=user`) messages are treated as fact sources; no profession inference; no ownership inference from hypothetical questions; assistant replies are never facts.
- Auditable: each import writes `profile/import-runs/<timestamp>/` and keeps processed-conversation records.

## Installation

1. Desktop: Plugins page → Add plugin → select the local directory.
2. Command line: `dsh plugin --profile desktop add github:wojiao42/dsh-chat-to-memory`.
3. Local development: `dsh plugin --profile desktop add link:D:/dsh-plugins/dsh-chat-to-memory`.

Reload the plugin after changing Host-side code; local link installations do not hot-reload.

## Self-test

```powershell
node --check index.js
node smoke.mjs
```

## Compatibility

- Verified on DSH 0.2.2-rc.5.
- Requires host-provided `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm`.
- Requires Playwright and two dedicated Chrome login states (one for the ChatGPT export, one for the DeepSeek export).

## Known limits

- The DeepSeek export uses an unpublished web interface; interface changes will break it, and an expired session requires one manual login.
- Distillation quality depends on the selected model; low-confidence items go to the pending queue.
- `.dat` attachments are not parsed.

## Version

- **v1.0.1** (2026-11-24): DeepSeek source deduplicates at the message level (no date/conversation-ID guessing); adds `turn-corpus`, corpus seeding and an offline dataset builder.
- **v1.0.0** (2026-11-24): unifies ChatGPT and DeepSeek sources; renamed to `dsh-chat-to-memory`; adds `import_deepseek` and the DeepSeek parser.
- **v0.2.1**: LLM injection fix; formal documentation.
- **v0.2.0**: complete pipeline inside the plugin.
- **v0.1.0**: scan, dedupe, dataset and configuration.

## Listing status

- Entry update: awesome-dsh-plugin PR (renamed from `dsh-chatgpt-to-memory` to `dsh-chat-to-memory`).

## License

MIT
