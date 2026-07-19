# Keep one Tool definition with Runtime-specific transports

Tradex defines each Agent-facing Tool once in a Runtime-neutral registry. Pi SDK invokes that registry through an in-process adapter, while external coding-agent Runtimes such as Claude Code use an authenticated MCP transport; Pi is not forced through loopback MCP merely to make the transports look identical. This preserves Pi's cancellation, progress, image, details, and termination semantics without duplicating business tools, while MCP provides a structured and reusable boundary for external processes.

## Consequences

Tool policy and input/result contracts must not depend on Pi types. External Runtime exposure is deny-by-default and explicitly allowlisted, so adding a Tool does not automatically grant it to Claude Code or a future Codex Runtime.
