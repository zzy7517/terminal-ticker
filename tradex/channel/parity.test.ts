import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelStore } from "./store.js";
import { InboxStore } from "../chat/inbox-store.js";
import { MessageStore } from "../chat/message-store.js";
import { channelTarget } from "./domain.js";

describe("Raft-style channel parity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createStores() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-parity-"));
    roots.push(root);
    const dbPath = path.join(root, "chat.sqlite3");
    return {
      dbPath,
      channelStore: new ChannelStore(dbPath),
      inboxStore: new InboxStore(dbPath),
      messageStore: new MessageStore(dbPath),
    };
  }

  it("holds draft on version mismatch and allows retry after review", () => {
    const { channelStore } = createStores();
    const channel = channelStore.createChannel({ name: "btc-research" });
    channelStore.addMember({ channelId: channel.id, subjectType: "agent", subjectId: "alpha" });
    channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "v1" });
    const observed = channelStore.getChannel(channel.id)!.version;
    channelStore.appendMessage({ channelId: channel.id, authorId: "owner", content: "v2" });

    const draft = channelStore.createHeldDraft({
      agentId: "alpha",
      channelId: channel.id,
      observedVersion: observed,
      content: "stale reply",
    });
    expect(draft.status).toBe("held");

    expect(() => channelStore.resolveHeldDraft({
      agentId: "alpha",
      draftId: draft.id,
      action: "retry",
    })).toThrow(/read latest/i);

    channelStore.markHeldDraftsReviewed({
      agentId: "alpha",
      channelId: channel.id,
      reviewedVersion: channelStore.getChannel(channel.id)!.version,
    });
    const published = channelStore.resolveHeldDraft({
      agentId: "alpha",
      draftId: draft.id,
      action: "retry",
    });
    expect(published.publishedMessage?.content).toBe("stale reply");
    expect(published.draft.status).toBe("published");
  });

  it("lets Human discard held drafts only after the 5-minute grace window", () => {
    const { channelStore } = createStores();
    const channel = channelStore.createChannel({ name: "btc-research" });
    const draft = channelStore.createHeldDraft({
      agentId: "alpha",
      channelId: channel.id,
      observedVersion: 0,
      content: "held",
    });
    expect(() => channelStore.humanDiscardHeldDraft({
      draftId: draft.id,
      now: draft.createdAtMs + 60_000,
    })).toThrow(/5-minute/i);

    const discarded = channelStore.humanDiscardHeldDraft({
      draftId: draft.id,
      now: draft.createdAtMs + 5 * 60_000 + 1,
    });
    expect(discarded.status).toBe("discarded");
  });

  it("triggers each reminder at most once into the Agent inbox", () => {
    const { channelStore, inboxStore } = createStores();
    const channel = channelStore.createChannel({ name: "btc-research" });
    const reminder = channelStore.createReminder({
      agentId: "alpha",
      channelId: channel.id,
      dueAtMs: Date.now() - 1_000,
      note: "revisit",
    });
    expect(channelStore.markReminderTriggered(reminder.id)).toBe(true);
    expect(channelStore.markReminderTriggered(reminder.id)).toBe(false);
    inboxStore.notify({
      agentId: "alpha",
      target: channelTarget(channel.id),
      messageId: reminder.id,
      reason: "reminder",
    });
    expect(inboxStore.listPending("alpha")).toHaveLength(1);
    expect(inboxStore.listPending("alpha")[0]?.reason).toBe("reminder");
  });

  it("cancels pending channel inbox when membership is removed", () => {
    const { channelStore, inboxStore } = createStores();
    const channel = channelStore.createChannel({ name: "btc-research" });
    channelStore.addMember({ channelId: channel.id, subjectType: "agent", subjectId: "alpha" });
    const message = channelStore.appendMessage({
      channelId: channel.id,
      authorId: "owner",
      content: "hello",
    });
    inboxStore.notify({
      agentId: "alpha",
      target: channelTarget(channel.id),
      messageId: message.id,
      reason: "joined-channel",
    });
    expect(inboxStore.listPending("alpha")).toHaveLength(1);
    channelStore.removeMember({
      channelId: channel.id,
      subjectType: "agent",
      subjectId: "alpha",
    });
    inboxStore.cancelForTarget("alpha", channelTarget(channel.id));
    expect(inboxStore.listPending("alpha")).toHaveLength(0);
  });

  it("rewrites legacy direct-chat rows to real direct-message ids", () => {
    const { dbPath, channelStore, inboxStore, messageStore } = createStores();
    const dm = messageStore.ensureHumanAgentDm("alpha");
    channelStore.close();
    inboxStore.close();
    messageStore.close();

    const conn = new Database(dbPath);
    conn.prepare(`
      INSERT INTO chat_events (
        type, actor_type, actor_id, target_kind, target_ref, entity_type, entity_id, payload_json, created_at_ms
      ) VALUES ('message.created', 'human', 'owner', 'direct-chat', ?, 'message', 'msg-1', '{}', 1)
    `).run(JSON.stringify(["alpha", "old-chat"]));
    conn.close();

    const reopened = new MessageStore(dbPath);
    expect(reopened.migrateLegacyDirectChatTargets()).toBe(1);
    reopened.close();

    const verify = new Database(dbPath, { readonly: true });
    const row = verify.prepare("SELECT target_kind, target_ref FROM chat_events WHERE entity_id = 'msg-1'").get() as {
      target_kind: string;
      target_ref: string;
    };
    verify.close();
    expect(row.target_kind).toBe("direct-message");
    expect(JSON.parse(row.target_ref)).toEqual([dm.id]);
  });

  it("keeps one Human-Agent Direct Message per agentId", () => {
    const { messageStore } = createStores();
    const first = messageStore.ensureHumanAgentDm("alpha");
    const second = messageStore.ensureHumanAgentDm("alpha");
    expect(first.id).toBe(second.id);
    expect(messageStore.listConversationsForAgent("alpha")).toHaveLength(1);
  });
});
