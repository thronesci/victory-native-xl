import { useRef, useEffect, useImperativeHandle } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { getScrollBounds } from "./utils/transformGestures";

export function useCartesianScrollHandler({
  data,
  dimensions,
  scrollX,
  xScale,
  scrollControllerRef,
  prevTranslateX,
  maxScrollOffset = 35,
  isScrolling,
}: {
  data: any[];
  dimensions: any;
  scrollX: any;
  xScale: any;
  scrollControllerRef: any;
  prevTranslateX: any;
  maxScrollOffset?: number;
  isScrolling: SharedValue<boolean>;
}) {
  // A programmatic scroll is not a user scroll. Clearing `isScrolling` first keeps the jump out of anything that
  // follows user scrolls; moving `scrollX` cancels a running fling, which then doesn't report a scroll end.
  const jumpTo = (x: number) => {
    isScrolling.value = false;
    scrollX.value = x;
    prevTranslateX.value = x;
  };

  // Start at the newest end once, when the plot is first measured. Later content or `maxScrollOffset` changes (data
  // loading, a new y-label width) keep the scroll where it is while it stays in bounds; `scrollToEnd` moves it to the
  // end on request.
  const isMeasured = dimensions.width > 0;
  const hasScrolledToEndRef = useRef(false);
  useEffect(() => {
    if (!isMeasured || hasScrolledToEndRef.current) return;
    hasScrolledToEndRef.current = true;
    // Since scroll view is reversed, "end" is at maxScrollOffset (not maxScroll)
    jumpTo(maxScrollOffset ? -maxScrollOffset : 0);
  }, [isMeasured, maxScrollOffset, prevTranslateX, scrollX, isScrolling]);

  // Bounds that contract past a resting scroll (shorter data, a smaller `maxScrollOffset`) move it to their new edge,
  // or the plot could go blank. A user scroll in progress returns into them as it settles.
  const [minScroll, maxScroll] = getScrollBounds(dimensions, maxScrollOffset);
  const scrollBounds = useSharedValue<[number, number]>([minScroll, maxScroll]);
  const measuredBoundsRef = useRef<[number, number] | null>(null);
  useEffect(() => {
    scrollBounds.value = [minScroll, maxScroll];
    if (!isMeasured) return;
    const prevBounds = measuredBoundsRef.current;
    measuredBoundsRef.current = [minScroll, maxScroll];
    if (!prevBounds || isScrolling.value) return;
    const contractedScroll = getContractedScroll(scrollX.value, prevBounds, [
      minScroll,
      maxScroll,
    ]);
    if (contractedScroll !== undefined) jumpTo(contractedScroll);
  }, [minScroll, maxScroll, isMeasured, scrollBounds, scrollX, isScrolling]);

  // Allows us to control the scroll from the parent component
  useImperativeHandle(
    scrollControllerRef,
    () => ({
      scrollTo: (ts: number, offset = -20) => {
        const maxScrollValue = maxScrollOffset
          ? -maxScrollOffset + offset
          : offset;
        const pixelX = xScale(ts);
        const totalWidth = dimensions.totalContentWidth;
        const viewportWidth = dimensions.width;

        // Calculate scroll position so that the ts aligns with right edge
        const rawScroll = totalWidth - pixelX + offset;

        // Clamp to [0, maxScroll] range for reversed scroll
        const maxScroll = Math.max(maxScrollValue, totalWidth - viewportWidth);
        const clampedX = Math.max(
          maxScrollValue,
          Math.min(rawScroll, maxScroll),
        );

        jumpTo(clampedX);
      },
      scrollToEnd: () => {
        jumpTo(maxScrollOffset ? -maxScrollOffset : 0);
      },
      getScrollX() {
        return scrollX.value;
      },
    }),
    [xScale, dimensions, scrollX, prevTranslateX, isScrolling, maxScrollOffset],
  );

  return scrollBounds;
}

/**
 * Where a resting scroll moves when the scroll bounds change: to the new edge of a side that contracted past it.
 * Otherwise it stays, including a `scrollTo` offset that already sat past an edge that didn't move.
 */
export function getContractedScroll(
  scrollX: number,
  [prevMinScroll, prevMaxScroll]: [number, number],
  [minScroll, maxScroll]: [number, number],
): number | undefined {
  if (maxScroll < prevMaxScroll && scrollX > maxScroll) return maxScroll;
  if (minScroll > prevMinScroll && scrollX < minScroll) return minScroll;
  return undefined;
}
