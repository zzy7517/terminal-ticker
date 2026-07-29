import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NewsStore } from "./store.js";

const dirs: string[] = [];

function tempStore(): NewsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-news-"));
  dirs.push(dir);
  return new NewsStore(path.join(dir, "news.sqlite3"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("NewsStore upsert published_at_ms", () => {
  it("keeps the earlier publishedAtMs on conflict so undated FF polls cannot float to the top", () => {
    const store = tempStore();
    const url = "https://www.forexfactory.com/news/1-demo";
    store.upsertItems([
      {
        url,
        source: "forexfactory",
        title: "Demo",
        summary: "",
        publishedAtMs: 1_000,
        fetchedAtMs: 1_000,
        keywords: ["1"],
      },
    ]);
    store.upsertItems([
      {
        url,
        source: "forexfactory",
        title: "Demo",
        summary: "",
        publishedAtMs: 9_000,
        fetchedAtMs: 9_000,
        keywords: ["1"],
      },
    ]);

    const [row] = store.recent({ limit: 1 });
    expect(row.publishedAtMs).toBe(1_000);
    expect(row.fetchedAtMs).toBe(9_000);
    store.close();
  });

  it("takes the latest publishedAtMs on conflict for sources other than Forex Factory", () => {
    const store = tempStore();
    const url = "https://www.reuters.com/markets/demo-story";
    store.upsertItems([
      {
        url,
        source: "reuters",
        title: "Demo",
        summary: "",
        publishedAtMs: 1_000,
        fetchedAtMs: 1_000,
        keywords: [],
      },
    ]);
    store.upsertItems([
      {
        url,
        source: "reuters",
        title: "Demo (corrected)",
        summary: "",
        publishedAtMs: 9_000,
        fetchedAtMs: 9_000,
        keywords: [],
      },
    ]);

    const [row] = store.recent({ limit: 1 });
    expect(row.publishedAtMs).toBe(9_000);
    expect(row.fetchedAtMs).toBe(9_000);
    store.close();
  });
});
