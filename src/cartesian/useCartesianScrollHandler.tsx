import { useRef, useEffect, useImperativeHandle } from "react";
import type { SharedValue } from "react-native-reanimated";

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
  // loading, a new y-label width) keep the scroll where it is; `scrollToEnd` moves it to the end on request.
  const isMeasured = dimensions.width > 0;
  const hasScrolledToEndRef = useRef(false);
  useEffect(() => {
    if (!isMeasured || hasScrolledToEndRef.current) return;
    hasScrolledToEndRef.current = true;
    // Since scroll view is reversed, "end" is at maxScrollOffset (not maxScroll)
    jumpTo(maxScrollOffset ? -maxScrollOffset : 0);
  }, [isMeasured, maxScrollOffset, prevTranslateX, scrollX, isScrolling]);

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
}
