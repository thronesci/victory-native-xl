import { describe, expect, it } from "vitest";
import { getDomainFromTicks, getDrawnTickRange } from "./tickHelpers";

describe("getDomainFromTicks", () => {
  // Thirty years of ticks every other hour, more than a spread call can pass.
  it("spans more ticks than a function takes arguments", () => {
    const ticks = Array.from({ length: 140_000 }, (_, i) => 1_000 + i * 7_200);

    expect(getDomainFromTicks(ticks)).toEqual([1_000, ticks.at(-1)]);
  });

  it("spans unsorted ticks", () => {
    expect(getDomainFromTicks([5, -2, 9, 3])).toEqual([-2, 9]);
  });
});

// 10,000 ticks 20 px apart, scrolled by `scrollX` across a 360 px plot.
const TICK_SPACING = 20;
const tickXs = Array.from({ length: 10_000 }, (_, i) => i * TICK_SPACING);
const plot = { left: 40, right: 400 };
const plotWidth = plot.right - plot.left;
// Half the plot either side, as `getDrawnTickRange` draws.
const buffer = plotWidth / 2;

function drawnXsOnScreen(scrollX: number) {
  const [start, end] = getDrawnTickRange(tickXs, scrollX, plot);
  return tickXs.slice(start, end).map((x) => x + scrollX);
}

describe("getDrawnTickRange", () => {
  it.each([
    ["the oldest end", 0],
    ["between ticks", -73_337],
    ["mid-history", -100_000],
    ["the newest end", -(tickXs.at(-1)! - plot.right)],
  ])("draws only the ticks in view and in the buffer at %s", (_, scrollX) => {
    const onScreen = drawnXsOnScreen(scrollX);
    const firstUndrawn = tickXs.find((x) => x + scrollX > plot.right + buffer);

    expect(onScreen.length).toBeLessThanOrEqual(
      (plotWidth + 2 * buffer) / TICK_SPACING + 1,
    );
    expect(onScreen.every((x) => x >= plot.left - buffer)).toBe(true);
    expect(onScreen.every((x) => x <= plot.right + buffer)).toBe(true);
    // Every tick in view is drawn.
    for (const x of tickXs) {
      if (x + scrollX >= plot.left && x + scrollX <= plot.right) {
        expect(onScreen).toContain(x + scrollX);
      }
    }
    expect(
      firstUndrawn === undefined || !onScreen.includes(firstUndrawn + scrollX),
    ).toBe(true);
  });

  it("draws nothing scrolled past every tick", () => {
    expect(drawnXsOnScreen(-1_000_000)).toEqual([]);
  });

  it("draws every tick of a short axis", () => {
    const [start, end] = getDrawnTickRange([50, 150, 250], 0, plot);

    expect([start, end]).toEqual([0, 3]);
  });
});
