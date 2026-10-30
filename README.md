# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own Rex or Herdr tab with a dedicated Pi JSONL session. Creating a child keeps the current tab focused. The parent can inspect status, read durable results, steer active work, queue follow-ups, or use `/subagent` to switch to the child's existing tab.

## Requirements

- Pi 1.4.0 or newer
- Node.js 22.19 or newer
- Rex or Herdr on the same host as Pi
- For Herdr: version 0.9.5 or newer, a POSIX shell (tested with zsh), and its Pi integration installed with `herdr integration install pi`

The backend is selected automatically when a run is created: complete Herdr context (`HERDR_ENV=1`, socket, workspace, and pane) takes priority; otherwise `REX_SESSION` and `REX_BLOCK` select Rex. This supports Herdr launched inside Rex, where both sets of variables can be present. Outside either environment, spawning fails before creating run data. Reverse nesting (Rex inside Herdr) is not supported.

Each run retains its selected backend. Management never switches backends on failure. Resume and terminal operations require the original terminal environment and endpoint; moving a parent between backends does not migrate its children.

For Herdr, the plugin finds the official integration in the configured Pi agent directory or `~/.pi/agent/extensions/herdr-agent-state.ts`. It explicitly loads the control bridge and official integration in children, including children using `--no-extensions`. The managed integration file is not modified. The integration must support the `herdr:blocked` event (validated with integration v9). Rex children explicitly load the control bridge and use Pi's built-in OSC 7501 program status for completion and dialogs. For `/subagent` tab switching, enable **Remote Control** in Rex.app under **Settings → Rex Server**. Switching focuses the server block and asks the app to select its current window; a client rejection is shown as an error. Rex uses its standard client selection, including `REX_CLIENT` when set.

## Install

Clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI and tab label, together with generated handles. Handles remain the stable identifiers used by management commands.

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

Use `/subagent` to select an active child and focus its existing tab. Repeated selection reuses the same tab and process. If the child pane is moved to another tab, management follows its terminal identity.

The parent widget shows `starting`, `busy`, `blocked`, `idle`, `error`, or `unavailable`. Extension dialogs report `blocked` through the selected backend's status bridge. Errors and cancelled results are determined from Pi state and JSONL, rather than terminal captures; `wait` returns a nonzero exit code for them.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: their panes close, but their transcripts and metadata remain. Resuming that parent session creates new child tabs, loads their histories, and leaves them idle without replaying the initial task. A surviving child after an abrupt parent exit is rediscovered instead of duplicated.

Suspending interrupts current generation. Only durable history is preserved; in-flight generation and messages already accepted into Pi's in-memory queues are not guaranteed to survive.

`subagent stop` permanently removes a run and its transcript after confirming closure. It closes only the identified child pane, preserving any other panes added to its tab. It refuses to close another Pi session or an unrelated foreground process reusing the terminal.

## Storage and failures

Run data is stored under the Pi agent directory's `subagents/` folder:

- `metadata.json`: CLI-owned configuration, name, and parent-session association.
- `terminal.json`: parent-owned backend endpoint, terminal identity, launch phase, and suspension marker. Rex records also retain the session and server instance.
- `state.json`: child-owned PID, session path, status, and outcome.
- `lifecycle-*.lock`: PID-tagged tickets that serialize parent/CLI lifecycle operations.
- `session.jsonl` and `inbox/`: Pi history and message delivery.

Separate writers prevent a stale child status write from overwriting a rename, terminal identity, or suspension marker. Lifecycle operations use ordered, per-controller tickets and reread metadata after acquiring ownership, so concurrent restores cannot create duplicate children. Suspension intent is saved before closing a live child; if the close response is lost, resume verifies the original terminal is absent before creating another one. Updates use atomic file replacement. Initial multiline task text is stored in a private file and passed through Pi's native `@file` processing; fixed Herdr launcher arguments are shell-quoted, and Rex launches with an argument array. Herdr startup uses `pane run` and verifies the matching Pi session; Rex verifies the child's published session and foreground PID. Neither startup waits for task completion.

A backend failure is `unavailable`, not proof of exit. Endpoint mismatches, uncertain creation replies, and occupied terminals preserve run data. If creation times out, inspect the selected backend before retrying: a tab may already exist. Without a confirmed terminal identity, `stop` preserves the record rather than closing a guessed tab. No automatic creation retry or force-cleanup option is provided.

Lifecycle tickets are removed on completion or a caught failure. After an interrupted operation, the next controller reclaims only tickets whose PID is confirmed dead. A live owner is never displaced. Invalid owner records are preserved for inspection instead of being guessed away.

## Development checks

```sh
npm test
```

The suite includes automatic-selection, CLI boundary, ownership failure, and storage tests, plus real Rex/Pi and Herdr/Pi tests using a deterministic local provider. Real tests create disposable tabs and restore focus after cleaning up their own terminals. Run `npm test` once inside Rex and once inside Herdr to exercise both backends; tests for the other backend skip. Each real test prints an evidence directory with reports and command results.

The supported baseline is local Rex and Herdr. SSH, multi-server operation, server restart recovery, reverse nesting, and sustained concurrency stress are not covered by these checks.
