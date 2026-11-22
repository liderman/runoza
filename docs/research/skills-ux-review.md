# Skills: Current semantics and direction of UX

12.11.2026. the study of implementation, without changing behavior.

ExtensionPicker combines skills and MCP in the Next query Extension dialog. Specific versions
are selected; access is limited to the user and the project. packages/chat/src/index.ts rechecks
the ACL and records the text of instructions and versions in chat_runs. Skills update does not
change the launch already started. Skills are model instructions; MCP accesses tools.

Problem: the total number of extensions doesn't explain what's included. The choice of version
in the main dialog reveals the internal storage model instead of the human task.

It is proposed to investigate: the names of active skills near the composer; separate display of
instructions and tools; description of the content and source; choice by name with additional
fixation of the version; explicit scope of "next request" or "conversation"; search and unselect
from the keyboard. Connection by project requires explicit setting, there is no hidden
auto-connection.

These are candidates for a separate UX solution. Creating skills from conversations postponed.
Sources: packages/app/src/ExtensionPicker.tsx, packages/chat/src/index.ts,
apps/server/src/extensions.ts.
