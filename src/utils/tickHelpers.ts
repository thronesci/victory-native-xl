import type { GetXTicks } from "../types";

export const DEFAULT_TICK_COUNT = 5;

function coerceNumArray<T>(collection: Array<T>) {
  return collection.map((item, idx) =>
    Number.isNaN(Number(item)) ? idx : (item as number),
  );
}

const containsNonNumbers = (arr: unknown[] | undefined): boolean => {
  return Array.isArray(arr) && arr.some((t) => Number.isNaN(Number(t)));
};

export const downsampleTicks = (tickValues: number[], tickCount: number) => {
  if (containsNonNumbers(tickValues)) {
    // Throw Error here until we expand tickValues to accept string and date types, like Victory web
    throw new Error("TickValues array must only contain numbers.");
  }

  if (
    !tickCount ||
    !Array.isArray(tickValues) ||
    tickValues.length <= tickCount
  ) {
    return tickValues;
  }
  const k = Math.floor(tickValues.length / tickCount);

  return tickValues.filter((_, i) => i % k === 0);
};

/**
 * A scroll axis's fixed ticks, ascending, as its binary search needs: `tickValues` may come in any order. Without them,
 * the scale's own ticks.
 */
export const getFixedTicks = (
  tickValues: number[] | undefined,
  tickCount: number,
  scaleTicks: (count: number) => number[],
) =>
  [
    ...(tickValues
      ? downsampleTicks(tickValues, tickCount)
      : scaleTicks(tickCount)),
  ].sort((a, b) => a - b);

// Each worklet captures the ones it calls when it is defined, so they come first.
/** How many of the ascending `tickXs` are below `x`, or at or below it with `orEqual`. */
const countBelow = (tickXs: ArrayLike<number>, x: number, orEqual: boolean) => {
  "worklet";
  let low = 0;
  let high = tickXs.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const tickX = tickXs[mid]!;
    if (tickX < x || (orEqual && tickX === x)) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

/** The ticks at [from, to], as [start, end) indices into the ascending `tickXs`. */
export const getTickRange = (
  tickXs: ArrayLike<number>,
  from: number,
  to: number,
): [number, number] => {
  "worklet";
  return [countBelow(tickXs, from, false), countBelow(tickXs, to, true)];
};

/** Where a scroll axis's ticks come from: `getXTicks`, on a linear scale, or fixed ticks at ascending `tickXs`. */
export type PageTickSource<T> =
  | {
      getXTicks: GetXTicks;
      /** A value's x in the content is xOffset + value * xPerValue. */
      xOffset: number;
      xPerValue: number;
      /** The data's ends. */
      firstValue: number;
      lastValue: number;
    }
  | { tickXs: ArrayLike<number>; values: ArrayLike<T> };

/**
 * The ticks a scroll axis draws at [from, to] in its content's x: their x, their values for labels and reports, the
 * first one's index among fixed ticks, and whether the axis's first and last ticks are among them.
 */
export const getPageTicks = <T>(
  from: number,
  to: number,
  source: PageTickSource<T>,
): {
  xs: number[];
  values: (T | number)[];
  start: number;
  hasFirst: boolean;
  hasLast: boolean;
} => {
  "worklet";
  if ("getXTicks" in source) {
    const fromValue = (from - source.xOffset) / source.xPerValue;
    const toValue = (to - source.xOffset) / source.xPerValue;
    const values = source.getXTicks(fromValue, toValue);
    return {
      xs: values.map((value) => source.xOffset + value * source.xPerValue),
      values,
      start: 0,
      hasFirst: fromValue <= source.firstValue,
      hasLast: toValue >= source.lastValue,
    };
  }
  const [start, end] = getTickRange(source.tickXs, from, to);
  return {
    xs: Array.prototype.slice.call(source.tickXs, start, end),
    values: Array.prototype.slice.call(source.values, start, end),
    start,
    hasFirst: start === 0,
    hasLast: end === source.tickXs.length,
  };
};

/** The values of a page's ticks at [from, to] in the content's x. */
export const getTicksIn = <T>(
  xs: ArrayLike<number>,
  values: T[],
  from: number,
  to: number,
): T[] => {
  "worklet";
  const [start, end] = getTickRange(xs, from, to);
  return values.slice(start, end);
};

/**
 * The stretch of a scrolling x axis to draw at `scrollX`, in the content's x: three plot widths around the page the
 * plot's left edge is in, so the plot and half its width either side stay inside it until the scroll crosses into the
 * next page. A label centered on a tick just outside the plot still shows, and the axis redraws once a screen.
 */
export const getDrawnRange = (
  scrollX: number,
  { left, right }: { left: number; right: number },
): [number, number] => {
  "worklet";
  const width = right - left;
  const page = Math.floor((left - scrollX) / width);
  return [(page - 0.5) * width, (page + 2.5) * width];
};

export const getDomainFromTicks = (
  tickValues: number[] | undefined,
): [number, number] | undefined => {
  // Check if undefined OR if its not an array of numbers
  if (!tickValues?.length) return;

  let numTicksArr;
  if (containsNonNumbers(tickValues)) {
    // Currently, we should ONLY accept numbers in the tickValues array (accepting strings and dates TBD); however, we want to catch any non-numbers and coerce them to numbers for domain purposes.
    numTicksArr = coerceNumArray(tickValues);
  } else {
    numTicksArr = tickValues;
  }

  // A loop, not Math.min(...ticks): a scroll axis can pass more ticks than a call takes arguments.
  let min = Infinity;
  let max = -Infinity;
  for (const tick of numTicksArr) {
    if (tick < min) min = tick;
    if (tick > max) max = tick;
  }

  return [min, max];
};
