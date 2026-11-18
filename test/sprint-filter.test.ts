import { describe, expect, it } from "vitest";
import { applyListView, readListView, listViewQuery, isCustom, type FeatureFacts } from "../src/sprint-filter";

const feature = (id: number, over: Partial<FeatureFacts> = {}): FeatureFacts => ({
  id,
  title: `Feature ${id}`,
  priority: null,
  epic: null,
  backstage: false,
  stories: [],
  canDo: false,
  waitingForMe: false,
  activity: null,
  ...over,
});
const view = (query: string) => readListView(new URLSearchParams(query));
const ids = (list: FeatureFacts[]) => list.map((f) => f.id);

describe("sprint list view", () => {
  const list = [
    feature(1, { priority: "P2", activity: "2026-11-01", stories: [{ number: 204, title: "Login page", stage: "ready", priority: "P2" }] }),
    feature(147, { priority: "P0", epic: "Auth", activity: "2026-11-05", canDo: true, stories: [{ number: 300, title: "Other", stage: "test", priority: "P0" }] }),
    feature(3, { backstage: true, waitingForMe: true, stories: [{ number: 5, title: "x", stage: "blocked", priority: null }] }),
  ];
  const P = ["P0", "P1", "P2"];
  it("searches by title, story number and card", () => {
    expect(ids(applyListView(list, view("q=login"), P))).toEqual([1]);
    expect(ids(applyListView(list, view("q=%23204"), P))).toEqual([1]);
    expect(ids(applyListView(list, view("q=204"), P))).toEqual([1]);
    expect(ids(applyListView(list, view("q=C147"), P))).toEqual([147]);
  });
  it("combines filters", () => {
    expect(ids(applyListView(list, view("stage=test&stage=ready"), P))).toEqual([1, 147]);
    expect(ids(applyListView(list, view("stage=test&priority=P0&epic=auth"), P))).toEqual([147]);
    expect(ids(applyListView(list, view("behind=1"), P))).toEqual([3]);
    expect(ids(applyListView(list, view("can=1"), P))).toEqual([147]);
    expect(ids(applyListView(list, view("mine=1"), P))).toEqual([3]);
    expect(ids(applyListView(list, view("stage=blocked&can=1"), P))).toEqual([]);
  });
  it("sorts, keeping the sprint's order by default", () => {
    expect(ids(applyListView(list, view(""), P))).toEqual([1, 147, 3]);
    expect(ids(applyListView(list, view("sort=priority"), P))).toEqual([147, 1, 3]);
    expect(ids(applyListView(list, view("sort=stage"), P))).toEqual([3, 147, 1]);
    expect(ids(applyListView(list, view("sort=activity"), P))).toEqual([147, 1, 3]);
  });
  it("round-trips through the address and ignores bad values", () => {
    const v = view("q=a&stage=ready&stage=nope&sort=bogus&can=1");
    expect(v.sort).toBe("order");
    expect(v.stages).toEqual(["ready"]);
    expect(listViewQuery(v)).toBe("?q=a&stage=ready&can=1");
    expect(isCustom(view(""))).toBe(false);
  });
});
