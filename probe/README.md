# Throwaway wire-shape probe — not part of any reviewed branch

Answers exactly two unconfirmed assumptions in `src/claude-cli/session.ts`:
does one `claude -p --input-format stream-json --output-format stream-json`
process serve two turns without exiting, and does `--tools ""` still leave
an MCP-declared tool (`--mcp-config`, `--strict-mcp-config`) reachable.

## Run

    bash /Users/adsurg/Projects/llm-session-tools/probe/run-probe.sh

## Send back

`probe-stdout.log`, `probe-stderr.log`, `probe-exit-code.txt`,
`mcp-server-stdin.log` — all written into this same `probe/` directory.

## What confirms the design

`probe-stdout.log` contains **two** `{"type":"result",...}` lines (one per
turn) with no process exit in between; `mcp-server-stdin.log` contains a
`RECEIVED:` line for a `tools/call` request during turn 2; exit code 0.

## What means the mechanism does NOT hold

Either: only one `result` line appears (the process exited after turn 1 —
stream-json doesn't keep it alive across turns), **or**
`mcp-server-stdin.log` never shows a `tools/call` (`--tools ""` blocks MCP
tools too, not just built-ins). Either one means `session.ts`'s whole
approach needs a different flag or a different design — not something to
patch around quietly.

This directory is never committed. Delete it, or leave it — it is not
staged into any commit and `commit_files` only stages paths named
explicitly, so it cannot leak into `#45` by accident.
