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
 * The plot's geometry in scroll terms, read on each frame, so a scroll that outlasts a render follows the chart's
 * latest layout. Each gives `NaN` while the chart has no finite x values (unmeasured, empty data, a zero-width domain).
 */
export type ScrollGeometry = {
  /** The x value at the plot's right edge with the chart scrolled to `scroll`. */
  rightEdgeXAt: (scroll: number) => number;
  /** The scroll that puts `rightEdgeX` at the plot's right edge. */
  scrollAt: (rightEdgeX: number) => number;
  /** The x values at the plot's left and right edges with the chart scrolled to `scroll`. */
  visibleXDomainAt: (scroll: number) => [number, number];
};

const isFiniteDomain = (domain: [number, number]) => {
  "worklet";
  return Number.isFinite(domain[0]) && Number.isFinite(domain[1]);
};

/**
 * Decelerates the scroll from `from` onto the x value `toX`, along an exponential curve like UIScrollView's, scaled to
 * end exactly there. It moves through x values and maps each frame to the chart's current scroll offsets, so a
 * remeasure as it settles (data loading, a wider y label) neither moves it off `toX` nor turns it back on screen. The
 * last frame lands on `toX` inside the limits as they are then (`scrollWithin`).
 *
 * As with UIKit's adjusted target content offset, a fling keeps its momentum and only where it rests moves: it starts
 * at its release `velocity`, slowing harder to rest short of where its momentum would stop, or longer to rest past
 * it. A release too slow to carry it half way blends toward the curve a drag released at rest takes, which settles
 * briskly, so it never starts slower than the finger and never drifts.
 *
 * It's a higher-order animation, which Reduce Motion doesn't skip, as Reduce Motion doesn't stop a UIScrollView
 * decelerating: the momentum is the finger's own motion, and skipping the curve would jump the content to where it
 * rests. (Reanimated's `ReduceMotion`, which would say so, only arrived in 3.5.)
 */
const withDecelerationTo = (
  geometry: ScrollGeometry,
  scrollWithin: (scroll: number) => number,
  from: number,
  toX: number,
  velocity: number,
  callback: AnimationCallback,
): number => {
  "worklet";
  return defineAnimation<AnimationObject<number>>(from, () => {
    "worklet";
    const fromX = geometry.rightEdgeXAt(from);
    const distance = geometry.scrollAt(toX) - from;
    const releaseSpeed = Math.abs(velocity) / 1000;
    // Time constants until the exponential would come within REST_DISTANCE; normalizing the curve rests it there exactly.
    const timeConstants = Math.log(
      Math.max(Math.abs(distance), 2 * REST_DISTANCE) / REST_DISTANCE,
    );
    const settled = 1 - Math.exp(-timeConstants);
    // In px/ms. The normalized curve starts at `distance / (timeConstantMs * settled)`.
    const restingStartSpeed =
      Math.abs(distance) / (DECELERATION_TIME_CONSTANT_MS * settled);
    const startSpeed =
      distance * velocity > 0
        ? Math.max(releaseSpeed, restingStartSpeed - releaseSpeed / settled)
        : restingStartSpeed;
    // Released already there, it rests on its first frame.
    const durationMs =
      Math.abs(distance) < 0.01
        ? 0
        : (timeConstants * Math.abs(distance)) / (startSpeed * settled);

    return {
      isHigherOrder: true,
      onStart: (
        animation: AnimationObject<number>,
        _value: number,
        now: number,
      ) => {
        animation.startTime = now;
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
        const travelled = (1 - Math.exp(-timeConstants * progress)) / settled;
        const scroll =
          progress === 1
            ? scrollWithin(geometry.scrollAt(toX))
            : geometry.scrollAt(fromX + (toX - fromX) * travelled);
        // A remeasure that loses the chart's x values holds the last frame.
        if (Number.isFinite(scroll)) animation.current = scroll;
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
  scrollGeometry,
  snapScrollEnd,
  scrollBounds,
  isScrolling,
}: {
  scrollX: SharedValue<number>;
  prevTranslateX: SharedValue<number>;
  viewportWidth: number;
  dimensions: Partial<{ totalContentWidth: number; width: number }>;
  onScroll?: (data: any) => void;
  /**
   * Called on JS with the x values at the plot's edges once a user scroll's fling or spring-back comes to rest, worked
   * out from that frame. Not called while the chart has no finite x values.
   */
  onScrollEnd?: (visibleXDomain: [number, number]) => void;
  /**
   * Called on JS, as a released drag or fling starts settling onto `snapScrollEnd`'s pick, with the x values at the
   * plot's edges there, worked out at release. Not called for a pan the system cancels.
   */
  onScrollEndTarget?: (visibleXDomain: [number, number]) => void;
  scrollGeometry: ScrollGeometry;
  /**
   * Where a released drag or fling rests: given the x value at the plot's right edge where it would stop, inside the
   * limits, and the right-edge x values the limits reach, the x value to rest on, which should be inside them. The
   * scroll decelerates, or springs back from past a limit, onto it. Without it, or while the chart has no finite x
   * values, a fling decays with `withDecay` and rests anywhere.
   */
  snapScrollEnd?: (rightEdgeX: number, reachable: [number, number]) => number;
  /** The current `getScrollBounds`. A fling outlives the render that started it, so it reads them as it settles. */
  scrollBounds: SharedValue<[number, number]>;
  isScrolling: SharedValue<boolean>;
}): PanGesture => {
  // A cancelled animation (by the next pan, or a programmatic scroll) is not the end of this scroll.
  const reportScrollEnd = (finished?: boolean) => {
    "worklet";
    isScrolling.value = false;
    if (!finished || !onScrollEnd) return;
    // Worked out on this frame, before a render can change the geometry the JS thread would read.
    const visibleXDomain = scrollGeometry.visibleXDomainAt(scrollX.value);
    if (isFiniteDomain(visibleXDomain)) runOnJS(onScrollEnd)(visibleXDomain);
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
  // The x value a scroll that would stop at `stopScroll` rests on: `snapScrollEnd`'s pick, inside the x values the
  // limits reach. `NaN`, without asking `snapScrollEnd`, while the chart has no finite x values.
  const getRestX = (stopScroll: number) => {
    "worklet";
    const [minScroll, maxScroll] = scrollBounds.value;
    const stopX = scrollGeometry.rightEdgeXAt(stopScroll);
    const limitXs = [
      scrollGeometry.rightEdgeXAt(maxScroll),
      scrollGeometry.rightEdgeXAt(minScroll),
    ];
    if (!snapScrollEnd || ![stopX, ...limitXs].every(Number.isFinite)) {
      return Number.NaN;
    }
    const reachable: [number, number] = [
      Math.min(...limitXs),
      Math.max(...limitXs),
    ];
    const restX = snapScrollEnd(stopX, reachable);
    return Number.isFinite(restX)
      ? Math.min(Math.max(restX, reachable[0]), reachable[1])
      : Number.NaN;
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
      // on a whole bar inside it.
      const restX = getRestX(
        scrollWithin(
          boundedScroll + (velocity / 1000) * DECELERATION_TIME_CONSTANT_MS,
        ),
      );
      const restScroll = scrollWithin(scrollGeometry.scrollAt(restX));
      const restDomain = scrollGeometry.visibleXDomainAt(restScroll);

      // Without a snap, or an x value to rest on.
      if (!Number.isFinite(restScroll) || !isFiniteDomain(restDomain)) {
        scrollX.value = isOverscrolled
          ? withSpring(boundedScroll, springConfig, endScroll)
          : withDecay({ velocity, clamp: [minScroll, maxScroll] }, endScroll);
        return;
      }
      if (success && onScrollEndTarget) {
        runOnJS(onScrollEndTarget)(restDomain);
      }
      scrollX.value = withDecelerationTo(
        scrollGeometry,
        scrollWithin,
        currentScroll,
        restX,
        velocity,
        endScroll,
      );
    });

  return panGesture;
};
