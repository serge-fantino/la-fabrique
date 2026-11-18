import { describe, expect, it } from "vitest";
import {
  applyStoryView,
  applyListView,
  readListView,
  listViewQuery,
  isCustom,
  type FeatureFacts,
} from "../src/sprint-filter";

const feature = (
  id: number,
  over: Partial<FeatureFacts> = {},
): FeatureFacts => ({
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
    feature(1, {
      priority: "P2",
      activity: "2026-11-01",
      stories: [
        { number: 204, title: "Login page", stage: "ready", priority: "P2" },
      ],
    }),
    feature(147, {
      priority: "P0",
      epic: "Auth",
      activity: "2026-11-05",
      canDo: true,
      stories: [{ number: 300, title: "Other", stage: "test", priority: "P0" }],
    }),
    feature(3, {
      backstage: true,
      waitingForMe: true,
      stories: [{ number: 5, title: "x", stage: "blocked", priority: null }],
    }),
  ];
  const P = ["P0", "P1", "P2"];
  it("searches by title, story number and card", () => {
    expect(ids(applyListView(list, view("q=login"), P))).toEqual([1]);
    expect(ids(applyListView(list, view("q=%23204"), P))).toEqual([1]);
    expect(ids(applyListView(list, view("q=204"), P))).toEqual([1]);
    expect(ids(applyListView(list, view("q=C147"), P))).toEqual([147]);
  });
  it("combines filters", () => {
    expect(ids(applyListView(list, view("stage=test&stage=ready"), P))).toEqual(
      [1, 147],
    );
    expect(
      ids(applyListView(list, view("stage=test&priority=P0&epic=auth"), P)),
    ).toEqual([147]);
    expect(ids(applyListView(list, view("behind=1"), P))).toEqual([3]);
    expect(ids(applyListView(list, view("can=1"), P))).toEqual([147]);
    expect(ids(applyListView(list, view("mine=1"), P))).toEqual([3]);
    expect(ids(applyListView(list, view("stage=blocked&can=1"), P))).toEqual(
      [],
    );
  });
  it("sorts, keeping the sprint's order by default", () => {
    expect(ids(applyListView(list, view(""), P))).toEqual([1, 147, 3]);
    expect(ids(applyListView(list, view("sort=priority"), P))).toEqual([
      147, 1, 3,
    ]);
    expect(ids(applyListView(list, view("sort=stage"), P))).toEqual([
      3, 147, 1,
    ]);
    expect(ids(applyListView(list, view("sort=activity"), P))).toEqual([
      147, 1, 3,
    ]);
  });
  it("round-trips through the address and ignores bad values", () => {
    const v = view("q=a&stage=ready&stage=nope&sort=bogus&can=1");
    expect(v.sort).toBe("order");
    expect(v.stages).toEqual(["ready"]);
    expect(listViewQuery(v)).toBe("?q=a&stage=ready&can=1");
    expect(isCustom(view(""))).toBe(false);
  });

  describe("by story", () => {
    const list = [
      feature(1, {
        priority: "P2",
        stories: [
          {
            number: 10,
            title: "Login page",
            stage: "ready",
            priority: "P2",
            activity: "2026-11-01",
          },
          {
            number: 11,
            title: "Logout",
            stage: "test",
            priority: "P0",
            activity: "2026-11-09",
          },
        ],
      }),
      feature(2, {
        stories: [
          {
            number: 20,
            title: "Other",
            stage: "test",
            priority: null,
            activity: "2026-11-05",
          },
        ],
      }),
    ];
    const P = ["P0", "P1", "P2"];
    const numbers = (query: string) =>
      applyStoryView(list, view(query), P).map((line) => line.story.number);
    it("reads the choice from the address", () => {
      expect(view("").by).toBe("feature");
      expect(view("by=story").by).toBe("story");
      expect(listViewQuery(view("by=story"))).toBe("?by=story");
    });
    it("keeps the sprint's order, grouped by feature", () => {
      expect(numbers("by=story")).toEqual([10, 11, 20]);
    });
    it("applies search and filters to the stories", () => {
      expect(numbers("by=story&q=login")).toEqual([10]);
      expect(numbers("by=story&stage=test")).toEqual([11, 20]);
      expect(numbers("by=story&q=C2")).toEqual([20]);
    });
    it("sorts stories across features", () => {
      expect(numbers("by=story&sort=priority")).toEqual([11, 10, 20]);
      expect(numbers("by=story&sort=stage")).toEqual([11, 20, 10]);
      expect(numbers("by=story&sort=activity")).toEqual([11, 20, 10]);
    });
  });
});
