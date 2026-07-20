/**
 * message-tools — Agent 面向的 Message Fabric 工具（Pi 进程内 + Claude MCP）。
 *
 * 工具只定义一次，runtimeExposure 同时覆盖两个 Runtime。write 工具使用 domain "other"，
 * 以便 Claude MCP 暴露协作写能力时不打开交易写权限（见 listToolsForClaudeMcp）。
 *
 * Target 使用 Agent 侧字符串（#channel / dm:@handle），在此边界解析为可信 ChatTarget；
 * Channel/DM 读写经 message-fabric，避免本文件重复 kind 分支。
 */
import type { AppRuntime } from "../api/runtime.js";
import { ToolRegistry, type ToolDefinition } from "../agent/tools/registry.js";
import { parseMessageTarget, type MessageActor } from "./message-target.js";
import { HUMAN_OWNER_ID } from "./message-store.js";
import {
  addReaction,
  assertCanRead,
  listReadableTargets,
  readTimeline,
  removeReaction,
  resolveHeldDraftAndFanOut,
  searchReadable,
  sendAgentMessage,
} from "./message-fabric.js";
import { registerMemoryTools } from "./memory-tools.js";

const BOTH = ["pi", "claude-code"] as const;

function text(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 构造带 Message Fabric 策略的工具（domain other，双 Runtime）。 */
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

/**
 * 创建绑定到某个 Agent 身份的 Message Tool registry。
 * 所有写操作都以该 agentId 执行；grant 不得允许冒充。
 */
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

  const resolveParsed = (raw: string) => parseMessageTarget(raw, actor, resolver);
  const resolveTarget = (raw: string) => resolveParsed(raw).chatTarget;

  // 查本 Agent 未读 inbox：只返回目标/原因等元数据，不含消息正文。
  registry.register(tool(
    "message_check",
    "List unread inbox items for this Agent. Returns metadata only, never message bodies.",
    { type: "object", properties: {}, additionalProperties: false },
    async () => {
      const items = runtime.inboxStore.listPending(agentId);
      return text({
        unreadTargets: items.length,
        items: items.map((item) => {
          const reminder = item.reason === "reminder"
            ? runtime.channelStore.getReminder(item.latestMessageId)
            : null;
          return {
            id: item.id,
            target: item.target,
            reason: item.reason,
            firstMessageId: item.firstMessageId,
            latestMessageId: item.latestMessageId,
            ...(reminder ? { reminderNote: reminder.note, reminderDueAtMs: reminder.dueAtMs } : {}),
          };
        }),
      });
    },
  ));

  // 按目标读取 Channel/DM 消息，支持 before/after/around 游标分页。
  registry.register(tool(
    "message_read",
    "Read messages for a Channel or DM target. Supports before/after/around cursors.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        limit: { type: "number" },
        before: { type: "number" },
        after: { type: "number" },
        around: { type: "string" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    async (args) => {
      const parsed = resolveParsed(String(args.target ?? ""));
      const aroundMessageId = typeof args.around === "string" && args.around
        ? args.around
        : parsed.messageId;
      return text(readTimeline(runtime, agentId, parsed.chatTarget, {
        limit: typeof args.limit === "number" ? args.limit : 50,
        beforeSeq: typeof args.before === "number" ? args.before : null,
        afterSeq: typeof args.after === "number" ? args.after : null,
        aroundMessageId,
      }));
    },
  ));

  // 在本 Agent 有权读取的 Channel/DM 中按关键词搜索消息。
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
    async (args) => text(searchReadable(
      runtime,
      agentId,
      String(args.query ?? ""),
      typeof args.limit === "number" ? args.limit : 20,
    )),
  ));

  // 向 Channel 或 DM 发送消息；Channel 版本落后时会生成 held draft。
  registry.register(tool(
    "message_send",
    "Send a message to a Channel or DM target.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        content: { type: "string" },
        observedVersion: { type: "number" },
      },
      required: ["target", "content"],
      additionalProperties: false,
    },
    async (args) => text(sendAgentMessage(runtime, agentId, resolveTarget(String(args.target ?? "")), {
      content: String(args.content ?? ""),
      observedVersion: typeof args.observedVersion === "number" ? args.observedVersion : null,
    })),
    "write",
  ));

  // 给 Channel/DM 消息添加 reaction（表情回应）。
  registry.register(tool(
    "message_add_reaction",
    "Add a reaction to a Channel or DM message.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        messageId: { type: "string" },
        emoji: { type: "string" },
      },
      required: ["target", "messageId", "emoji"],
      additionalProperties: false,
    },
    async (args) => {
      const parsed = resolveParsed(String(args.target ?? ""));
      return text(addReaction(runtime, agentId, parsed.chatTarget, {
        messageId: String(args.messageId ?? parsed.messageId ?? ""),
        emoji: String(args.emoji ?? ""),
      }));
    },
    "write",
  ));

  // 移除本 Agent 在某条消息上的 reaction。
  registry.register(tool(
    "message_remove_reaction",
    "Remove this Agent's reaction from a Channel or DM message.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        messageId: { type: "string" },
        emoji: { type: "string" },
      },
      required: ["target", "messageId", "emoji"],
      additionalProperties: false,
    },
    async (args) => {
      const parsed = resolveParsed(String(args.target ?? ""));
      return text(removeReaction(runtime, agentId, parsed.chatTarget, {
        messageId: String(args.messageId ?? parsed.messageId ?? ""),
        emoji: String(args.emoji ?? ""),
      }));
    },
    "write",
  ));

  // 将 inbox 条目标为已读 / 忽略 / 延后处理。
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

  // 列出本 Agent 可访问的 Channel 与 DM 目标。
  registry.register(tool(
    "message_list_targets",
    "List Channel and DM targets this Agent can access.",
    { type: "object", properties: {}, additionalProperties: false },
    async () => text(listReadableTargets(runtime, agentId)),
  ));

  // 列出指定 Channel 的成员。
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

  // 处理 held draft：重试发布、替换正文，或丢弃。
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
    async (args) => text(resolveHeldDraftAndFanOut(runtime, agentId, {
      draftId: String(args.draftId ?? ""),
      action: String(args.action ?? "") as "retry" | "replace" | "discard",
      content: typeof args.content === "string" ? args.content : undefined,
    })),
    "write",
  ));

  // 在 Channel 上为本 Agent 创建或取消 reminder。
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

  // 私有 MEMORY / notes 读写工具（见 memory-tools.ts）。
  registerMemoryTools(registry, agentId);

  // 自行加入允许 self-join 的公开 Channel。
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

  // 离开指定 Channel。
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

  return registry;
}
