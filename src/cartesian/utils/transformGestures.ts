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
  type AnimationObject,
  defineAnimation,
  type SharedValue,
  runOnJS,
  withSpring,
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
// 0.996 per millisecond, between UIScrollView's normal (0.998) and fast (0.99) rates: a fling's speed falls by e every
// ~250 ms, so a fast fling comes to rest within about a second and a half.
const DECELERATION_TIME_CONSTANT_MS = -1 / Math.log(0.996);
// A scroll decelerating onto where it rests is done once it is this close, by then moving under 10 px/s.
const REST_DISTANCE = 2;

/**
 * Where a released scroll comes to rest, worked out in the chart's x values from the plot's geometry as it is on each
 * frame, so a scroll that settles while the chart remeasures still rests on the x value picked at release.
 */
export type ScrollRest = {
  /** The x value at the plot's right edge with the chart scrolled to `scroll`. */
  rightEdgeXAt: (scroll: number) => number;
  /** The scroll that puts `rightEdgeX` at the plot's right edge. */
  scrollAt: (rightEdgeX: number) => number;
  /** The x values at the plot's left and right edges with the chart scrolled to `scroll`. */
  visibleXDomainAt: (scroll: number) => [number, number];
  /** Where a scroll whose right edge would stop at `rightEdgeX` rests instead (`snapScrollEnd`). */
  snap: (rightEdgeX: number) => number;
};

/**
 * Decelerates from `from` onto the scroll `getTo` returns on each frame, along an exponential curve like
 * UIScrollView's, scaled to end exactly there. As with UIKit's adjusted target content offset, a fling keeps its
 * momentum and only where it rests moves: one that rests short of where its momentum would stop starts at its release
 * `velocity` and slows harder.
 *
 * It's a higher-order animation, which Reduce Motion doesn't skip, as Reduce Motion doesn't stop a UIScrollView
 * decelerating: the momentum is the finger's own motion, and skipping the curve would jump the content to where it
 * rests. (Reanimated's `ReduceMotion`, which would say so, only arrived in 3.5.)
 */
const withDecelerationTo = (
  from: number,
  getTo: () => number,
  velocity: number,
  callback: AnimationCallback,
): number => {
  "worklet";
  return defineAnimation<AnimationObject<number>>(from, () => {
    "worklet";
    const distance = getTo() - from;
    const releaseSpeed = velocity / 1000;
    // Time constants until the exponential would come within REST_DISTANCE; normalizing the curve rests it there exactly.
    const timeConstants = Math.log(
      Math.max(Math.abs(distance), 2 * REST_DISTANCE) / REST_DISTANCE,
    );
    // The normalized curve starts at `distance / (timeConstantMs * (1 - e^-timeConstants))`. Resting short of where
    // momentum would stop, it takes the time constant that starts it at the release speed.
    const timeConstantMs =
      distance * releaseSpeed > 0
        ? Math.min(
            DECELERATION_TIME_CONSTANT_MS,
            distance / (releaseSpeed * (1 - Math.exp(-timeConstants))),
          )
        : DECELERATION_TIME_CONSTANT_MS;
    const durationMs = timeConstants * timeConstantMs;

    return {
      isHigherOrder: true,
      onStart: (
        animation: AnimationObject<number>,
        _value: number,
        now: number,
      ) => {
        animation.startTime = now;
        animation.toValue = from + distance;
        animation.current = from;
      },
      onFrame: (animation: AnimationObject<number>, now: number) => {
        // Started from a gesture callback, it takes the clock's time, and its first frame can pass an earlier vsync
        // time. Start from that frame, as `withTiming` does, or the first frame steps back.
        if (now < animation.startTime) animation.startTime = now;
        const progress =
          durationMs > 0
            ? Math.min(1, (now - animation.startTime) / durationMs)
            : 1;
        // A remeasure moves where the picked x value is; one that loses it keeps the last place.
        const to = getTo();
        if (Number.isFinite(to)) animation.toValue = to;
        const target = animation.toValue as number;
        const travelled =
          (1 - Math.exp(-timeConstants * progress)) /
          (1 - Math.exp(-timeConstants));
        animation.current =
          progress === 1 ? target : from + (target - from) * travelled;
        return progress === 1;
      },
      current: from,
      callback,
    } as AnimationObject<number>;
  }) as unknown as number;
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
  onScrollEndTarget,
  scrollRest,
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
   * Called on JS, as a released drag or fling starts settling onto `scrollRest`'s resting place, with the x values at
   * the plot's edges there, worked out at release. Not called for a pan the system cancels.
   */
  onScrollEndTarget?: (visibleXDomain: [number, number]) => void;
  /**
   * Where a released drag or fling rests: it decelerates, or springs back from past a limit, onto the x value
   * `scrollRest.snap` picks. Without it, or while the chart can't place an x value, a fling decays with `withDecay` and
   * rests anywhere.
   */
  scrollRest?: ScrollRest;
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
  // `scroll` inside the limits as they are now.
  const scrollWithin = (scroll: number) => {
    "worklet";
    const [minScroll, maxScroll] = scrollBounds.value;
    return Math.min(Math.max(scroll, minScroll), maxScroll);
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

    .onEnd((e, success) => {
      const [minScroll, maxScroll] = scrollBounds.value;
      const currentScroll = scrollX.value;
      const boundedScroll = scrollWithin(currentScroll);
      const isOverscrolled = boundedScroll !== currentScroll;
      // A pan the system cancelled carries no momentum, nor does a drag released past a limit.
      const velocity = success && !isOverscrolled ? e.velocityX : 0;
      // Where momentum would stop it, inside the limits before picking where it rests, so a fling past a limit rests
      // on the last whole bar before it.
      const stopScroll = scrollWithin(
        boundedScroll + (velocity / 1000) * DECELERATION_TIME_CONSTANT_MS,
      );
      const restX = scrollRest
        ? scrollRest.snap(scrollRest.rightEdgeXAt(stopScroll))
        : Number.NaN;
      const getRestingScroll = () => {
        "worklet";
        return scrollRest
          ? scrollWithin(scrollRest.scrollAt(restX))
          : Number.NaN;
      };
      const restingScroll = getRestingScroll();

      // An unmeasured chart, or one whose data is briefly empty, has no x value to rest on.
      if (!scrollRest || !Number.isFinite(restingScroll)) {
        scrollX.value = isOverscrolled
          ? withSpring(boundedScroll, springConfig, endScroll)
          : withDecay({ velocity, clamp: [minScroll, maxScroll] }, endScroll);
        return;
      }
      if (success && onScrollEndTarget) {
        runOnJS(onScrollEndTarget)(scrollRest.visibleXDomainAt(restingScroll));
      }
      scrollX.value = isOverscrolled
        ? withSpring(restingScroll, springConfig, endScroll)
        : withDecelerationTo(
            currentScroll,
            getRestingScroll,
            velocity,
            endScroll,
          );
    });

  return panGesture;
};
