# Background assignments and schedules

Stage 8, local implementation, November 12, 2026, The Tasks section is available on the web and desktop with schedules enabled by the administrator.

## Use of use

Create a task: the title, the instruction, the existing conversation for the result, the model and tools included. You can select the versions of the skills and the connections of the MCP. The answer is added to the selected conversation with its context. Closing the task page does not stop the work.

Manual start-up is supported, every hour at a selected minute, daily and weekly. IANA time zone is indicated for the schedule; the form shows the near start-up time; the interface language does not change the time zone; Search, set-up, pause/resume, history, transition to the result, cancellation and manual repetition of the unsuccessful start-up are available.

The pause cancels the pending launches, but does not stop the one already running. Manual launch is possible on pause. Changing the settings cancels the waiting launches with the old configuration. Repeat is performed with the current settings and requires confirmation that previously performed external actions can be repeated.

## Politicians.

- After idle: skip or perform one missed start, many missed periods are not played in a row, delay more than 120 seconds is considered a missed start.
- If the previous launch is still running: skip or wait. No more than one pending launch is allowed per schedule; additional periods are marked as combined/missed.
- If the local device is not on the network, skip or wait for the connection. There is no automatic transfer of commands to the server.
- Maximum wait before launch: 60 minutes by default, from 1 to 1,440 minutes. queue check is performed every 5 seconds, try again during temporary employment - after 15 seconds.
- DST: Non-existent local time is skipped; repeat time is done once; for the weekly rule, the missed day is moved to the next suitable week.

## Compliance and rights

The scheduler works in an existing worker. You can close the browser/desktop for a server assignment; the server and the worker must work; local teams need a connected desktop with the selected work folder; and the workspace is fixed, and changing the workspace leads to a WORKSPACE_CHANGED error rather than execution in another folder.

Teams and MCP keep the usual confirmations in the conversation. The schedule does not allow the tools to be executed without the user. Before staging and when executing, the owner, membership in the organization, access to the project, the model and functions included, apply a general limit of parallel user responses and prohibit simultaneous launches in one conversation.

Each user sees only their own tasks. Creation, modification, inclusion, staging, cancellation and submission for execution are recorded in the audit.

## Storage and restoration

The 014_schedules migration adds schedules and schedule_runs. The first transaction captures the next schedule occurrence and promotes the next_run_at. Unique keys and FOR UPDATE SKIP LOCKED protect against two schedulers. A separate transaction simultaneously creates chat_run and links it to schedule_run; queued chat_run is the long-term outbox of an existing dispatcher pg-boss.

If the process stops before sending, the intent remains in PostgreSQL. Re-delivery does not create a second chat_run. Once execution begins, the unknown external action result does not automatically repeat: the launch receives a terminal status, the user can repeat it explicitly. The guarantee is not-once for external APIs exactly.

## The boundaries of the first version

There are no arbitrary cron expressions, monthly schedules and a separate single launch date. Up to 100 tasks per user, history shows the last 100 launches of the task. Deletion/archivation of tasks and external notifications have not yet been implemented; unnecessary tasks can be paused. Context of the conversation grows with repeated launches; this stage does not add automatic context reduction. Unknown network errors are shown as a failed start, without automatically repeating a paid model request.

## Updating phase 19

The editor is divided into four steps: task, place/result, time, rules. Added maximum launches,
schedule stops after an error, selection of the model-arbitrator through the mode authorized by
the administrator and private marks of new results. Exact saved permissions from the account are
valid; the schedule does not cancel the ACL and restrictions of the selected place. Selecting
the mode in a normal conversation does not change the mode of the already created schedule.
