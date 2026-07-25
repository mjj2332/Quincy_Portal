# Codex CLI mechanics (Sol / Terra / Luna)

Loaded on demand from `docs/Subagent-Orchestration.md` §3. Verified live 2026-07-19.

`codex exec` runs the real Codex CLI as an OS subprocess via `Bash` — OpenAI's model, its own
sandbox, output read back from a file. It is not the `Agent` tool.

```bash
codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=high "..."
```

Full spawn shape, with the spec in a scratchpad file and the report captured separately:

```bash
SCRATCH=".../scratchpad"
cd "<repo root>" && codex exec \
  --sandbox workspace-write \
  --output-last-message "$SCRATCH/wp-x-report.md" \
  "$(cat "$SCRATCH/wp-x-taskname.md")" \
  > "$SCRATCH/wp-x-run.log" 2>&1
```

## Flags

| Flag | Purpose |
|---|---|
| `--sandbox workspace-write` | Implementation tasks — file writes allowed |
| `--sandbox read-only` | Review and planning — writes are structurally impossible |
| `--output-last-message <file>` | Write only the final report to a clean file |
| `-m <model>` | Override the default model for one invocation |
| `-c model_reasoning_effort=high` | Set reasoning effort |
| `-c 'sandbox_workspace_write.network_access=true'` | Allow network from a workspace-write sandbox (needed for MCP calls) |

- The account default (`~/.codex/config.toml`) is `gpt-5.6-terra` at high effort, so `-m` is
  only needed to switch to `gpt-5.6-sol` or `gpt-5.6-luna`.
- There is **no `--reasoning-effort` flag** — effort goes through `-c model_reasoning_effort`.
- There is **no `--no-terminal` flag** on `codex exec`; that belongs to `acpx`'s Claude-session
  wrapper.

## Failure mode: MCP write actions

`codex exec` runs with `approval: never`. Some MCP **write** tools require a per-call approval
it cannot grant non-interactively, so the call fails while read-only calls to the same server
succeed in the same run. Don't keep tuning the invocation — fall back to an already
authenticated CLI (e.g. `wrangler` for Cloudflare) and perform the write directly.
