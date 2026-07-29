import { describe, expect, it } from "vitest";
import { isCloudflareChallengeHtml, parseForexFactoryNewsHtml } from "./forexfactory.js";

describe("parseForexFactoryNewsHtml", () => {
  it("extracts id, title, and FF url only once per story", () => {
    const html = `
      <a href="/news/1410573-kevin-warshs-fed-press-conference-will-be-revealing">
        Kevin Warsh&#x92;s Fed press conference will be revealing even without a rate hike
      </a>
      <a href="/news/1410573-kevin-warshs-fed-press-conference-will-be-revealing/hit">From cnbc.com</a>
      <a href="/news/1410570-former-fed-gov-stephen-miran-inflation-is-much">
        Former Fed Gov. Stephen Miran: Inflation is much more likely to be transitory this time
      </a>
      <a href="/news/1410570-former-fed-gov-stephen-miran-inflation-is-much#post">3 comments</a>
    `;

    const items = parseForexFactoryNewsHtml(html, 1_700_000_000_000);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: "forexfactory",
      url: "https://www.forexfactory.com/news/1410573-kevin-warshs-fed-press-conference-will-be-revealing",
      keywords: ["1410573"],
      summary: "",
      publishedAtMs: 1_700_000_000_000,
    });
    expect(items[0].title).toContain("Kevin Warsh");
    expect(items[1].keywords).toEqual(["1410570"]);
  });
});

describe("isCloudflareChallengeHtml", () => {
  it("detects challenge shells that must not be treated as empty news pages", () => {
    expect(isCloudflareChallengeHtml("<title>Just a moment...</title>")).toBe(true);
    expect(isCloudflareChallengeHtml('<div class="cf-challenge"></div>')).toBe(true);
    expect(isCloudflareChallengeHtml("<title>News | Forex Factory</title>")).toBe(false);
  });
});
