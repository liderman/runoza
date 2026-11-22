# Skills and MCP

Local delivery of phase 7, `012_run_capacity` migration and `013_extensions`. Provided for inclusion by the administrator in the "Available functions".

**The known problem of 14.11.2026:** UI is now mistakenly blocking all flags except chat;
code/skills/MCP/schedules are turned off in the newly deployed core organization. The following
describes the existing mechanics, not the availability confirmation in this installation.
[architecture](architecture.md) and [fix plan/new UX](functional-recovery-plan.md).

## Skills

On the side menu, open Extensions → Skills. Skill contains the name, description and multi-line instructions. Visibility: personal, project or organization. Project skills are available to project participants; they can be changed by the author with the right to enroll in the project. The administrator does not gain access to other people's personal skills.

Publishing creates an immutable version. The New Version button doesn't change previous launches. In conversation, open Extensions next to the model and select the desired versions. The launch captures their identifiers, names and contents; the version is visible in the execution history. Up to 10 versions, totaling up to 64,000 instruction characters, within the overall context budget. In the first delivery, text skills: file packets, SKILL.md imports and executable plugins are not yet supported.

## MCP connections

The system administrator creates connections in Extensions → MCP: Streamable HTTP address or stdio command, list of allowed tool names, availability for selection. For the saved HTTP connection, you can request a tool catalog. Detection does not automatically allow tools. Each user saves the Bearer key separately; it is encrypted with a user-specific connection and is not issued to other users. Changing the configuration resets the private keys so that the previously issued secret is not sent to the new address.

In the conversation, select the workspace and up to four connections. The agent receives `mcp_list` and `mcp_call`. Before the action requires confirmation in the chat; you can see the server, command/address and arguments, but not the key. Unauthorized tool is rejected before accessing the server. The connection is disabled or changed after the confirmation request is not executed.

HTTP is executed by the server infrastructure and does not occupy Open Terminal. Stdio runs only in the selected executor: on the local device or in the server workspace. The command is set by an array of arguments (one per line), without interpreting the shell. Runoza does not install programs automatically and does not load plugins into a trusted worker. The executable file and Python 3 must already be present in the work environment.

## Network and limitations

By default, public HTTPS is allowed on port 443. URLs with credentials, query or fragment are prohibited; redirect is not executed. DNS addresses are verified and the selected address is assigned to the connection. For internal corporate servers, the operator sets the exact origins through `MCP_ALLOWED_INTERNAL_ORIGINS`; metadata/link-local addresses remain prohibited. Do not use this parameter as a global circumvention of network policy.

Implemented tools and Streamable HTTP (JSON/SSE response to POST) on MCP 2025-06-18, coordination also from 2024-11-05 and 2025-03-26. Operation limits: 30 seconds and 1 MiB response; directory up to 100 tools/10 pages. Unknown call result is not repeated automatically.

While there are no OAuth MCP, legacy HTTP+SSE, resources/prompts/sampling, permanent stdio sessions, packet installation or marketplace. Each stdio operation runs a separate process: servers with a state between calls require further work. POSIX/Python 3 implementation tested; Windows is not declared supported. IPv6-only remote endpoints are not yet supported. Stdio keys through the environment are not yet transmitted. This is a limited implementation of the client tools, not a full implementation of the entire MCP standard.

Protocol sources: [Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
