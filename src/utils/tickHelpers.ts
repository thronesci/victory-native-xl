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

// Each worklet captures the ones it calls when it is defined, so they come first.
/** How many of the ascending `tickXs` are below `x`, or at or below it with `orEqual`. */
const countBelow = (tickXs: number[], x: number, orEqual: boolean) => {
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
  tickXs: number[],
  from: number,
  to: number,
): [number, number] => {
  "worklet";
  return [countBelow(tickXs, from, false), countBelow(tickXs, to, true)];
};

/**
 * The ticks a scrolling x axis draws at `scrollX`, as [start, end) indices into the ascending content positions
 * `tickXs`: those within half the plot's width of it, so a label centered on a tick just outside still shows. Found by
 * binary search, so the cost stays the same however many ticks the axis has.
 */
export const getDrawnTickRange = (
  tickXs: number[],
  scrollX: number,
  { left, right }: { left: number; right: number },
): [number, number] => {
  "worklet";
  const buffer = (right - left) / 2;
  return getTickRange(
    tickXs,
    left - buffer - scrollX,
    right + buffer - scrollX,
  );
};

const getMinValue = (arr: Array<number>): number => {
  return Math.min(...arr);
};

const getMaxValue = (arr: Array<number>): number => {
  return Math.max(...arr);
};

export const getDomainFromTicks = (
  tickValues: number[] | undefined,
): [number, number] | undefined => {
  // Check if undefined OR if its not an array of numbers
  if (!tickValues) return;

  let numTicksArr;
  if (containsNonNumbers(tickValues)) {
    // Currently, we should ONLY accept numbers in the tickValues array (accepting strings and dates TBD); however, we want to catch any non-numbers and coerce them to numbers for domain purposes.
    numTicksArr = coerceNumArray(tickValues);
  } else {
    numTicksArr = tickValues;
  }

  const min = getMinValue(numTicksArr);
  const max = getMaxValue(numTicksArr);

  return [min, max];
};
