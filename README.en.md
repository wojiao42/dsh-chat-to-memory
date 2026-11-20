# dsh-chatgpt-to-memory

> The complete ChatGPT export → memory pipeline inside a DeepSeek Harness plugin: **trigger export → wait for mail → download & unzip → scan & dedupe → LLM distillation → merge into memory**.
>
> It never writes memory files: merging goes only through [`dsh-long-term-memory`](https://github.com/wojiao42/dsh-long-term-memory)'s `memory_import_candidates`.

**Status: v0.2.0 — full pipeline.** A scheduled task or the chat only needs to call `import_run`.

---

## Quick start

```powershell
# 1) Install (Desktop: Plugins → Add plugin → pick the local folder; or CLI)
dsh plugin --profile desktop add github:wojiao42/dsh-chatgpt-to-memory

# 2) After restarting DSH, just ask in a session:
#    "run a ChatGPT memory import"
#    the agent calls import_run and reports the result.
```

## Tools

| Tool | What it does |
|---|---|
| `import_run` | **Full pipeline**: trigger/check export → download & unzip → scan & dedupe → LLM distillation → merge; skips automatically when there is no new export or no new conversations |
| `import_status` | Read-only: export dir, latest archive, candidates, last scan report, config |
| `import_scan` | Scan & dedupe only; writes a distillation dataset |
| `import_distill` | Run LLM distillation on an existing dataset (optionally merges) |
| `import_configure` | Read/write config (provider/model, batch size, auto-merge) |

## Security & scope

- Touches only your own data: the export dir (`D:\ChatGPT-Backups` by default) and the workspace `profile/`.
- **Never writes memory files**; candidates are merged by `dsh-long-term-memory` (the single write path).
- Network happens only inside your own Chrome profile via the proven `weekly.mjs` (automatic email-code re-auth; proxy follows your environment).
- Distillation rules: only `role=user` is a fact source; no profession inference; no assuming a hypothetical question means ownership; assistant text is never a fact.
- Auditable: every import writes `profile/import-runs/<timestamp>/` and a processed-conversation cursor, so nothing is imported twice.

## Configuration

```yaml
- id: chatgpt-to-memory
  config:
    exportRoot: D:\ChatGPT-Backups
    workdir: D:\deepseek workspace
    autoMerge: true
    distill:
      provider: deepseek-official
      model: ''        # empty = first model of that provider
      batchConvs: 20
```

## Self-test

```powershell
node --check index.js
node smoke.mjs      # 19 checks
```

## Known limits

- Export/download needs `weekly.mjs` (shipped) plus Playwright and your Chrome login state; the plugin declares `playwright-core`.
- Distillation quality depends on the model; low-confidence/private items follow the memory plugin's routing.
- `.dat` attachments are not parsed.

## Version

- **v0.2.0** (2026-11-20): full pipeline inside the plugin (`import_run`), new `import_distill`, processed-conversation cursor.
- **v0.1.0**: M1 scan/dedupe/dataset/config.

## Listing status

- Pending maintainer merge: [awesome-dsh-plugin #17270](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17270)

## License

MIT
