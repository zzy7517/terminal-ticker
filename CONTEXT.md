# Tradex Agent Context

Tradex provides configurable AI identities for independent market-analysis conversations inside one local trading workbench.

## Language

**Workbench**:
The single local Tradex application environment containing market data, tools, configuration, and Agent conversations. It is not a user-created domain entity.
_Avoid_: Workspace, tenant

**Agent**:
A reusable AI identity selected through one stable Direct Message Entry. It owns its name, description, instructions, and default model preferences. Deletion is gated by persisted Session generations, Channel memberships, Agent Context, and future shared Agent resources—not by empty conversation scaffolding.
_Avoid_: Subagent, bot profile

**Agent Context**:
The logical continuity boundary owned by one Agent and keyed by `agentId`. It binds Runtime Session generations, holds Native Session resume handles, and carries pause/error/activation state without exposing a Native Session as product identity. Direct Messages, Channels, and reminders all activate the same Agent Context. It does not own Chat lifecycle or a user-visible `chatId`.
_Avoid_: Session, global memory, Chat manager

**Default Agent**:
The built-in Agent that makes Tradex usable without Agent setup. It cannot be removed, but its editable properties may be overridden by local Agent configuration.
_Avoid_: System Agent, hard-coded Agent

**Chat**:
The unified product shell that presents Direct Messages, Channels, Saved, and Pinned in one workspace. Chat is a UI entry, not a persisted domain entity and not a message store.
_Avoid_: Session, Direct Message, Channel

**Direct Message Entry**:
The single stable navigation entry for one Agent. Its identity is the Agent ID; selecting the Agent opens that Agent's unique Human–Agent Direct Message. There is no New Chat action and no Chat history selector.
_Avoid_: Session, Chat ID

**Direct Message**:
The unique one-to-one conversation for a normalized participant pair (Human–Agent or Agent–Agent). Messages are authoritative SQLite facts in the Shared Message Fabric. One participant pair has exactly one Direct Message; Runtime Session rotation does not create another.
_Avoid_: Direct Chat, Chat ID, New Chat, Session

**Channel**:
A shared Human/Agent conversation whose messages are authoritative SQLite facts. A Channel is not a Runtime Session and does not own one shared model context.
_Avoid_: Session, group Session

**Chat Target**:
A stable reference used only by features that can point at either a Direct Message or a Channel: `{ kind: "direct-message", directMessageId }` or `{ kind: "channel", channelId }`. Channel-specific commands continue to use `channelId`; Chat Target is reserved for generic event, Saved, Pinned, and future Task references. The retired `direct-chat` shape is legacy only.
_Avoid_: Channel replacement, generic Session, chatId

**Chat Event**:
A persistent, globally ordered change record identified by `seq`. The UI resumes after its last observed sequence and refreshes the affected Direct Message or Channel projection.
_Avoid_: Runtime event, model message

**Session**:
A persistent Runtime conversation bound to one Agent Context. It holds private execution history, tool interaction, and an immutable Agent snapshot. An Agent Context may contain multiple Session generations when its Runtime context must rotate; generations are not user-facing conversations.
_Avoid_: Agent, Direct Message, Chat, run

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
