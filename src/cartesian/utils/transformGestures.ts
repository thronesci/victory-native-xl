import {
  Gesture,
  type PanGesture,
  type PinchGesture,
} from "react-native-gesture-handler";
import { multiply4, scale, translate } from "@shopify/react-native-skia";
import type { PanGestureConfig } from "react-native-gesture-handler/lib/typescript/handlers/PanGestureHandler";
import type { ChartTransformState } from "../hooks/useChartTransformState";
import {
  withDecay,
  cancelAnimation,
  type AnimationCallback,
  ReduceMotion,
  type SharedValue,
  runOnJS,
  withSpring,
  withTiming,
} from "react-native-reanimated";

type Dimension = "x" | "y";

export type PinchTransformGestureConfig = {
  enabled?: boolean;
  dimensions?: Dimension | Dimension[];
};
export const pinchTransformGesture = (
  state: ChartTransformState,
  _config: PinchTransformGestureConfig = {},
): PinchGesture => {
  const defaults: PinchTransformGestureConfig = {
    enabled: true,
    dimensions: ["x", "y"],
  };
  const config = { ...defaults, ..._config };
  const dimensions = Array.isArray(config.dimensions)
    ? config.dimensions
    : [config.dimensions];
  const scaleX = dimensions.includes("x");
  const scaleY = dimensions.includes("y");

  const pinch = Gesture.Pinch()
    .onBegin((e) => {
      state.offset.value = state.matrix.value;
      state.origin.value = {
        x: e.focalX,
        y: e.focalY,
      };
    })
    .onStart(() => {
      state.zoomActive.value = true;
    })
    .onChange((e) => {
      state.matrix.value = multiply4(
        state.offset.value,
        scale(
          scaleX ? e.scale : 1,
          scaleY ? e.scale : 1,
          1,
          state.origin.value,
        ),
      );
    })
    .onEnd(() => {
      state.zoomActive.value = false;
    });

  return pinch;
};

export type PanTransformGestureConfig = {
  enabled?: boolean;
  dimensions?: Dimension | Dimension[];
} & Pick<PanGestureConfig, "activateAfterLongPress">;
export const panTransformGesture = (
  state: ChartTransformState,
  _config: PanTransformGestureConfig = {},
): PanGesture => {
  const defaults: PanTransformGestureConfig = {
    enabled: true,
    dimensions: ["x", "y"],
  };
  const config = { ...defaults, ..._config };
  const dimensions = Array.isArray(config.dimensions)
    ? config.dimensions
    : [config.dimensions];
  const panX = dimensions.includes("x");
  const panY = dimensions.includes("y");

  const pan = Gesture.Pan()
    .onStart(() => {
      state.panActive.value = true;
    })
    .onChange((e) => {
      state.matrix.value = multiply4(
        translate(panX ? e.changeX : 0, panY ? e.changeY : 0, 0),
        state.matrix.value,
      );
    })
    .onEnd(() => {
      state.panActive.value = false;
    });

  if (config.activateAfterLongPress !== undefined) {
    pan.activateAfterLongPress(config.activateAfterLongPress);
  }

  return pan;
};

const springConfig = {
  damping: 15,
  mass: 1,
  stiffness: 100,
  overshootClamping: false,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

const DEFAULT_VIEWPORT_WIDTH = 300;
// UIScrollView's normal deceleration rate is 0.998 per millisecond: a fling's speed falls by e every ~500 ms.
const DECELERATION_TIME_CONSTANT_MS = -1 / Math.log(0.998);
// A scroll decelerating onto where it rests is done once it is this close.
const REST_DISTANCE = 0.5;

/**
 * Decelerates from `from` onto `to` along UIScrollView's exponential curve: the one a fling of the same reach follows,
 * scaled to end exactly on `to`. As with UIKit's adjusted target content offset, a fling keeps its momentum and only
 * where it rests moves. Reduce Motion doesn't skip it, as it doesn't stop a UIScrollView decelerating: the momentum is
 * the finger's own motion, and skipping the curve would jump the content to where it rests.
 */
const withDecelerationTo = (
  from: number,
  to: number,
  callback: AnimationCallback,
) => {
  "worklet";
  // Time constants until the exponential would come within REST_DISTANCE; normalizing the curve rests it there exactly.
  const timeConstants = Math.log(
    Math.max(Math.abs(to - from), 2 * REST_DISTANCE) / REST_DISTANCE,
  );
  return withTiming(
    to,
    {
      duration: timeConstants * DECELERATION_TIME_CONSTANT_MS,
      reduceMotion: ReduceMotion.Never,
      easing: (progress: number) => {
        "worklet";
        return (
          (1 - Math.exp(-timeConstants * progress)) /
          (1 - Math.exp(-timeConstants))
        );
      },
    },
    callback,
  );
};

/**
 * Where a user scroll can rest, `[newest end, oldest start]`. The scroll is reversed, so the end is negative and the
 * start positive.
 */
export const getScrollBounds = (
  dimensions: Partial<{ totalContentWidth: number; width: number }>,
  maxScrollOffset?: number,
): [number, number] => {
  const viewportWidth = dimensions.width || DEFAULT_VIEWPORT_WIDTH;
  const width = dimensions.totalContentWidth || DEFAULT_VIEWPORT_WIDTH;
  // 48 is the max scroll offset - give cushion
  return [-(maxScrollOffset || 48), Math.max(0, width - viewportWidth)];
};

/**
 * Where a resting scroll moves when the scroll bounds change: to the new edge of a side that contracted past it.
 * Otherwise it stays, including a `scrollTo` offset that already sat past an edge that didn't move.
 */
export const getContractedScroll = (
  scrollX: number,
  [prevMinScroll, prevMaxScroll]: [number, number],
  [minScroll, maxScroll]: [number, number],
): number | undefined => {
  if (maxScroll < prevMaxScroll && scrollX > maxScroll) return maxScroll;
  if (minScroll > prevMinScroll && scrollX < minScroll) return minScroll;
  return undefined;
};

export const scrollTransformGesture = ({
  scrollX,
  prevTranslateX,
  viewportWidth,
  dimensions,
  onScroll,
  onScrollEnd,
  snapScroll,
  scrollBounds,
  isScrolling,
}: {
  scrollX: SharedValue<number>;
  prevTranslateX: SharedValue<number>;
  viewportWidth: number;
  dimensions: Partial<{ totalContentWidth: number; width: number }>;
  onScroll?: (data: any) => void;
  /** Called on JS with the final `scrollX` once a user scroll's fling or spring-back comes to rest. */
  onScrollEnd?: (scrollX: number) => void;
  /**
   * Where a released drag or fling that would stop at `scrollX` rests instead. The scroll decelerates onto it; without
   * it, a fling decays with `withDecay` and rests anywhere.
   */
  snapScroll?: (scrollX: number) => number;
  /** The current `getScrollBounds`. A fling outlives the render that started it, so it reads them as it settles. */
  scrollBounds: SharedValue<[number, number]>;
  isScrolling: SharedValue<boolean>;
}): PanGesture => {
  // A cancelled animation (by the next pan, or a programmatic scroll) is not the end of this scroll.
  const reportScrollEnd = (finished?: boolean) => {
    "worklet";
    isScrolling.value = false;
    if (finished && onScrollEnd) runOnJS(onScrollEnd)(scrollX.value);
  };
  const endScroll = (finished?: boolean) => {
    "worklet";
    // The bounds can contract while a fling settles (shorter data, a smaller `maxScrollOffset`), so it returns into
    // them before reporting where it rests.
    const [minScroll, maxScroll] = scrollBounds.value;
    const restingScroll = Math.min(
      Math.max(scrollX.value, minScroll),
      maxScroll,
    );
    if (finished && restingScroll !== scrollX.value) {
      scrollX.value = withSpring(restingScroll, springConfig, reportScrollEnd);
      return;
    }
    reportScrollEnd(finished);
  };
  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onStart(() => {
      cancelAnimation(scrollX);
      prevTranslateX.value = scrollX.value;
      isScrolling.value = true;
    })
    .onChange((e) => {
      const chartWidth = dimensions.width || 300;
      const change = e.changeX / chartWidth;
      if (onScroll)
        runOnJS(onScroll)({
          change,
        });
    })
    .onUpdate((e) => {
      isScrolling.value = true;
      // For reversed scroll: minScroll is negative (end/newest), maxScroll is positive (start/oldest)
      const [minScroll, maxScroll] = scrollBounds.value;

      const potentialNewValue = prevTranslateX.value + e.translationX;
      const rubberBandFactor = 0.55;

      if (potentialNewValue < minScroll) {
        // Too far toward newest data (beyond end)
        const overscroll = minScroll - potentialNewValue;
        const dampedOverscroll = overscroll * rubberBandFactor;
        scrollX.value = minScroll - dampedOverscroll;
      } else if (potentialNewValue > maxScroll) {
        // Too far toward oldest data (beyond start)
        const overscroll = potentialNewValue - maxScroll;
        const dampedOverscroll = overscroll * rubberBandFactor;
        scrollX.value = maxScroll + dampedOverscroll;
      } else {
        scrollX.value = potentialNewValue;
      }
    })

    .onEnd((e) => {
      const [minScroll, maxScroll] = scrollBounds.value;
      const currentScroll = scrollX.value;

      if (currentScroll < minScroll) {
        scrollX.value = withSpring(minScroll, springConfig, endScroll);
      } else if (currentScroll > maxScroll) {
        scrollX.value = withSpring(maxScroll, springConfig, endScroll);
      } else if (snapScroll) {
        const restingScroll = Math.min(
          Math.max(
            snapScroll(
              currentScroll +
                (e.velocityX / 1000) * DECELERATION_TIME_CONSTANT_MS,
            ),
            minScroll,
          ),
          maxScroll,
        );
        scrollX.value = withDecelerationTo(
          currentScroll,
          restingScroll,
          endScroll,
        );
      } else {
        scrollX.value = withDecay(
          {
            velocity: e.velocityX,
            clamp: [minScroll, maxScroll],
          },
          endScroll,
        );
      }
    });

  return panGesture;
};
