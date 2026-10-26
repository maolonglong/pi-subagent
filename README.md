# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own Rex tab with a dedicated Pi JSONL session. The tab appears when the child starts, while the parent keeps focus. Select the tab or use `/subagent` to switch to the child. The parent can inspect status, wait for durable results, steer active work, or queue follow-ups.

## Requirements

- Pi
- Node.js 22.19 or newer
- Rex with the window API

Run Pi inside a Rex terminal. Spawning requires `REX_SESSION` and `REX_BLOCK`.

## Install

Clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Use `subagent --help` (or `-h`) to show usage. Each subcommand also accepts these flags, for example `subagent spawn --help`. Help works without Rex or model configuration.

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

Use `/subagent` to select an active child and switch to its Rex tab. Select the parent's tab to return. Selecting the child again focuses the same tab and process. A completed child keeps its tab until stopped; `subagent stop` closes the terminal and removes its transcript and metadata.

The parent widget shows names and states, including `blocked` when a child is waiting on an extension dialog and `unavailable` when its terminal backend cannot be reached. Rex also receives native working, blocked, done, and error status updates; cancelled work reports idle. Child statuses are mirrored into the parent's terminal so Rex can show progress while the parent tab is active. Results still come from Pi's JSONL session, not terminal captures.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history in visible Rex tabs, while keeping the current tab active. `subagent stop` removes a run permanently.

Rex runs on the same host as Pi and the run files. Its launcher receives the parent's `PATH` and `PI_CODING_AGENT_DIR`; other variables come from the Rex server environment. Backend connection failures preserve run data. If creation times out before a block ID is returned, inspect Rex before retrying: the terminal may already exist. `subagent stop <handle>` looks up a missing block ID by the stable block label, closes the matching terminal, or removes the failed record when Rex confirms no match. It preserves the record if Rex is unreachable or multiple blocks match.

## Upgrading from the tmux version

This fork uses Rex only and does not read or migrate tmux run records. Before upgrading, use the tmux version's `subagent list` and stop the runs you no longer need. Stopping deletes each run's transcript and metadata, so copy any history you want to keep first. Existing tmux sessions must be managed with the old plugin or tmux; the Rex version cannot stop them.

## Development checks

```sh
npm test
```

The suite checks Rex failure handling and rejects spawning outside Rex. When run inside Rex, it also exercises visible child tabs and real Pi sessions, including tab focus through `/subagent`, `/reload`, permission dialogs, and parent shutdown/resume. Model responses come from a deterministic test provider with no network requests. Integration checks skip when `REX_SESSION` is unset. Each integration test prints the temporary directory containing its fixtures, transcripts, and result report.
