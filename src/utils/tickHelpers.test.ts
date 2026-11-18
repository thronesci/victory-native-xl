import { describe, expect, it } from "vitest";
import {
  getDomainFromTicks,
  getDrawnRange,
  getFixedTicks,
  getPageTicks,
  getTicksIn,
} from "./tickHelpers";

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

describe("a scroll axis's page of ticks", () => {
  const plot = { left: 0, right: 100 };
  // An identity scale: a value's x in the content is the value.
  const identity = { xOffset: 0, xPerValue: 1 };
  const everyTen = (from: number, to: number) => {
    const ticks: number[] = [];
    for (let tick = Math.ceil(from / 10) * 10; tick <= to; tick += 10) {
      ticks.push(tick);
    }
    return ticks;
  };

  it("draws fixed ticks passed in any order", () => {
    const ticks = getFixedTicks([600, 800, 1000, 50], 0, () => []);
    const [from, to] = getDrawnRange(0, plot);

    expect(
      getPageTicks(from, to, { tickXs: ticks, values: ticks }),
    ).toMatchObject({ xs: [50], values: [50], hasFirst: true, hasLast: false });
  });

  it("reports the generated ticks in view as the plot scrolls", () => {
    const source = {
      getXTicks: everyTen,
      ...identity,
      firstValue: 0,
      lastValue: 1000,
    };
    const inView = (scrollX: number) => {
      const [from, to] = getDrawnRange(scrollX, plot);
      const page = getPageTicks(from, to, source);
      return getTicksIn(
        page.xs,
        page.values,
        plot.left - scrollX,
        plot.right - scrollX,
      );
    };

    expect(inView(0)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(inView(-175)).toEqual([
      180, 190, 200, 210, 220, 230, 240, 250, 260, 270,
    ]);
  });

  it("marks the axis's ends when the page reaches them", () => {
    const source = {
      getXTicks: everyTen,
      ...identity,
      firstValue: 0,
      lastValue: 1000,
    };
    const page = (scrollX: number) => {
      const [from, to] = getDrawnRange(scrollX, plot);
      const { hasFirst, hasLast } = getPageTicks(from, to, source);
      return { hasFirst, hasLast };
    };

    expect(page(0)).toEqual({ hasFirst: true, hasLast: false });
    expect(page(-450)).toEqual({ hasFirst: false, hasLast: false });
    expect(page(-900)).toEqual({ hasFirst: false, hasLast: true });
  });
});
