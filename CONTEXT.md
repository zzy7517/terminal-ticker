# Tradex Agent Context

Tradex provides configurable AI identities for independent market-analysis conversations inside one local trading workbench.

## Language

**Workbench**:
The single local Tradex application environment containing market data, tools, configuration, and Agent conversations. It is not a user-created domain entity.
_Avoid_: Workspace, tenant

**Agent**:
A reusable AI identity selected when creating a Session. It owns its name, description, instructions, and default model preferences, and cannot be removed while any Session belongs to it.
_Avoid_: Subagent, bot profile

**Default Agent**:
The built-in Agent that makes Tradex usable without Agent setup. It cannot be removed, but its editable properties may be overridden by local Agent configuration.
_Avoid_: System Agent, hard-coded Agent

**Session**:
A persistent conversation created for one Agent. It contains the conversation history and an immutable snapshot of the Agent configuration selected at creation.
_Avoid_: Agent, run

**Native Session**:
A Runtime-owned conversation identity used only to resume that Runtime's model context. It is referenced by a Tradex Session but is not the Tradex Session's product identity or message store.
_Avoid_: Session, run

**Runtime**:
The execution backend that runs an Agent Session. Tradex currently supports the embedded Pi SDK Runtime and the local Claude Code Runtime; future external coding-agent Runtimes use the same product boundary.
_Avoid_: Provider, model

**Tool**:
A single Agent-facing Tradex capability with one canonical name, input contract, execution behavior, and result contract. A Tool is defined once even when multiple Runtimes can invoke it.
_Avoid_: Pi tool, MCP tool

**Tool Transport**:
The Runtime-specific mechanism used to expose a Tool without redefining it. Pi SDK uses an in-process adapter; external coding-agent runtimes may use MCP.
_Avoid_: Tool implementation, Runtime
