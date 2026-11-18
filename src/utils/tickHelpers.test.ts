import { describe, expect, it } from "vitest";
import { getDomainFromTicks, getDrawnRange } from "./tickHelpers";

describe("getDomainFromTicks", () => {
  // Thirty years of ticks every other hour, more than a spread call can pass.
  it("spans more ticks than a function takes arguments", () => {
    const ticks = Array.from({ length: 140_000 }, (_, i) => 1_000 + i * 7_200);

    expect(getDomainFromTicks(ticks)).toEqual([1_000, ticks.at(-1)]);
  });

  it("spans unsorted ticks", () => {
    expect(getDomainFromTicks([5, -2, 9, 3])).toEqual([-2, 9]);
  });

  // A chart that asks its ticks as it scrolls (`getXTicks`) passes none, and takes its domain from its points.
  it("sets no domain without ticks", () => {
    expect(getDomainFromTicks([])).toBeUndefined();
  });
});

describe("getDrawnRange", () => {
  const plot = { left: 40, right: 400 };
  const plotWidth = plot.right - plot.left;

  it.each([0, -1, -73_337.5, -100_000, 250])(
    "covers the plot and half its width either side at scroll %s",
    (scrollX) => {
      const [from, to] = getDrawnRange(scrollX, plot);

      // In the content, which the scroll moves by scrollX.
      expect(from).toBeLessThanOrEqual(plot.left - plotWidth / 2 - scrollX);
      expect(to).toBeGreaterThanOrEqual(plot.right + plotWidth / 2 - scrollX);
      expect(to - from).toBe(3 * plotWidth);
    },
  );

  it("changes once per plot width scrolled, so the axis redraws once a screen", () => {
    const ranges = new Set<number>();
    for (let scrollX = 0; scrollX > -10 * plotWidth; scrollX -= 1) {
      ranges.add(getDrawnRange(scrollX, plot)[0]);
    }

    // Ten plot widths cross ten page edges.
    expect(ranges.size - 1).toBe(10);
  });
});
