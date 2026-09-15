# Probe findings

Minimal test content.

## What each probe establishes

1. **`run-probe.sh`** (`--safe-mode` on, 3 turns: hello / invoke Bash / call the MCP `echo` tool). Confirmed: one process serves multiple turns without exiting between them; the terminal event's envelope shape (`result`, `is_error`, `stop_reason`, `usage`, `modelUsage`, `permission_denials`, etc.). Confirmed the `--tools ""` fail-open (the model reported having Bash/Read/Edit — later corroborated structurally, see below). `mcp_servers` came back `[]` under `--safe-mode` — MCP never connected.
