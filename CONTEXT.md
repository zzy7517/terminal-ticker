# Tradex Agent Context

Tradex provides configurable AI identities for independent market-analysis conversations inside one local trading workbench.

## Language

**Workbench**:
The single local Tradex application environment containing market data, tools, configuration, and Agent conversations. It is not a user-created domain entity.
_Avoid_: Workspace, tenant

**Agent**:
A reusable AI identity selected through one stable Direct Message Entry. It owns its name, description, instructions, and default model preferences. Empty Chats are lifecycle scaffolding and do not prevent deletion; persisted Session generations and future shared Agent resources do.
_Avoid_: Subagent, bot profile

**Agent Context**:
The logical continuity boundary owned by one Agent. It validates Agent/Chat identity, selects the active Chat, and binds Runtime Session generations without exposing a Native Session as product identity. Channel activation will reuse this boundary in Phase 2.
_Avoid_: Session, global memory

**Default Agent**:
The built-in Agent that makes Tradex usable without Agent setup. It cannot be removed, but its editable properties may be overridden by local Agent configuration.
_Avoid_: System Agent, hard-coded Agent

**Direct Message Entry**:
The single stable navigation entry for one Agent. Its identity is the Agent ID; creating New Chat does not add another entry.
_Avoid_: Session, Chat

**Chat**:
One Human-to-Agent conversation under a Direct Message Entry. A Chat has its own Chat ID and clean model-context boundary. One Agent can have multiple Chats, but only one is active and writable in the first implementation.
_Avoid_: Session, Agent

**Channel**:
A shared Human/Agent conversation whose messages are authoritative SQLite facts. A Channel is not a Runtime Session and does not own one shared model context.
_Avoid_: Session, group Session

**Chat Target**:
A stable reference used only by features that can point at either a Direct Chat or a Channel. Channel-specific commands continue to use `channelId`; Chat Target is reserved for generic event, Saved, Pinned, and future Task references.
_Avoid_: Channel replacement, generic Session

**Chat Event**:
A persistent, globally ordered change record identified by `seq`. The UI resumes after its last observed sequence and refreshes the affected Direct Chat or Channel projection.
_Avoid_: Runtime event, model message

**Session**:
A persistent Runtime conversation inside one Chat. It contains message history and an immutable Agent snapshot. A Chat may contain multiple Session generations when its Runtime context must rotate.
_Avoid_: Agent, Chat, run

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
