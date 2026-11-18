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
// A scroll decelerating onto where it rests is done once the curve comes this close. On the momentum curve it's moving
// under 10 px/s by then; a fling slowed to rest short of where its momentum would stop is still faster, as it keeps
// its release speed over a shorter distance.
const REST_DISTANCE = 2;
// How far, in px, a resting place can sit past a limit, or move, before it counts: under a pixel.
const REACH_TOLERANCE = 0.5;

/**
 * The plot's geometry in scroll terms, read on each frame, so a scroll that outlasts a render follows the chart's
 * latest layout. Each gives `NaN` while the chart has no finite x values (unmeasured, empty data, a zero-width domain).
 */
export type ScrollGeometry = {
  /** The scroll limits laid out with the scale, `[newest end, oldest start]` (`getScrollBounds`). */
  limits: () => [number, number];
  /** The x value at the plot's right edge with the chart scrolled to `scroll`. */
  rightEdgeXAt: (scroll: number) => number;
  /** The scroll that puts `rightEdgeX` at the plot's right edge. */
  scrollAt: (rightEdgeX: number) => number;
  /** The x values at the plot's left and right edges with the chart scrolled to `scroll`. */
  visibleXDomainAt: (scroll: number) => [number, number];
};

/**
 * The plot's scale and scroll limits as one snapshot, which a chart publishes in one write, so a release reads limits
 * that match the scale it picks a resting place on. A point at x is drawn at `rangeStart + (x - domainStart) *
 * pixelsPerX`, plus the scroll, plus `drawnShift` (`scrollXDerived`). There's no scale (`pixelsPerX` is `NaN`) for a
 * zero-width domain, or while the chart has no samples, though fixed axes would keep its domain.
 */
export const getScrollSnapshot = ({
  xDomain: [domainStart, domainEnd],
  xRange: [rangeStart, rangeEnd],
  plotLeft,
  plotRight,
  canvasWidth,
  dimensions,
  maxScrollOffset,
  hasSamples,
}: {
  xDomain: [number, number];
  xRange: [number, number];
  plotLeft: number;
  plotRight: number;
  canvasWidth: number;
  dimensions: Partial<{ totalContentWidth: number; width: number }>;
  maxScrollOffset?: number;
  hasSamples: boolean;
}) => {
  const pixelsPerX = (rangeEnd - rangeStart) / (domainEnd - domainStart);
  return {
    domainStart,
    rangeStart,
    pixelsPerX:
      hasSamples && Number.isFinite(pixelsPerX) && pixelsPerX !== 0
        ? pixelsPerX
        : Number.NaN,
    plotLeft,
    plotRight,
    drawnShift: canvasWidth - (dimensions.totalContentWidth || 0),
    limits: getScrollBounds(dimensions, maxScrollOffset),
  };
};

export type ScrollSnapshot = ReturnType<typeof getScrollSnapshot>;

/**
 * The scroll geometry of the snapshot `getSnapshot` returns on each call, a worklet such as one reading a shared value,
 * so a fling that outlasts a render follows the chart's latest snapshot.
 */
export const scrollGeometryFrom = (
  getSnapshot: () => ScrollSnapshot,
): ScrollGeometry => {
  const xAt = (pixel: number, scroll: number) => {
    "worklet";
    const g = getSnapshot();
    return (
      g.domainStart +
      (pixel - scroll - g.drawnShift - g.rangeStart) / g.pixelsPerX
    );
  };
  return {
    limits: () => {
      "worklet";
      return getSnapshot().limits;
    },
    rightEdgeXAt: (scroll) => {
      "worklet";
      return xAt(getSnapshot().plotRight, scroll);
    },
    scrollAt: (rightEdgeX) => {
      "worklet";
      const g = getSnapshot();
      return (
        g.plotRight -
        g.drawnShift -
        g.rangeStart -
        (rightEdgeX - g.domainStart) * g.pixelsPerX
      );
    },
    visibleXDomainAt: (scroll) => {
      "worklet";
      const g = getSnapshot();
      return [xAt(g.plotLeft, scroll), xAt(g.plotRight, scroll)];
    },
  };
};

/**
 * The plot's left and right pixels: the viewport's x values, or the domain's ends. Any finite pixel stands, 0 included,
 * where the first timestamp of an unpadded chart sits; only one the scale can't place falls back to `xScale(0)`.
 */
export const getPlotXEdges = (
  xScale: (x: number) => number,
  viewportX: [number, number] | undefined,
  [domainStart, domainEnd]: number[] = [],
) => {
  const pixelAt = (x: number) => {
    const pixel = xScale(x);
    return Number.isFinite(pixel) ? pixel : xScale(0);
  };
  return {
    left: pixelAt(viewportX?.[0] ?? domainStart ?? 0),
    right: pixelAt(viewportX?.[1] ?? domainEnd ?? 0),
  };
};

const isFiniteDomain = (domain: [number, number]) => {
  "worklet";
  return Number.isFinite(domain[0]) && Number.isFinite(domain[1]);
};

/**
 * Decelerates the scroll from `from` onto the x value `toX`, along an exponential curve like UIScrollView's, scaled to
 * end exactly there. It moves through x values and maps each frame to the chart's current scroll offsets, so a
 * remeasure as it settles (data loading, a wider y label) neither moves it off `toX` nor turns it back on screen. While
 * `toX` stays inside the limits it stays the target. When a limit contracts past it, `pickRestX` picks again inside
 * the new limits, and the scroll curves there from where the last frame drew it, at the speed it's moving, without
 * passing the limit. `onTarget` hears the x values at the plot's edges where it will rest whenever either moves by more
 * than half a pixel from what it last heard, as a new pick or a remeasure can move them.
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
const withDecelerationTo = ({
  geometry,
  from,
  toX,
  velocity,
  pickRestX,
  reported,
  onTarget,
  callback,
}: {
  geometry: ScrollGeometry;
  from: number;
  toX: number;
  velocity: number;
  pickRestX: (stopScroll: number) => number;
  /** The x values `onTarget` last heard, at release. */
  reported: [number, number];
  onTarget?: (visibleXDomain: [number, number]) => void;
  callback: AnimationCallback;
}): number => {
  "worklet";
  return defineAnimation<AnimationObject<number>>(from, () => {
    "worklet";
    const scrollWithin = (scroll: number) => {
      "worklet";
      const [minScroll, maxScroll] = geometry.limits();
      return Math.min(Math.max(scroll, minScroll), maxScroll);
    };
    // Aims the curve from `fromScroll`, moving at `speed` (px/ms), onto `aimX`, from `now`.
    const aim = (
      animation: AnimationObject<number>,
      fromScroll: number,
      aimX: number,
      speed: number,
      now: number,
    ) => {
      "worklet";
      const distance = geometry.scrollAt(aimX) - fromScroll;
      // Time constants until the exponential would come within REST_DISTANCE; normalizing the curve rests it there.
      const timeConstants = Math.log(
        Math.max(Math.abs(distance), 2 * REST_DISTANCE) / REST_DISTANCE,
      );
      const settled = 1 - Math.exp(-timeConstants);
      // In px/ms. The normalized curve starts at `distance / (timeConstantMs * settled)`.
      const restingStartSpeed =
        Math.abs(distance) / (DECELERATION_TIME_CONSTANT_MS * settled);
      const startSpeed =
        distance * speed > 0
          ? Math.max(
              Math.abs(speed),
              restingStartSpeed - Math.abs(speed) / settled,
            )
          : restingStartSpeed;
      animation.startTime = now;
      animation.fromX = geometry.rightEdgeXAt(fromScroll);
      animation.toX = aimX;
      animation.distance = distance;
      animation.timeConstants = timeConstants;
      animation.settled = settled;
      // Released already there, it rests on its first frame.
      animation.durationMs =
        Math.abs(distance) < 0.01
          ? 0
          : (timeConstants * Math.abs(distance)) / (startSpeed * settled);
    };
    // Tells `onTarget` where it will rest when that moves by more than a pixel's x values at either edge.
    const reportTarget = (animation: AnimationObject<number>) => {
      "worklet";
      const toScroll = scrollWithin(geometry.scrollAt(animation.toX));
      const domain = geometry.visibleXDomainAt(toScroll);
      const halfPixelX = Math.abs(
        geometry.rightEdgeXAt(toScroll + REACH_TOLERANCE) -
          geometry.rightEdgeXAt(toScroll),
      );
      const [left, right] = animation.reported;
      if (
        onTarget &&
        isFiniteDomain(domain) &&
        Math.max(Math.abs(domain[0] - left), Math.abs(domain[1] - right)) >
          halfPixelX
      ) {
        animation.reported = domain;
        onTarget(domain);
      }
    };

    return {
      isHigherOrder: true,
      onStart: (
        animation: AnimationObject<number>,
        _value: number,
        now: number,
      ) => {
        aim(animation, from, toX, velocity / 1000, now);
        animation.reported = reported;
        animation.lastX = animation.fromX;
        animation.lastTime = now;
        // A drag released past a limit returns into the limits along the curve; only a scroll that's been inside them
        // is kept there.
        animation.hasBeenInside =
          Math.abs(scrollWithin(from) - from) <= REACH_TOLERANCE;
        animation.current = from;
      },
      onFrame: (animation: AnimationObject<number>, now: number) => {
        // Started from a gesture callback, it takes the clock's time, and its first frame can pass an earlier vsync
        // time. Start from that frame, as `withTiming` does, or the first frame steps back.
        if (now < animation.startTime) {
          animation.startTime = now;
          animation.lastTime = now;
        }

        const toScroll = geometry.scrollAt(animation.toX);
        // Converting an x value at a limit back to offsets can land a rounding error past it, which isn't a contraction.
        const isPastLimit =
          Math.abs(scrollWithin(toScroll) - toScroll) > REACH_TOLERANCE;
        const repickedX = isPastLimit
          ? pickRestX(scrollWithin(toScroll))
          : Number.NaN;
        const repickedScroll = geometry.scrollAt(repickedX);
        // Where the last frame drew it, in the current geometry, and inside a limit that's overtaken it.
        const drawnScroll = geometry.scrollAt(animation.lastX);
        const lastScroll = scrollWithin(drawnScroll);
        // A refresh that trims the bars on screen while keeping the target leaves the last frame past a limit.
        const isDrawnPastLimit =
          animation.hasBeenInside &&
          Math.abs(lastScroll - drawnScroll) > REACH_TOLERANCE;
        const isRepicked =
          Number.isFinite(repickedScroll) &&
          Math.abs(repickedScroll - toScroll) > REACH_TOLERANCE;
        if (Number.isFinite(lastScroll) && (isRepicked || isDrawnPastLimit)) {
          // The new curve starts where and when the last frame drew it, inside the limits, at the speed it had then
          // (px/ms), and this frame advances along it, so a target that moves on every frame doesn't hold the scroll
          // still.
          const { durationMs, timeConstants, settled } = animation;
          const lastProgress =
            durationMs > 0
              ? Math.min(
                  1,
                  (animation.lastTime - animation.startTime) / durationMs,
                )
              : 1;
          const speed =
            lastProgress < 1
              ? (animation.distance *
                  timeConstants *
                  Math.exp(-timeConstants * lastProgress)) /
                (settled * durationMs)
              : 0;
          aim(
            animation,
            lastScroll,
            isRepicked ? repickedX : animation.toX,
            speed,
            animation.lastTime,
          );
        }
        reportTarget(animation);

        const { durationMs, timeConstants, settled, fromX } = animation;
        const progress =
          durationMs > 0
            ? Math.min(1, (now - animation.startTime) / durationMs)
            : 1;
        const x =
          progress === 1
            ? animation.toX
            : fromX +
              ((animation.toX - fromX) *
                (1 - Math.exp(-timeConstants * progress))) /
                settled;
        const scroll =
          progress === 1
            ? scrollWithin(geometry.scrollAt(animation.toX))
            : geometry.scrollAt(x);
        animation.lastTime = now;
        // A remeasure that loses the chart's x values holds the last frame.
        if (Number.isFinite(scroll)) {
          animation.current = scroll;
          animation.lastX = x;
          if (Math.abs(scrollWithin(scroll) - scroll) <= REACH_TOLERANCE) {
            animation.hasBeenInside = true;
          }
        }
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
  /**
   * The plot's scale and scroll limits, published together. A fling outlives the render that started it, so it reads
   * them as it settles; the limits come only from here, so they always match the scale.
   */
  scrollGeometry: ScrollGeometry;
  /**
   * Where a released drag or fling rests: given the x value at the plot's right edge where it would stop, inside the
   * limits, and the right-edge x values the limits reach, the x value to rest on, which should be inside them. The
   * scroll decelerates, or springs back from past a limit, onto it. Without it, or while the chart has no finite x
   * values, a fling decays with `withDecay` and rests anywhere.
   */
  snapScrollEnd?: (rightEdgeX: number, reachable: [number, number]) => number;
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
    const [minScroll, maxScroll] = scrollGeometry.limits();
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
  // `scroll` inside the limits published with the scale.
  const scrollWithin = (scroll: number) => {
    "worklet";
    const [minScroll, maxScroll] = scrollGeometry.limits();
    return Math.min(Math.max(scroll, minScroll), maxScroll);
  };
  // The x value a scroll that would stop at `stopScroll` rests on: `snapScrollEnd`'s pick, inside the x values the
  // limits reach. `NaN`, without asking `snapScrollEnd`, while the chart has no finite x values.
  const getRestX = (stopScroll: number) => {
    "worklet";
    const [minScroll, maxScroll] = scrollGeometry.limits();
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
      const [minScroll, maxScroll] = scrollGeometry.limits();

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
      // The limits laid out with the scale, which the bounds of a chart re-rendering mid-release may not match yet.
      const [minScroll, maxScroll] = scrollGeometry.limits();
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
      // Reports where it will rest, unless the system cancelled the pan.
      const onTarget =
        success && onScrollEndTarget
          ? (domain: [number, number]) => {
              "worklet";
              runOnJS(onScrollEndTarget)(domain);
            }
          : undefined;
      onTarget?.(restDomain);
      scrollX.value = withDecelerationTo({
        geometry: scrollGeometry,
        from: currentScroll,
        toX: restX,
        velocity,
        pickRestX: getRestX,
        reported: restDomain,
        onTarget,
        callback: endScroll,
      });
    });

  return panGesture;
};
