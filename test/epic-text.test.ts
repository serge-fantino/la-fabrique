import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCard, findCard, listCards } from "../src/cards";
import { featureEpicTitles } from "../src/card-epics";
import { decodeWarnings, encodeWarnings, syncEpicText } from "../src/epic-text";

const REPO = "acme/widget";

async function make(kind: "epic" | "feature", title: string, body = ""): Promise<number> {
  return createCard(env.DB, REPO, "pe", { title, body, tags: { kind, status: "draft", epic: null, domain: null, segment: null, release: null } });
}

async function journal(action: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = ? AND actor = 'pe'").bind(action).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("An epic's text decides its features (#291)", () => {
  it("attaches a newly named feature, journalled, and detaches it when the name goes", async () => {
    const epic = await make("epic", "F9");
    const feature = await make("feature", "Alpha");
    const card = (await findCard(env.DB, REPO, epic))!;
    expect(await syncEpicText(env.DB, card, "", `Needs C${feature}`, "pe")).toEqual([]);
    expect((await featureEpicTitles(env.DB, REPO)).get(feature)).toBe("F9");
    expect(await journal("feature_attached")).toBe(1);
    await syncEpicText(env.DB, card, `Needs C${feature}`, "Nothing", "pe");
    expect((await featureEpicTitles(env.DB, REPO)).get(feature)).toBeUndefined();
    expect(await journal("feature_detached")).toBe(1);
  });

  it("keeps a feature in its epic and warns", async () => {
    const f9 = await make("epic", "F9");
    const f10 = await make("epic", "F10");
    const feature = await make("feature", "Beta");
    await syncEpicText(env.DB, (await findCard(env.DB, REPO, f9))!, "", `C${feature}`, "pe");
    const warnings = await syncEpicText(env.DB, (await findCard(env.DB, REPO, f10))!, "", `C${feature}`, "pe");
    expect(warnings).toEqual([{ feature, epic: f9 }]);
    expect((await featureEpicTitles(env.DB, REPO)).get(feature)).toBe("F9");
    // Removing the name from the other epic detaches nothing.
    await syncEpicText(env.DB, (await findCard(env.DB, REPO, f10))!, `C${feature}`, "", "pe");
    expect((await featureEpicTitles(env.DB, REPO)).get(feature)).toBe("F9");
    expect(decodeWarnings(encodeWarnings(warnings))).toEqual(warnings);
  });

  it("attaches nothing for a card that is not an epic", async () => {
    const other = await make("feature", "Gamma");
    const feature = await make("feature", "Delta");
    expect(await syncEpicText(env.DB, (await findCard(env.DB, REPO, other))!, "", `C${feature}`, "pe")).toEqual([]);
    expect((await featureEpicTitles(env.DB, REPO)).get(feature)).toBeUndefined();
    expect((await listCards(env.DB, REPO)).length).toBeGreaterThan(0);
  });
});

describe("A mention of a card that does not exist (#292)", () => {
  it("takes the number of the card created from it, as a new version, journalled, and attaches a feature to its epic", async () => {
    const { replaceMention } = await import("../src/card-routes");
    const epic = await make("epic", "F20", "Needs C99999 and C99998");
    const created = await make("feature", "Gamma");
    const done = await replaceMention(env.DB, REPO, "pe", { from: epic, mention: 99999 }, created);
    expect(done).toBe(epic);
    const after = (await findCard(env.DB, REPO, epic))!;
    expect(after.body).toBe(`Needs C${created} and C99998`);
    expect(after.rev).toBe(2);
    expect((await featureEpicTitles(env.DB, REPO)).get(created)).toBe("F20");
    expect(await journal("card_mention_replaced")).toBe(1);
  });

  it("does nothing when the mention is gone or the card exists", async () => {
    const { replaceMention } = await import("../src/card-routes");
    const other = await make("feature", "Delta", "No mention");
    const created = await make("feature", "Eps");
    expect(await replaceMention(env.DB, REPO, "pe", { from: other, mention: 88888 }, created)).toBeNull();
    expect(await replaceMention(env.DB, REPO, "pe", { from: other, mention: created }, created)).toBeNull();
  });
});
