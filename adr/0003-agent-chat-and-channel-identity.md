# ADR-0003: Agent Chat and Channel identity

Status: Superseded

Date: 2026-07-18

Superseded-by: `0004-agent-context-and-direct-message-identity.md`

> **Superseded.** Multi Direct Chat / New Chat / `direct-chat` targeting below is historical.
> Follow ADR-0004 and `docs/raft-style-agent-team-design.md` instead.

## Decision (historical)

- A Direct Message Entry is keyed by `agentId` and appears once in navigation.
- A Direct Chat is keyed by `chatId`; one Agent can own multiple Chats, with at most one active Chat.
- Human `New Chat` creates a clean Chat and archives the previous active Chat.
- A Tradex Session belongs to one Chat generation. Runtime-driven Session rotation does not create a new Chat.
- A Channel is a shared SQLite conversation and never reuses an Agent's private Session as its message store.
- The removed global Memory pipeline is not reused. A future Agent memory implementation must be scoped by trusted `agentId` at the Agent Context seam.

## Consequences (historical)

- Existing Sessions are indexed as imported Chats without rewriting their files.
- Future Tasks can target `{ kind: "direct-chat", agentId, chatId }` or `{ kind: "channel", channelId }` without introducing another conversation identity.
- Historical Chats are readable but not writable in the first implementation.
