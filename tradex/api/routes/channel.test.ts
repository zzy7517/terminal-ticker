import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelStore } from "../../channel/store.js";
import { channelRoutes } from "./channel.js";
import type { AppRuntime } from "../runtime.js";

describe("Channel HTTP API", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function runtime(): AppRuntime {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-channel-api-"));
    roots.push(root);
    return { channelStore: new ChannelStore(path.join(root, "chat.sqlite3")) } as AppRuntime;
  }

  it("lets Human create a Channel and append a message", async () => {
    const routes = channelRoutes(runtime());
    const create = await routes.request("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "btc-research", topic: "BTC research" }),
    });
    const { channel } = await create.json() as { channel: { id: string } };
    const send = await routes.request(`/api/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Start analysis" }),
    });
    const timeline = await routes.request(`/api/channels/${channel.id}/messages`);
    const payload = await timeline.json() as { messages: Array<{ content: string }> };

    expect(create.status).toBe(201);
    expect(send.status).toBe(201);
    expect(payload.messages).toEqual([expect.objectContaining({ content: "Start analysis" })]);
  });
});
