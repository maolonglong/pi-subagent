---
name: subagent
description: Delegate bounded reviews, investigations, or implementation to separate Pi sessions in Rex or Herdr; collect results, steer work, and manage follow-ups.
---

# Subagent

Use the `subagent` CLI inside Rex or a Herdr-managed pane. Creation selects Herdr when its complete caller context is present, including when Herdr runs inside Rex; otherwise it selects Rex. Each run keeps that backend for management and recovery. Each child has its own context and tab; it does not inherit the parent conversation. Managed children cannot spawn nested subagents and do not receive this skill.

## Delegate

Give the child a bounded task: goal, relevant paths or files, constraints, expected output, and completion criteria. Keep work that requires shared parent-session context in the parent.

```sh
subagent spawn --name review --prompt "Review shared.ts for data-loss bugs. Read its callers and tests. Report concrete triggers and file:line evidence; leave files unchanged."
```

The child inherits the current provider, model, and thinking level from the bash environment. Omit `--provider`, `--model`, and `--thinking` unless deliberately selecting another configuration; pass chosen values rather than echoing `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL`.

`--cwd` defaults to the current directory. Repeat `--prompt` and `--file` to supply material for the first user turn. Run spawn directly and retain its generated handle. The name is a display label; management commands use the handle. Creation opens a new tab without changing focus.

## Observe and collect

```sh
subagent list
subagent status <handle>
subagent wait <handle> --timeout 45
```

Use `list` to rediscover handles. Set the bash tool timeout longer than the CLI wait timeout. A bounded wait lets you check progress and report updates; timeout ends only that wait, not the child.

`wait` reads durable Pi session state and prints the latest final assistant response. Run it directly so the result returns to the parent; redirect only when the user requests an artifact. Collect a result before sending another task when you need to report both replies. Terminal captures and the terminal's completion badge alone do not establish task success.

## Continue or finish

```sh
# Idle: start another task. Busy: steer current work.
subagent send <handle> "Focus on error handling"

# Busy: run another turn after the current work finishes.
subagent send <handle> --follow-up "Then summarize the remaining risks"

subagent rename <handle> "error handling review"
subagent stop <handle>
```

Use `send` for delegated messages. Keep a completed child only for concrete follow-up work; otherwise stop it. Completion and `wait` leave the child alive. Before stopping, retain any result or history you need: `stop` closes the identified child pane and deletes that run's transcript and metadata after confirmed closure. Other panes in the tab are preserved.

Use `/subagent` to select a child and focus its existing tab; select the parent's tab to return. Selection follows a child moved to another tab. In Rex, tab switching requires Remote Control enabled in Rex.app under Settings → Rex Server; a rejected client action is reported in the parent.

Parent `/reload` preserves children. Parent quit or session replacement interrupts running children; resuming the parent restores their durable history idle, without replaying the initial task. In-flight generation and in-memory messages are not guaranteed to survive interruption.

## Tools and isolation

For implementation, omit `--tools` to retain the configured tools. Defaults vary with Pi, extensions, and MCP configuration; a tool allowlist alone does not isolate extension behavior.

For an independent repository review, disable normal extension and skill discovery and request read-only built-in tools:

```sh
subagent spawn --name review --no-extensions --no-skills --tools read,grep,find,ls --prompt "Review shared.ts and its callers; report concrete findings without changing files."
```

Choose isolation flags for the task:

- `--no-extensions`: disable normal extension discovery; managed control and backend status bridges remain loaded.
- `--no-skills`: hide installed skills for a task fully specified by its prompt and files.
- `--no-prompt-templates`: disable prompt-template commands.
- `--no-context-files`: ignore repository instructions such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation; retain them for implementation.

If tests or shell commands are required, include `bash` in `--tools` or keep the configured defaults. Bash can modify files; describing a task as read-only is not a tool restriction.

## Handle incomplete or failed runs

Read the CLI error and current status before choosing the next action. A nonzero `wait` exit can mean task failure, cancellation, timeout, or an unavailable backend.

| Condition | Action |
| --- | --- |
| Wait timed out; child is starting or busy | Continue waiting or send a useful steer. Reuse the same handle. |
| `blocked` | Open the child with `/subagent` for user input. Messages do not answer the dialog. |
| Spawn failed or timed out | Inspect `subagent list` and existing tabs in the selected backend before retrying; creation may already have succeeded. |
| `unavailable` or terminal identity/reuse error | Preserve run data. Restore the connection or verify ownership before management; uncertainty is not proof of exit. |
| Task error or cancellation | Report the failure; keep the child only for concrete recovery work, otherwise retain the needed result and stop it. |
| Lifecycle operation already in progress | Let its owner finish, then retry. Confirmed dead-owner tickets are reclaimed automatically; invalid owner records require inspection. |

For setup, compatibility, and storage details, read [README.md](../../README.md).
