# ADR-0004: Agent Context and Direct Message identity

- Status: accepted
- Date: 2026-07-19
- Accepted: 2026-07-19
- Supersedes:
  - `0003-agent-context-and-direct-chat-identity.md`
  - `0003-agent-chat-and-channel-identity.md`
- Aligns with: `docs/raft-style-agent-team-design.md` (revised 2026-07-19)

## Context

Phase 1 introduced a Direct Chat model: one sidebar entry per Agent, multiple Chats under that entry, New Chat, and `ChatTarget` shaped as `{ kind: "direct-chat", agentId, chatId }`. `AgentContextManager` was described as owning active Chat lifecycle.

Raft Cursor Agent evidence and the Raft-style Agent Team design revise that boundary:

- Agent-facing targets are stable `dm:@recipient` strings, not user-visible `chatId`s.
- There is no New Chat or Chat history selector in the observed product shape.
- Each participant pair has one Direct Message; each Agent has one logical downstream Agent Context.
- Shared messages live in SQLite; they are not the Agent's private Runtime Session.

Keeping ADR-0003's multi-Chat wording conflicts with the design doc and with the Phase 1.5 code direction already in tree.

## Decision

### Direct Message

- Tradex exposes **one stable Direct Message Entry per Agent** in Human navigation, keyed by `agentId`.
- A **Direct Message** is the unique 1:1 conversation for a normalized participant pair (Human–Agent or Agent–Agent).
- There is **no** user-visible `chatId`, **no** New Chat, and **no** Chat history selector.
- UI, API, and Agent tools all project the same unique DM timeline for that pair.
- Runtime Session rotation (overflow, config change, resume failure) does **not** create a new DM or change DM identity.

### Ownership seams

- **`MessageStore`** owns Direct Message conversation identity and the authoritative DM message timeline in `chat.sqlite3`.
- **`AgentContextManager`** owns the Agent Context boundary keyed only by `agentId`:
  - ensure / status for the Agent Context;
  - bind, rotate, and remove Runtime Session generations;
  - hold Native Session IDs as Runtime-private resume handles;
  - index persisted Pi / Claude Sessions as imported **session generations** (not as separate product Chats).
- `AgentContextManager` does **not** own Chat lifecycle APIs (`ensureActiveChat`, `createNewChat`, `listChats`, `requireChat`).

### ChatTarget

Channel-specific operations continue to use `channelId`.

`ChatTarget` is only for generic features that must reference either a Channel or a Direct Message (Chat events, Saved, Pinned, and future Tasks):

- `{ kind: "channel", channelId }`
- `{ kind: "direct-message", directMessageId }`

`{ kind: "direct-chat", agentId, chatId }` is **retired**. Legacy rows may be read for migration, then rewritten to `direct-message`.

Agent-facing Message Targets remain simple strings (`#channel`, `dm:@handle`, `#channel:<messageId>`) and are parsed into trusted `ChatTarget`s only at the Message Tool boundary.

### Shared facts vs private context

- Channel and Direct Message bodies are authoritative SQLite facts in the Shared Message Fabric.
- They are never appended directly into another Agent's private Runtime Session as the source of truth.
- Inbox / Activation wakes an Agent with bodyless notices; the Agent reads targets on demand through Message Tools.
- Each Agent has one logical Agent Context across DMs, Channels, and reminders.

## Consequences

- Phase 1 multi-Chat / New Chat product surface is removed or treated as migrated legacy.
- Existing Session files remain on disk as execution archives; messages may be idempotently imported into the unique Human–Agent DM.
- Historical multi-Chat data, if any, collapses into one DM timeline rather than staying as archived writable-or-readable Chat entities.
- ADR-0003 documents are historical; implementers should follow this ADR and `raft-style-agent-team-design.md`.
- `CONTEXT.md` vocabulary uses Direct Message (unique per pair) and treats Chat as the UI shell, not a multi-Chat product entity.
- Future Tasks reuse the same `ChatTarget` boundary (`direct-message` | `channel`), not a third conversation identity.

## Rejected alternatives

- Keep multi-Chat + New Chat to match the original ADR-0003 text.
- Let `AgentContextManager` continue to own `chatId` lifecycle.
- Preserve `direct-chat` as the long-term `ChatTarget` kind.
- Use an Agent's private Runtime Session as the authoritative DM message store.
