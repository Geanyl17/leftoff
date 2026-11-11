---
name: leftoff
description: Records session progress into Left Off (the user's dashboard of every project's last session and open tasks), hands work between the user's coding agents, and reaches the user's saved servers and passwords. Use this whenever a task gets finished, shipped, started, blocked or given a deadline; when picking up work another agent or chat left behind, or handing work to one; when the user is wrapping up, stepping away, switching projects or changing direction mid-conversation; when they need one of their servers or passwords ("ssh into the prod box"); or when they say "log this", "save progress", "update left off", "what was I doing", "what's still pending". Also use it before ending any session where real work got done, even if the user didn't ask.
---

# Left Off

Left Off is where the user keeps track of every project: what got done last session, and every open task. It is also how the user's coding agents (Claude Code, Codex, Kimi) hand work to each other: whichever one opens a project gets the same brief and continues from it. The user reads it to find their place, and may show it to other people. Keep it true, current, and plain enough for someone who wasn't in the session.

Everything goes through the `leftoff` command. It only writes Left Off's own data, so run it without asking.

**The user's own rules.** If `~/.config/leftoff/local.md` exists, read it now. It holds what is specific to this user: which projects other people can see, where requests get filed, naming rules. Where it disagrees with this file, it wins.

## Which project

`leftoff` records into the project whose folder you are in, and a task id belongs to one project. **Record under the project the work was for.**

- **Git worktrees record into their main project on their own.** A plain copy or a separate clone is not a worktree.
- **Working on one project from another folder** (a notes or ops folder, a sibling repo)? Add `--project <folder name>` to every command, or the work lands under the wrong project.
- The brief covers only the folder's own project. `leftoff status --project <name>` shows another one.

## The model

Every open task sits in one of four columns:

| Column | Means | Command |
|---|---|---|
| To do | committed, and nobody is on it right now | `leftoff move <task> todo` |
| Doing | someone is working on it now: you, another chat, or a worker you handed it to | `leftoff move <task> doing` (or `leftoff start "<new title>"`) |
| Waiting | the next step belongs to someone other than the user and their agents: a client, a boss, a coworker, a vendor | `leftoff move <task> waiting` |
| Done | finished the way the user would say it | `leftoff done <task>` |

On top of that:

- `leftoff flag <task>` / `unflag`: marks it important. Priority is a flag, not a column. Flag what the user or a requester called important or urgent, not your own follow-ups.
- `leftoff due <task> <YYYY-MM-DD|none>`: a deadline. Only record dates the user or a requester actually gave; never invent one.
- `leftoff label <task> check|idea|work`: `check` means built but the user needs to look at it or give a go-ahead. `idea` is a suggestion nobody committed to; it stays out of the brief's lists.
- `leftoff goal <task> "<goal title>"`: files it under a goal (an outcome with a date).

`<task>` is the id in brackets from the brief, like `[q04t]`. **Always give the id.** Without one, `leftoff done` and `leftoff update` act on the task in Doing, which may be another chat's.

**Waiting is never for the user.** When the next step is the user's own (look at it, approve a deploy, hand over a list), tell them in the conversation, label the task `check`, and open the note with what they need to decide.

## What gets a task

- **A task is a deliverable the user would recognise:** a feature, a fix, a report, a setup, a decision.
- **Steps, checks and chores are not tasks:** "deploy it", "retry the deploy", "merge main first", "confirm the page loads", "fix the failing test". They go in the note of the deliverable they belong to, or in the session summary. One task per deliverable.
- **Starting a deliverable that has no task yet?** Add it and put it in Doing (`leftoff start "<title>"`), even if you expect to finish this session. If the session is cut off, that task is what the next one picks up. A small fix done in passing needs no task; `leftoff did` covers it.
- **Look before you add.** `leftoff status --all` lists every open task. If one already covers the work, update it instead of adding a second.

## Writing a task

- **Title: one plain line saying the outcome**, e.g. "Let customers download their invoices", not "PR #8 + INVOICE_WEBHOOK_SECRET". For work nobody outside will notice, say what it protects or speeds up: "Keep the database from filling the server", not "Trim dead rows".
- **Not in a title:** passwords, hosts or IPs, security holes, PR numbers, commit ids, branch names. Those go in the note.
- **Note: open with one plain sentence on where it stands**, because the brief shows only the first 300 characters. Then who asked and who it waits on, then the technical detail (PRs, commits, files).
- **`--note` replaces the whole note.** To keep what is there, read it first with `leftoff show <id>`, then write back the full current note with the newest state on top, not a dated line appended at the bottom.
- **`--next "<the single next step>"`** (on `leftoff update`) shows under the note in the brief. Change it when the next step changes.
- **Done means done the way the user would say it.** If it has to ship, it's done when it's deployed and checked, not when the code is written, the PR is merged or a worker reports back. Until then it's Doing, or To do labelled `check` while it waits for the user's review or go-ahead.
- **Done or drop?** `leftoff done` says something was delivered. A task that turned out moot, or duplicates another, gets `leftoff drop <id>` after anything worth keeping is moved into the surviving task's note. If you can't tell whether the user still wants it, ask.

## At the start

A hook puts a brief in context: the last session, then **Doing**, **Up next** (flagged, due within a week, or to check), **Waiting**, and a count of the rest. If there is no brief, run `leftoff status`. Read it; don't re-explore what it already tells you.

## Picking up from another agent

The user moves between agents and chats, often because one ran out of usage mid-task. The brief is the handoff, so start from it:

- **Each session line and each Doing task says which agent it was and where the work is** (branch, and the worktree folder when there is one). Go to that folder and branch; don't start the work again somewhere else.
- **`leftoff show <id>`** prints one task in full: the whole note, the next step, where the work is, its history, and the command that reopens the session that last touched it. Read it before continuing a task you didn't start.
- **"Not recorded: a … session stopped …"** in the brief means the last agent was cut off before it wrote anything down. Run `leftoff tail` to read how that session ended (its last messages and commands, from its own transcript), then check the working tree (`git status`, `git log`) before you continue. `leftoff tail --agent claude|codex|kimi` picks one agent; `leftoff tail --list` lists the recent sessions.
- **Then say in one or two lines what you are picking up and from whom**, and carry on. Don't ask the user to re-explain what the brief, the task and the tail already say.

## Leaving it ready for the next agent

Any session can be the last one before a switch, and it rarely gets a warning. So keep the task itself current while you work, not only at the end:

- **Run `leftoff` from the folder the work is in.** That records the branch and worktree on the task, which is how the next agent finds the code.
- **After each real step** (a commit, a passing check, a decision), update the task: `leftoff update <id> --note "<where it stands now>" --next "<the single next step>"`. Put uncommitted work in the note too: which files, and whether it runs.
- **`--next` is one concrete action** another agent could do cold: "Run tests/test_billing.py and fix the two rounding failures", not "continue".

## While you work: record as it happens, not at the end

The end of a session is often never reached, and a stale board is worse than none.

- **Finished something on the list? Close it now:** `leftoff done <id>`. Shipped, fixed, decided, answered all count. The same goes for a task you can *see* is already done (deployed, live, file exists) even if another session did it.
- **Picked something up?** `leftoff move <id> doing`.
- **Stopped before it was finished?** `leftoff move <id> todo`, with a note on where it stands. Doing means someone is on it now.
- **Blocked on someone outside?** `leftoff move <id> waiting`, with a note that opens with who and what is needed. `leftoff move <id> doing` (or `todo`) takes it back out when the answer arrives.
- **Left something unfinished, or the user moves on from a fix you suggested?** Record it at that moment: `leftoff task "<title>" --note "<where it stands, next step>"`. Label a mere suggestion `idea`.

## Several agents at once

The user may have several chats and delegated workers on one project at the same time. The brief says who else is working there right now.

- **Only touch tasks your session worked on or checked.** A task in Doing that you don't recognise is probably another chat's; leave it unless the user hands it to you.
- **Handing a task to a worker:** move it to Doing and note who has it.
- **A worker's "ready for review" is not Done.** The task stays in Doing while you review. Accepted but not yet shipped is still not Done.
- **If you are the worker:** leave the board alone. Don't close or move the task you were given, and don't run `leftoff did`; report to the coordinator, who records it after review.

## Before the session ends

1. `leftoff did "<1-3 sentences, past tense>"`, once for each project you did work for (`--project`). Lead with what changed and whether it is live, on staging or waiting for review. Then what's half-done and the next step. What the user needs to find it again (PR, commit, branch) goes last. Leave out how the work was run (which agent, how many tests).
   Running it again in the same session replaces that session's entry, so update it as the work moves rather than saving it for the end.
2. Go through the open tasks you touched once more and close or move whatever changed. Nothing you worked on stays in Doing unless someone is still on it. Anything you added this session that is still open gets a note saying where it stands and the next step.
3. Tell the user in one line what you recorded.

## Projects without a folder

If `leftoff` says the current folder isn't a project, link the session: `leftoff project "<name>"` (an existing project's name if one fits). When its repo gets cloned or created, put it in the projects folder (`leftoff roots`) and run `leftoff bind <folder>`.

## Servers and passwords

The brief lists saved servers. Reach them with `leftoff ssh <name> '<command>'`; keys are handled. Save a new one with `leftoff server add <name> <user@host[:port]> [--key <path>]`.

Use a password without it entering the conversation: `leftoff secret run VAR=<name> -- <command>`. `leftoff secret get <name>` prints it, only when the value itself is needed. To save one, `leftoff secret set <name>` reads it from stdin or a hidden prompt. Never put a value on a command line.
