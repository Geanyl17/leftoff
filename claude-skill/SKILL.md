---
name: leftoff
description: Records session progress into Left Off (the user's desktop dashboard that shows, for each project, what got done last session and which tasks are still ongoing) and reaches the user's saved servers and passwords through it. Use this whenever the user is wrapping up, stepping away, switching to another project or task, changing direction mid-conversation (dropping one bug to chase another, setting aside a fix you suggested), needs one of their servers or passwords ("ssh into the prod box", "check the logs on staging"), or says things like "log this", "save progress", "note where we are", "update left off", "what was I doing here", or "what's still pending". Also use it before ending any session where real work got done, even if the user didn't ask, so the next session (and the user) can pick up where this one left off.
---

# Left Off

Left Off is a desktop app the user keeps open so they don't lose their place across their projects. For each project it shows two things: **what got done last session** and **ongoing tasks**. Both come only from the `leftoff` command. If nothing gets recorded, the user opens the app tomorrow and sees nothing useful, which is the problem the app exists to fix. The commands only write to Left Off's own file (`~/.config/leftoff/threads.json`), so run them without asking.

Run them from inside the project folder (any subfolder works), or add `--project <folder or project name>`.

## When the session isn't in a project folder

If `leftoff` says the current folder isn't inside a project, the work still belongs somewhere. Link this session to a named project with `leftoff project "<name>"`. Use an existing project's name if one fits (for example, the user mentions it), otherwise pick a short name for what the session is about, or ask. After that, `leftoff did` and `leftoff task` work as usual for the rest of the session.

## When the project gets a folder

A project without a folder gets one when its repo is cloned or created. If the user asks you to clone or create the repo for such a project, put it inside their projects folder (`leftoff roots` prints it), then run `leftoff bind <that folder>`. Left Off moves the project's sessions, tasks, servers and passwords onto the new folder, and this session keeps recording into it.

If two folderless projects turn out to be the same thing (say the user made one in the app and you made another), fold one into the other with `leftoff merge <project> <into>`, keeping the one the user named.

## Servers and passwords

The session-start note lists the user's saved servers. Reach them with `leftoff ssh <name> '<command>'` (or `leftoff ssh <name>` for a shell). The key and address are handled, so don't ask the user for them. When the user gives you a new server once, save it so they never repeat it: `leftoff server add <name> <user@host[:port]> [--key <path>]`.

Passwords live in the system keyring. Use one without it entering the conversation, `leftoff secret run VAR=<name> -- <command>`, and reach for `leftoff secret get <name>` only when the value itself is needed. To save one, run `leftoff secret set <name>` and let the user type it into their terminal. Don't put the value on a command line.

## When starting work in a project

`leftoff status` prints the last session's summary and the ongoing tasks. A session-start hook usually shows this already, so run it only when you need the detail. If the user picks up an ongoing task, that's useful context. If they start something new, keep working and record it at the end.

## When the user changes direction mid-conversation

People get sidetracked inside one conversation: halfway through a bug they spot another and chase it, or you suggest a fix and they move on to something else. Whatever gets left behind is exactly what they'll forget, and by the end of a long session it may have scrolled out of view. So record it at the moment of the pivot, not at the end:

- the work being set aside, if it's unfinished: `leftoff task "<title>" --note "<where it stands>"`
- any fix or feature you suggested that they didn't take up: `leftoff task "<title>" --note "Suggested: <what and why>"`

Then carry on with what they asked. One line is enough to tell them ("Noted the webhook retry fix in Left Off for later.").

## Before the session ends, or when the user switches away

1. **Summarize the session:** `leftoff did "<summary>"`
   - Write one to three sentences in the past tense. Say what was built, fixed or decided, name the files or branch, and say what's left half-done. Write it for the user reading it days later, not as a changelog.
   - There's one entry per session. Running it again in the same session replaces the earlier summary, so update it as the work moves on instead of adding a second one.
2. **Record unfinished work as tasks:** `leftoff task "<short title>" --note "<where it stands and the next step>"`
   - Only add real follow-ups the user would want to be reminded of, not every small TODO.
   - Tasks land in Low priority on the user's board. Add `--priority high` only for something urgent or blocking, so the High column stays meaningful.
   - Check `leftoff status` first. If the task already exists, update it instead: `leftoff update "<task>" --note "..."`.
3. **Close finished tasks:** `leftoff done "<task id or part of its title>"`

Then tell the user in one line what you recorded, e.g. "Logged this session and one ongoing task in Left Off."

Example, at the end of a session in a recipe app:

```bash
leftoff did "Added offline caching for saved recipes (src/db/cache.ts) and fixed the duplicate-save bug. Image upload still crashes on Android."
leftoff task "Fix Android image upload crash" --note "Crashes in ImagePicker on Android 15; repro with any photo over 10 MB"
leftoff done "duplicate save"
```

## Other commands

- `leftoff start "<title>"` adds a task and makes it the current one.
- `leftoff resume <task>` makes an existing task the current one again.
- `leftoff drop <task>` deletes a task that no longer matters.
