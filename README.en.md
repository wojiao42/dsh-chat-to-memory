# dsh-chatgpt-to-memory

> Turns your official **ChatGPT data export** into memory candidates for DeepSeek Harness: scans the export, dedupes against previous imports, writes a distillation dataset and audit report, then hands candidates to [`dsh-long-term-memory`](https://github.com/wojiao42/dsh-long-term-memory). The export/download scripts still live in a companion workspace (already proven) and move into this plugin in M2.
>
> **This plugin never writes memory files.** The only write path is `memory_import_candidates` in `dsh-long-term-memory`.

**Status: M1 in progress** (scan / dedupe / dataset / config available; export+download still live in workspace scripts, moving in M2).

## What it does

| Tool | Purpose |
|---|---|
| `import_status` | Read-only status: export root, latest export, candidates, last scan report, config |
| `import_configure` | Get/set distill preferences (`profile/distill-config.json`, backed up before write) |
| `import_scan` | Scan latest export → dedupe (conversation id + normalized text) → write dataset + report |
| `import_preview` | Same as scan, with distillation rules spelled out (quality inspection) |
| `import_run` | M1 placeholder: full export→download→re-auth chain lands in M2 |

Datasets go to `<cwd>/profile/import-runs/<timestamp>/dataset.json`.

## Security & scope

- Reads only your own export dir (`D:\ChatGPT-Backups` by default) and workspace `profile/`.
- **Never writes memory files**; candidates are produced by the agent and merged by `dsh-long-term-memory`.
- **No network** in M1; M2 network stays inside your own Chrome profile, proxy follows your environment.
- **No process spawning** in M1.
- Dedupe: conversation id → normalized exact text → (in consumer) fact-level.

## Install

1. GUI (desktop, recommended): Settings → Plugin market → Custom install → `github:wojiao42/dsh-chatgpt-to-memory`
2. CLI: `dsh plugin --profile web add github:wojiao42/dsh-chatgpt-to-memory`
3. Local dev: `dsh plugin --profile desktop add link:D:/dsh-plugins/dsh-chatgpt-to-memory`

## Self-test

```powershell
node --check index.js
node smoke.mjs
```

## Compatibility

- Verified against DSH `0.2.2-rc.1` (in progress).
- Requires host-provided `@deepseek-ai/dsh-tools`; `playwright-core` becomes an optional dependency in M2.

## Known limits

- M1 does not trigger/download exports (workspace scripts still do that, already proven end-to-end).
- New messages inside old conversations are skipped in M1 (conservative).
- `.dat` attachments are not parsed.

## Version

- **v0.1.0** (2026-11-11): M1 skeleton — scan, dedupe, dataset, report, config, status.

## Listing status

To be submitted to awesome-dsh-plugin / dsh-plugin.org after release.

## License

MIT
