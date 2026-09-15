# Probe findings — claude-cli held-session wire shape

**Status: probe evidence, not a specification.** A handful of manually-run
invocations on one operator machine, one CLI install. Observed
`claude_code_version`: `2.1.270` (Claude Code) — confirmed present in the
init events of the later runs in this record (`run-probe-plain-second-turn.sh`,
`run-probe-permission-dontask.sh`, and the cwd-pinned rerun of
`run-probe-stall-isolation.sh`); not independently reconfirmed for the two
earliest runs (`run-probe.sh`, `run-probe-no-safe-mode.sh`), whose captured
excerpts in this investigation's own history did not include that field.
Treat every claim below as scoped to that machine and that version unless
more than one run corroborates it.

## What each probe establishes

1. **`run-probe.sh`** (`--safe-mode` on, 3 turns: hello / invoke Bash /
 call the MCP `echo` tool). Confirmed: one process serves multiple turns
 without exiting between them; the terminal event's envelope shape
 (`result`, `is_error`, `stop_reason`, `usage`, `modelUsage`,
 `permission_denials`, …). Confirmed the `--tools ""` fail-open (the
 model reported having Bash/Read/Edit — later corroborated structurally,
 see below). `mcp_servers` came back `[]` under `--safe-mode` — MCP never
 connected.

2. **`run-probe-no-safe-mode.sh`** (`--safe-mode` dropped, otherwise
 identical, 3 turns). First confirmation that `--safe-mode` was the MCP
 blocker: `mcp_servers` reported the configured server as `"connected"`,
 and stayed connected across turns within the one process — the bridge is
 per-session, matching the held-session design's assumption. This is also
 the script whose first run produced the one unreproduced hang — see
 below; that run predates the cwd-pinning fix later added to this family.

3. **`run-probe-plain-second-turn.sh`** (`--safe-mode` off, 2 turns: hello
 / plain follow-up, no tool mentioned). Completed in ~2s. Also the run
 that corrected an earlier misreading: ~298s of "silence" after both
 turns had already completed was traced to the script's own trailing
 `sleep "$WATCHDOG_SECS"` deliberately holding stdin open, not a CLI
 hang — this had been reported to the operator as a possible stall before
 the script itself was reread.

4. **`run-probe-stall-isolation.sh`** (`--safe-mode` off, 2 turns: hello /
 "invoke Bash and show the raw output"). Produced the one hang in this
 record on its first run (cwd = repo root, before the cwd fix below
 existed). After cwd was pinned (`cd "$PROBE_DIR"` added to the script)
 and the exact same run repeated as a baseline check, it completed
 normally — same flags, same turns, only cwd differed from the original
 hang.

5. **`run-probe-permission-dontask.sh`** (adds `--permission-mode
 dontAsk` on top of #4's cwd-pinned form). Completed in ~6s; the model
 declined the tool cleanly in plain text, zero `tool_use` blocks anywhere
 in the stream, `permission_denials: []` on both turns. Initially read as
 "`dontAsk` resolved the hang instead of stalling on it" — retracted once
 it was noticed this run's cwd (`probe/`) differed from the original
 hang's cwd (repo root), so two variables had moved at once relative to
 the hang, not the intended one.

## `--tools ""` fail-open — confirmed

Confirmed from the CLI's own documented flag semantics (relayed to the
operator via their own channel to the CLI, not a guess made in this repo):
an empty string is read as "not set", not "empty allowlist", and falls
through to the default built-in tool set. This shipped, unnoticed, in
every published `@verevoir/llm` version from 0.25.0 through 0.26.2
inclusive — the entire published lifetime of the `claude-cli` adapter.
Fixed on `main` via `#46` (`--disallowedTools "*"` replacing `--tools
""`, plus `assertNoBuiltinToolsReachable` checking the CLI's own `init`
event rather than trusting the flag). The fix is corroborated by direct
observation, not just the flag's documented meaning: the authenticated
`--safe-mode`-on probe explicitly asked the model to invoke Bash and
produced **zero `tool_use` blocks** and an explicit "no tool available"
reply — a structural absence in the stream, not a claim in the model's own
prose (which this investigation separately learned not to trust — see the
second probe run's report, where the model's *description* of having
Bash/Read/Edit was corroborating, not proof, until an actual invocation
attempt was captured).

## `--disallowedTools "*"` — a dependency on a bug, stated plainly

`--disallowedTools "*"` is confirmed to remove every built-in tool (see
above). `session.ts`'s design additionally *depends on* a documented,
unconfirmed-by-us CLI bug where `--disallowedTools` does not reliably
filter MCP-declared tools — i.e. the design needs that bug's current
behaviour to keep holding, and an upstream fix to it could silently break
this adapter's tool-loop path. This is recorded in `session.ts`'s own
comments; repeated here because a probe record is exactly where a future
reader should be able to find the run-by-run evidence behind that
comment, not just the comment's own assertion of it.

## The one stall — not reproduced, and no tool-attempt was ever actually captured

One run (`run-probe-stall-isolation.sh`, before the cwd fix, cwd = repo
root) produced 292+ seconds of complete silence after turn 2's own `init`
event — no `result`, no `tool_use` block, no partial assistant message, no
content of any kind — ending only in a forced kill (SIGTERM, exit 143).
**The belief that this was "a tool-attempted turn that hung" was an
inference from the prompt that had been sent, not a finding established by
anything the stream actually recorded.** That inference was carried and
reported to the operator as a finding for several hours before it was
checked against the raw file and retracted.

Three runs since, under three different single-variable changes
(`--permission-mode dontAsk` added; cwd pinned to `probe/` and the exact
same stall-isolation script rerun as a baseline; the gitkraken-hooks
plugin confirmed still present throughout, so its removal is not what
changed), have not reproduced it. The only observed difference between the
hang and every later run is `cwd` (repo root vs. the `probe/`
subdirectory) — with hooks, memory and CLAUDE.md all reachable once
`--safe-mode` is off, cwd selects what loads, and something specific to
running from the repo root is the leading, still-unconfirmed suspect. This
repo's own root was checked directly and holds no `CLAUDE.md`, no
`.claude/` directory, and no project-level `.mcp.json` — so if cwd is
genuinely the variable, whatever is responsible sits outside this
repository (global `~/.claude/` config, ancestor-directory lookup, or
something else this investigation had no read access to check).

**Status: intermittent and unexplained, not solved.** One observation,
three non-reproductions, a plausible but unproven association with cwd.
For a held-session design this is the worse of the two possible verdicts —
a fleet of runners could wedge occasionally with no advance signal — which
is why `SESSION_TURN_TIMEOUT_MS` in `session.ts` is what actually defends
against it, not a resolved root cause.

## `permission_denials` — the only denial signal, never yet observed non-empty

Every probed `result` event carries a `permission_denials` field, and it
is `[]` in every single run in this record — because in every run, either
the tool was never advertised at all (nothing needed denying) or the model
never attempted a call. This repo has never yet observed a *non-empty*
`permission_denials` array. Its shape when populated (what each entry
contains, keyed by what) is therefore relayed from the operator's channel
to the CLI, not confirmed by anything this repo has directly seen.

## The boundary race — exit 0 vs exit 143 is not a reliable signal alone

Several of these scripts hold stdin open for a trailing `sleep
"$WATCHDOG_SECS"` after the last real message, deliberately, so a slow but
real turn is never cut off mid-flight. The outer watchdog loop separately
polls `kill -0` once a second for up to that same `WATCHDOG_SECS` before
sending its own `kill`. When the `claude` process's own natural exit
(stdin EOF once the subshell's own sleep finishes) lands within about a
second of the outer loop's deadline, which one "wins" — a natural exit
(code 0) versus a forced kill (SIGTERM, code 143) — is a timing
coincidence between two independently-running timers, not evidence either
way about whether the CLI hung. One run in this record showed the timing
log's own "still running after 300s, killing now" line fire even though
both expected results had, in fact, already been produced. Exit code alone
should never be read as proof of a hang or a clean finish in this probe
family without also reading the timing log and the actual event count.

## What this record is, and is not

This is a record of probe evidence — manually-run, single-operator-machine
invocations of one CLI version, more than one of which changed more than
one variable at a time despite best efforts, several of which were later
found to have been misread by whoever was reporting on them in the moment
(including more than once by this record's own author, in this same
investigation). It is not a specification of CLI behaviour. No code should
be written as though any single result here is a guaranteed contract
rather than an observation on one machine, one version, one day. Where
`session.ts` depends on one of these observations — MCP reachability
without `--safe-mode`, `--disallowedTools "*"`'s MCP-filtering bug, the
turn-level envelope shape — that dependency is named in `session.ts`'s own
comments; this file exists so a future reader has the run-by-run evidence
behind those comments in one place, with its limits stated plainly rather
than implied.