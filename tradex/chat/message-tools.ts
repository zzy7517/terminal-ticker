import type { AppRuntime } from "../api/runtime.js";
import { ToolRegistry, type ToolDefinition } from "../agent/tools/registry.js";
import { channelTarget, directMessageTarget, type ChatTarget } from "../channel/domain.js";
import { parseMessageTarget, type MessageActor } from "./message-target.js";
import { appendChannelMessageAndNotify, wakeRecipients, resolveRecipients } from "./dispatch.js";
import { HUMAN_OWNER_ID } from "./message-store.js";
import { readPrivateMemory, writePrivateMemory } from "../agent/private-workspace.js";

const BOTH = ["pi", "claude-code"] as const;

function text(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: ToolDefinition["execute"],
  access: "read" | "write" = "read",
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    execute,
    policy: { access, domain: "other", runtimeExposure: BOTH },
  };
}

export function createMessageToolRegistry(runtime: AppRuntime, agentId: string): ToolRegistry {
  const registry = new ToolRegistry();
  const actor: MessageActor = { type: "agent", id: agentId };
  const resolver = {
    resolveChannelName(name: string) {
      const channel = runtime.channelStore.listChannels().find((item) => item.name === name);
      return channel?.id ?? null;
    },
    resolveDirectMessage(_actor: MessageActor, recipientHandle: string) {
      if (recipientHandle === HUMAN_OWNER_ID || recipientHandle === "human" || recipientHandle === "owner") {
        return runtime.messageStore.ensureHumanAgentDm(agentId).id;
      }
      const other = runtime.agentStore.get(recipientHandle);
      if (!other) return null;
      return runtime.messageStore.ensureAgentAgentDm(agentId, other.id).id;
    },
  };

  const resolveTarget = (raw: string): ChatTarget => parseMessageTarget(raw, actor, resolver).chatTarget;

  registry.register(tool(
    "message_check",
    "List unread inbox items for this Agent. Returns metadata only, never message bodies.",
    { type: "object", properties: {}, additionalProperties: false },
    async () => {
      const items = runtime.inboxStore.listPending(agentId);
      return text({
        unreadTargets: items.length,
        items: items.map((item) => ({
          id: item.id,
          target: item.target,
          reason: item.reason,
          firstMessageId: item.firstMessageId,
          latestMessageId: item.latestMessageId,
        })),
      });
    },
  ));

  registry.register(tool(
    "message_read",
    "Read messages for a Channel or DM target.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        limit: { type: "number" },
        before: { type: "number" },
        after: { type: "number" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    async (args) => {
      const target = resolveTarget(String(args.target ?? ""));
      assertCanRead(runtime, agentId, target);
      if (target.kind === "channel") {
        const page = runtime.channelStore.listMessages({
          channelId: target.channelId,
          beforeSeq: typeof args.before === "number" ? args.before : null,
          limit: typeof args.limit === "number" ? args.limit : 50,
        });
        const channel = runtime.channelStore.getChannel(target.channelId);
        return text({
          target,
          channelVersion: channel?.version ?? null,
          messages: page.messages,
          nextBeforeSeq: page.nextBeforeSeq,
        });
      }
      const page = runtime.messageStore.listMessages({
        directMessageId: target.directMessageId,
        beforeSeq: typeof args.before === "number" ? args.before : null,
        afterSeq: typeof args.after === "number" ? args.after : null,
        limit: typeof args.limit === "number" ? args.limit : 50,
      });
      return text({ target, messages: page.messages, nextBeforeSeq: page.nextBeforeSeq });
    },
  ));

  registry.register(tool(
    "message_search",
    "Search messages in targets this Agent can read.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async (args) => {
      const readableDmIds = runtime.messageStore.listConversationsForAgent(agentId).map((dm) => dm.id);
      const channelHits = runtime.channelStore.listChannels()
        .filter((channel) => runtime.channelStore.listAgentMemberIds(channel.id).includes(agentId))
        .flatMap((channel) => {
          const page = runtime.channelStore.listMessages({ channelId: channel.id, limit: 100 });
          return page.messages
            .filter((message) => message.content.toLowerCase().includes(String(args.query ?? "").toLowerCase()))
            .map((message) => ({ target: channelTarget(channel.id), message }));
        });
      const dmHits = runtime.messageStore.search({
        directMessageIds: readableDmIds,
        query: String(args.query ?? ""),
        limit: typeof args.limit === "number" ? args.limit : 20,
      }).map((message) => ({ target: directMessageTarget(message.directMessageId), message }));
      return text({ results: [...dmHits, ...channelHits].slice(0, typeof args.limit === "number" ? args.limit : 20) });
    },
  ));

  registry.register(tool(
    "message_send",
    "Send a message to a Channel, DM, or thread target.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        content: { type: "string" },
        threadRootId: { type: "string" },
        observedVersion: { type: "number" },
      },
      required: ["target", "content"],
      additionalProperties: false,
    },
    async (args) => {
      const target = resolveTarget(String(args.target ?? ""));
      const content = String(args.content ?? "").trim();
      if (!content) throw new Error("content is required");
      assertCanWrite(runtime, agentId, target);
      if (target.kind === "channel") {
        const channel = runtime.channelStore.getChannel(target.channelId);
        if (!channel) throw new Error("Channel not found");
        const observed = typeof args.observedVersion === "number" ? args.observedVersion : null;
        if (observed != null && observed < channel.version) {
          const draft = runtime.channelStore.createHeldDraft({
            agentId,
            channelId: target.channelId,
            observedVersion: observed,
            content,
          });
          runtime.inboxStore.notify({
            agentId,
            target,
            messageId: draft.id,
            reason: "held-draft",
          });
          return text({ heldDraft: draft, published: false });
        }
        const { message } = appendChannelMessageAndNotify(runtime, {
          channelId: target.channelId,
          authorType: "agent",
          authorId: agentId,
          content,
          threadRootId: typeof args.threadRootId === "string" ? args.threadRootId : null,
        });
        return text({ published: true, message, channelVersion: runtime.channelStore.getChannel(target.channelId)?.version });
      }
      const recipients = resolveRecipients(runtime, target, "agent", agentId);
      runtime.inboxStore.ensureReady();
      const message = runtime.messageStore.appendMessage({
        directMessageId: target.directMessageId,
        authorType: "agent",
        authorId: agentId,
        content,
        threadRootId: typeof args.threadRootId === "string" ? args.threadRootId : null,
        onCommitted: (conn, created) => {
          for (const recipientId of recipients) {
            runtime.inboxStore.notifyWithConn(conn, {
              agentId: recipientId,
              target,
              messageId: created.id,
              reason: "dm",
            });
          }
        },
      });
      wakeRecipients(runtime, recipients);
      return text({ published: true, message });
    },
    "write",
  ));

  registry.register(tool(
    "message_read_thread",
    "Read a thread under a Channel or DM root message.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        rootMessageId: { type: "string" },
      },
      required: ["target", "rootMessageId"],
      additionalProperties: false,
    },
    async (args) => {
      const target = resolveTarget(String(args.target ?? ""));
      assertCanRead(runtime, agentId, target);
      const rootMessageId = String(args.rootMessageId ?? "");
      if (target.kind === "channel") {
        return text(runtime.channelStore.listThread({ channelId: target.channelId, rootMessageId }));
      }
      return text(runtime.messageStore.listThread({
        directMessageId: target.directMessageId,
        rootMessageId,
      }));
    },
  ));

  registry.register(tool(
    "message_mark_inbox",
    "Mark an inbox item as read, ignored, or deferred.",
    {
      type: "object",
      properties: {
        itemId: { type: "string" },
        status: { type: "string", enum: ["read", "ignored", "deferred"] },
      },
      required: ["itemId", "status"],
      additionalProperties: false,
    },
    async (args) => {
      const status = String(args.status);
      if (status !== "read" && status !== "ignored" && status !== "deferred") {
        throw new Error("invalid inbox status");
      }
      return text(runtime.inboxStore.mark({
        agentId,
        itemId: String(args.itemId ?? ""),
        status,
      }));
    },
    "write",
  ));

  registry.register(tool(
    "message_list_targets",
    "List Channel and DM targets this Agent can access.",
    { type: "object", properties: {}, additionalProperties: false },
    async () => {
      const channels = runtime.channelStore.listChannels()
        .filter((channel) => runtime.channelStore.listAgentMemberIds(channel.id).includes(agentId))
        .map((channel) => ({ target: `#${channel.name}`, channelId: channel.id, topic: channel.topic }));
      const directMessages = runtime.messageStore.listConversationsForAgent(agentId).map((conversation) => {
        const other = runtime.messageStore.otherParticipant(conversation, "agent", agentId);
        if (!other) return null;
        const handle = other.type === "human" ? "owner" : other.id;
        return {
          target: `dm:@${handle}`,
          directMessageId: conversation.id,
          other: { type: other.type, id: other.id },
        };
      }).filter((item): item is NonNullable<typeof item> => item != null);
      // Ensure Human-Agent DM always appears even before any message.
      if (!directMessages.some((item) => item.other.type === "human")) {
        const humanDm = runtime.messageStore.ensureHumanAgentDm(agentId);
        directMessages.unshift({
          target: "dm:@owner",
          directMessageId: humanDm.id,
          other: { type: "human", id: HUMAN_OWNER_ID },
        });
      }
      return text({ channels, directMessages });
    },
  ));

  registry.register(tool(
    "message_list_members",
    "List members for a Channel target.",
    {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    async (args) => {
      const target = resolveTarget(String(args.target ?? ""));
      if (target.kind !== "channel") throw new Error("message_list_members requires a channel target");
      assertCanRead(runtime, agentId, target);
      return text({
        members: runtime.channelStore.listMembers(target.channelId),
      });
    },
  ));

  registry.register(tool(
    "channel_resolve_draft",
    "Retry, replace, or discard a held draft.",
    {
      type: "object",
      properties: {
        draftId: { type: "string" },
        action: { type: "string", enum: ["retry", "replace", "discard"] },
        content: { type: "string" },
      },
      required: ["draftId", "action"],
      additionalProperties: false,
    },
    async (args) => {
      const result = runtime.channelStore.resolveHeldDraft({
        agentId,
        draftId: String(args.draftId ?? ""),
        action: String(args.action ?? "") as "retry" | "replace" | "discard",
        content: typeof args.content === "string" ? args.content : undefined,
      });
      if (result.publishedMessage) {
        const { wakeRecipients, resolveRecipients } = await import("./dispatch.js");
        const target = channelTarget(result.draft.channelId);
        wakeRecipients(runtime, resolveRecipients(runtime, target, "agent", agentId));
      }
      return text(result);
    },
    "write",
  ));

  registry.register(tool(
    "channel_set_reminder",
    "Create or cancel a reminder for this Agent on a Channel.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        dueAtMs: { type: "number" },
        note: { type: "string" },
        reminderId: { type: "string" },
        cancel: { type: "boolean" },
      },
      additionalProperties: false,
    },
    async (args) => {
      if (args.cancel || args.reminderId) {
        return text(runtime.channelStore.cancelReminder({
          agentId,
          reminderId: String(args.reminderId ?? ""),
        }));
      }
      const target = resolveTarget(String(args.target ?? ""));
      if (target.kind !== "channel") throw new Error("reminder requires a channel target");
      assertCanRead(runtime, agentId, target);
      return text(runtime.channelStore.createReminder({
        agentId,
        channelId: target.channelId,
        dueAtMs: Number(args.dueAtMs),
        note: String(args.note ?? ""),
      }));
    },
    "write",
  ));

  registry.register(tool(
    "memory_read",
    "Read this Agent's private MEMORY.md.",
    { type: "object", properties: {}, additionalProperties: false },
    async () => text({ content: readPrivateMemory(agentId) }),
  ));

  registry.register(tool(
    "memory_write",
    "Replace this Agent's private MEMORY.md.",
    {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
    async (args) => {
      try {
        writePrivateMemory(agentId, String(args.content ?? ""));
        return text({ ok: true });
      } catch (error) {
        // Memory write failure must not roll back shared message / inbox state.
        throw new Error(`memory write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    "write",
  ));

  registry.register(tool(
    "channel_join",
    "Join a public Channel that allows self-join.",
    {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    async (args) => {
      const target = resolveTarget(String(args.target ?? ""));
      if (target.kind !== "channel") throw new Error("channel_join requires a channel target");
      const channel = runtime.channelStore.getChannel(target.channelId);
      if (!channel || channel.visibility !== "public") throw new Error("Channel is not joinable");
      return text(runtime.channelStore.addMember({
        channelId: target.channelId,
        subjectType: "agent",
        subjectId: agentId,
      }));
    },
    "write",
  ));

  registry.register(tool(
    "channel_leave",
    "Leave a Channel.",
    {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    async (args) => {
      const target = resolveTarget(String(args.target ?? ""));
      if (target.kind !== "channel") throw new Error("channel_leave requires a channel target");
      runtime.channelStore.removeMember({
        channelId: target.channelId,
        subjectType: "agent",
        subjectId: agentId,
      });
      return text({ ok: true });
    },
    "write",
  ));

  registry.register(tool(
    "channel_create_agent",
    "Create a new Agent and optionally join Channels. Limited by Workbench max_agents budget.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        systemPrompt: { type: "string" },
        runtime: { type: "string", enum: ["pi", "claude-code"] },
        channelTargets: { type: "array", items: { type: "string" } },
      },
      required: ["id", "name"],
      additionalProperties: false,
    },
    async (args) => {
      // Member/Admin permission matrix is deferred; only enforce Workbench size budget.
      const maxAgents = runtime.config.channels.maxAgents;
      if (runtime.agentStore.list().length >= maxAgents) {
        throw new Error(`policy denial: max_agents=${maxAgents}`);
      }
      const creator = runtime.agentStore.get(agentId);
      if (!creator) throw new Error("creator Agent not found");
      const runtimeId = args.runtime === "claude-code" ? "claude-code" as const : "pi" as const;
      const created = runtime.agentStore.create({
        id: String(args.id ?? ""),
        name: String(args.name ?? ""),
        description: String(args.description ?? ""),
        systemPrompt: String(args.systemPrompt ?? creator.systemPrompt ?? ""),
        runtime: runtimeId,
        provider: runtimeId === "pi" ? creator.provider : null,
        model: creator.model,
        reasoningEffort: creator.reasoningEffort,
      });
      runtime.agentContextManager.ensure(created.id);
      runtime.messageStore.ensureHumanAgentDm(created.id);
      const joined: string[] = [];
      for (const raw of Array.isArray(args.channelTargets) ? args.channelTargets : []) {
        try {
          const target = resolveTarget(String(raw));
          if (target.kind !== "channel") continue;
          runtime.channelStore.addMember({
            channelId: target.channelId,
            subjectType: "agent",
            subjectId: created.id,
          });
          joined.push(target.channelId);
        } catch {
          // skip invalid targets
        }
      }
      return text({ agent: created, joinedChannels: joined });
    },
    "write",
  ));

  return registry;
}

function assertCanRead(runtime: AppRuntime, agentId: string, target: ChatTarget): void {
  if (target.kind === "channel") {
    if (!runtime.channelStore.listAgentMemberIds(target.channelId).includes(agentId)) {
      throw new Error("not a member of this Channel");
    }
    return;
  }
  const conversation = runtime.messageStore.getConversation(target.directMessageId);
  if (!conversation || !runtime.messageStore.otherParticipant(conversation, "agent", agentId)) {
    throw new Error("not a participant of this Direct Message");
  }
}

function assertCanWrite(runtime: AppRuntime, agentId: string, target: ChatTarget): void {
  assertCanRead(runtime, agentId, target);
}
