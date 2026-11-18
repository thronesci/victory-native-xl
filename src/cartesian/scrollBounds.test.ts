import { describe, it, expect, vi } from "vitest";
import type { SharedValue } from "react-native-reanimated";
import {
  getContractedScroll,
  getScrollBounds,
  getScrollSnapshot,
  type ScrollGeometry,
  scrollTransformGesture,
} from "./utils/transformGestures";

type Animation = {
  config?: { clamp?: [number, number] };
  toValue?: number;
  current?: number;
  isHigherOrder?: boolean;
  onStart?: (animation: Animation, value: number, now: number) => void;
  onFrame?: (animation: Animation, now: number) => boolean;
  callback: (finished: boolean) => void;
};
type PanHandlers = {
  onStart: () => void;
  onUpdate: (event: { translationX: number }) => void;
  onEnd: (event: { velocityX: number }, success: boolean) => void;
};

const panHandlers = vi.hoisted(() => ({}) as PanHandlers);
// While set, `runOnJS` queues its calls, as the JS thread runs them after the UI thread's frame.
const jsQueue = vi.hoisted(() => ({ calls: null as null | (() => void)[] }));

// Animations are records whose completion the test calls, as Reanimated does when one ends or is cancelled. There is
// no `ReduceMotion`: Reanimated before 3.5, which the peer range allows, doesn't export it.
vi.mock("react-native-reanimated", () => ({
  useSharedValue: (value: unknown) => ({ value }),
  cancelAnimation: () => {},
  defineAnimation: (_starting: unknown, factory: () => unknown) => factory(),
  runOnJS:
    (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      jsQueue.calls ? jsQueue.calls.push(() => fn(...args)) : fn(...args),
  withDecay: (
    config: { clamp: [number, number] },
    callback: (finished: boolean) => void,
  ): Animation => ({ config, callback }),
  withSpring: (
    toValue: number,
    _config: unknown,
    callback: (finished: boolean) => void,
  ): Animation => ({ toValue, callback }),
}));
vi.mock("@shopify/react-native-skia", () => ({}));
vi.mock("react-native-gesture-handler", () => ({
  Gesture: {
    Pan: () => {
      const pan: Record<string, (handler: unknown) => unknown> = {
        activeOffsetX: () => pan,
      };
      for (const name of ["onStart", "onChange", "onUpdate", "onEnd"]) {
        pan[name] = (handler) => {
          Object.assign(panHandlers, { [name]: handler });
          return pan;
        };
      }
      return pan;
    },
  },
}));

describe("getContractedScroll", () => {
  // A 300 px plot whose data spans 900 px, then 300 px.
  const wide = getScrollBounds({ width: 300, totalContentWidth: 900 }, 50);
  const short = getScrollBounds({ width: 300, totalContentWidth: 300 }, 50);

  it("moves a scroll at the oldest data to the new oldest edge when the data shortens", () => {
    expect(wide).toEqual([-50, 600]);
    expect(short).toEqual([-50, 0]);
    expect(getContractedScroll(600, wide, short)).toBe(0);
  });

  it("keeps an in-range scroll when wider data loads", () => {
    expect(getContractedScroll(600, short, wide)).toBeUndefined();
    expect(getContractedScroll(-50, short, wide)).toBeUndefined();
  });

  it("moves a scroll at the newest end to the new end when the end inset shrinks", () => {
    expect(getContractedScroll(-80, [-80, 600], [-20, 600])).toBe(-20);
  });

  it("keeps a scrollTo offset past an edge that didn't move", () => {
    expect(getContractedScroll(-70, short, wide)).toBeUndefined();
  });
});

describe("getScrollSnapshot", () => {
  const plot = {
    xDomain: [0, 100] as [number, number],
    xRange: [10, 1010] as [number, number],
    plotLeft: 10,
    plotRight: 310,
    canvasWidth: 300,
    dimensions: { width: 300, totalContentWidth: 1000 },
    maxScrollOffset: 30,
  };

  it("publishes the scale with the scroll limits it was laid out with", () => {
    expect(getScrollSnapshot({ ...plot, hasSamples: true })).toEqual({
      domainStart: 0,
      rangeStart: 10,
      pixelsPerX: 10,
      plotLeft: 10,
      plotRight: 310,
      drawnShift: -700,
      limits: getScrollBounds(plot.dimensions, 30),
    });
  });

  it("gives no scale while the chart has no samples, though fixed axes keep its domain", () => {
    expect(
      getScrollSnapshot({ ...plot, hasSamples: false }).pixelsPerX,
    ).toBeNaN();
  });

  it("gives no scale for a zero-width domain", () => {
    expect(
      getScrollSnapshot({ ...plot, xDomain: [10, 10], hasSamples: true })
        .pixelsPerX,
    ).toBeNaN();
  });
});

describe("scrollTransformGesture", () => {
  /**
   * A 300 px plot whose right edge's x value is its scroll offset plus `shift`. A remeasure (data loading, a wider y
   * label) changes `shift`; `NaN` stands for a chart with no finite x values, such as one whose data is empty.
   */
  function geometryFor(
    geometry: { shift: number },
    limits: () => [number, number],
  ): ScrollGeometry {
    return {
      limits,
      rightEdgeXAt: (scroll) => scroll + geometry.shift,
      scrollAt: (rightEdgeX) => rightEdgeX - geometry.shift,
      visibleXDomainAt: (scroll) => [
        scroll + geometry.shift - 300,
        scroll + geometry.shift,
      ],
    };
  }
  // Rests on 40 px bars inside the x values it can reach.
  const snapToBars = (rightEdgeX: number, [first, last]: [number, number]) => {
    const bar = Math.round(rightEdgeX / 40) * 40;
    return bar > last ? bar - 40 : bar < first ? bar + 40 : bar;
  };

  function scrollChart(
    bounds: [number, number],
    {
      geometry = { shift: 0 },
      snapshotLimits,
      snapScrollEnd,
      onScrollEndTarget,
    }: {
      geometry?: { shift: number };
      /** The limits published with the scale, when they differ from `scrollBounds` (which updates later). */
      snapshotLimits?: [number, number];
      snapScrollEnd?: (
        rightEdgeX: number,
        reachable: [number, number],
      ) => number;
      onScrollEndTarget?: (visibleXDomain: [number, number]) => void;
    } = {},
  ) {
    const scrollX: { value: number | Animation } = { value: 0 };
    const scrollBounds = { value: bounds };
    const isScrolling = { value: false };
    const onScrollEnd = vi.fn();
    scrollTransformGesture({
      scrollX: scrollX as unknown as SharedValue<number>,
      prevTranslateX: { value: 0 } as SharedValue<number>,
      viewportWidth: 300,
      dimensions: { width: 300, totalContentWidth: 900 },
      onScrollEnd,
      onScrollEndTarget,
      scrollGeometry: geometryFor(
        geometry,
        () => snapshotLimits ?? scrollBounds.value,
      ),
      snapScrollEnd,
      scrollBounds: scrollBounds as SharedValue<[number, number]>,
      isScrolling: isScrolling as SharedValue<boolean>,
    });
    // A drag from where the chart rests, released at `velocityX`. The system cancels the pan when `success` is false.
    const release = ({
      velocityX = -2000,
      translationX = 0,
      success = true,
    } = {}) => {
      panHandlers.onStart();
      panHandlers.onUpdate({ translationX });
      panHandlers.onEnd({ velocityX }, success);
      return scrollX.value as Animation;
    };
    // Runs an animation to `value`, then calls its completion.
    const settle = (
      animation: Animation,
      value: number,
      finished = true,
    ): number | Animation => {
      scrollX.value = value;
      animation.callback(finished);
      return scrollX.value;
    };
    return { scrollBounds, isScrolling, onScrollEnd, release, settle };
  }

  function fling(
    bounds: [number, number],
    {
      velocityX = -2000,
      ...options
    }: { velocityX?: number } & Parameters<typeof scrollChart>[1] = {},
  ) {
    const chart = scrollChart(bounds, options);
    return { ...chart, decay: chart.release({ velocityX }) };
  }

  // Runs a deceleration frame by frame from `from`, as Reanimated does, with `beforeFrame` run ahead of each frame.
  function runToRest(
    animation: Animation,
    from: number,
    beforeFrame?: (now: number) => void,
    afterFrame?: (scroll: number) => void,
  ) {
    animation.onStart?.(animation, from, 0);
    for (let now = 0; now <= 10_000; now += 16) {
      beforeFrame?.(now);
      const finished = animation.onFrame?.(animation, now);
      afterFrame?.(animation.current ?? Number.NaN);
      if (finished) {
        return { restingScroll: animation.current, restedAtMs: now };
      }
    }
    throw new Error("The scroll did not come to rest");
  }

  // The speed, in px/s, over a release's first millisecond.
  function startSpeed(animation: Animation, from: number) {
    animation.onStart?.(animation, from, 0);
    animation.onFrame?.(animation, 0);
    animation.onFrame?.(animation, 1);
    return ((animation.current ?? Number.NaN) - from) * 1000;
  }

  it("returns a fling into bounds that contracted while it settled before reporting where it rests", () => {
    const { scrollBounds, isScrolling, onScrollEnd, decay, settle } = fling([
      -80, 600,
    ]);
    expect(decay.config?.clamp).toEqual([-80, 600]);

    scrollBounds.value = [-20, 600];
    const springBack = settle(decay, -80) as Animation;
    expect(springBack.toValue).toBe(-20);
    expect(onScrollEnd).not.toHaveBeenCalled();
    expect(isScrolling.value).toBe(true);

    settle(springBack, -20);
    expect(onScrollEnd.mock.calls).toEqual([[[-320, -20]]]);
    expect(isScrolling.value).toBe(false);
  });

  it("reports a fling that rests inside the bounds as the x values at the plot's edges there", () => {
    const { onScrollEnd, decay, settle } = fling([-80, 600]);
    expect(settle(decay, -30)).toBe(-30);
    expect(onScrollEnd.mock.calls).toEqual([[[-330, -30]]]);
  });

  it("reports the x values of the frame it rests on, though the chart remeasures before the report arrives", () => {
    const geometry = { shift: 0 };
    const { onScrollEnd, decay, settle } = fling([-80, 600], { geometry });
    jsQueue.calls = [];
    try {
      settle(decay, -30);
      geometry.shift = 5;
      for (const call of jsQueue.calls) call();
    } finally {
      jsQueue.calls = null;
    }

    expect(onScrollEnd.mock.calls).toEqual([[[-330, -30]]]);
  });

  it("doesn't report a cancelled fling", () => {
    const { scrollBounds, isScrolling, onScrollEnd, decay, settle } = fling([
      -80, 600,
    ]);
    scrollBounds.value = [-20, 600];
    expect(settle(decay, -80, false)).toBe(-80);
    expect(onScrollEnd).not.toHaveBeenCalled();
    expect(isScrolling.value).toBe(false);
  });

  describe("resting on whole bars", () => {
    it("decelerates a fling onto the bar edge nearest where its momentum would stop", () => {
      const { onScrollEnd, decay, settle } = fling([-80, 600], {
        velocityX: 300,
        snapScrollEnd: snapToBars,
      });

      // Momentum alone would stop at about 75 px.
      expect(runToRest(decay, 0).restingScroll).toBe(80);
      settle(decay, 80);
      expect(onScrollEnd.mock.calls).toEqual([[[-220, 80]]]);
    });

    it("reports where a fling will rest, as x values, when the finger lifts", () => {
      const onScrollEndTarget = vi.fn();
      const { onScrollEnd } = fling([-80, 600], {
        velocityX: 300,
        snapScrollEnd: snapToBars,
        onScrollEndTarget,
      });

      expect(onScrollEndTarget.mock.calls).toEqual([[[-220, 80]]]);
      expect(onScrollEnd).not.toHaveBeenCalled();
    });

    it("keeps the x value it picked, moving the same way on screen, when the chart remeasures as it settles", () => {
      const geometry = { shift: 0 };
      const onScrollEndTarget = vi.fn();
      const rightEdgeXs: number[] = [];
      jsQueue.calls = [];
      try {
        const { decay } = fling([-80, 600], {
          velocityX: 300,
          geometry,
          snapScrollEnd: snapToBars,
          onScrollEndTarget,
        });
        // The chart remeasures before the JS thread runs the report, then again as the scroll settles.
        geometry.shift = 7;
        for (const call of jsQueue.calls) call();
        const { restingScroll } = runToRest(
          decay,
          0,
          (now) => {
            if (now === 160) geometry.shift = 12;
          },
          (scroll) => rightEdgeXs.push(scroll + geometry.shift),
        );

        expect(onScrollEndTarget.mock.calls).toEqual([[[-220, 80]]]);
        // Still x = 80 at the plot's right edge.
        expect(restingScroll).toBe(68);
        expect(rightEdgeXs.at(-1)).toBe(80);
        for (const [index, x] of rightEdgeXs.entries()) {
          expect(x).toBeGreaterThanOrEqual(rightEdgeXs[index - 1] ?? x);
        }
      } finally {
        jsQueue.calls = null;
      }
    });

    it("springs a drag released past a scroll limit back onto the bar it picked, through a remeasure", () => {
      const geometry = { shift: 0 };
      const onScrollEndTarget = vi.fn();
      const { release } = scrollChart([-80, 95], {
        geometry,
        snapScrollEnd: snapToBars,
        onScrollEndTarget,
      });

      const springBack = release({ translationX: 130, velocityX: 0 });
      const { restingScroll } = runToRest(springBack, 114.25, (now) => {
        if (now === 64) geometry.shift = -5;
      });

      expect(onScrollEndTarget.mock.calls).toEqual([[[-220, 80]]]);
      // x = 80 at the right edge, still inside the limit.
      expect(restingScroll).toBe(85);
    });

    it("rests a fling past a scroll limit on the last whole bar it can reach, reported once", () => {
      const onScrollEndTarget = vi.fn();
      const { decay } = fling([-80, 95], {
        velocityX: 1000,
        snapScrollEnd: snapToBars,
        onScrollEndTarget,
      });

      expect(onScrollEndTarget.mock.calls).toEqual([[[-220, 80]]]);
      expect(runToRest(decay, 0).restingScroll).toBe(80);
    });

    it("lets the snap pick a whole bar inside a limit between bar edges, and keeps it when the limit moves", () => {
      const onScrollEndTarget = vi.fn();
      const snapScrollEnd = vi.fn(snapToBars);
      const { scrollBounds, decay } = fling([-80, 110], {
        velocityX: 1000,
        snapScrollEnd,
        onScrollEndTarget,
      });
      scrollBounds.value = [-80, 130];

      expect(snapScrollEnd).toHaveBeenCalledWith(110, [-80, 110]);
      expect(onScrollEndTarget.mock.calls).toEqual([[[-220, 80]]]);
      expect(runToRest(decay, 0).restingScroll).toBe(80);
    });

    it("keeps the x value it reported when a snap that ignores the limits picks past one, and the limit then moves", () => {
      const onScrollEndTarget = vi.fn();
      const { scrollBounds, decay } = fling([-80, 110], {
        velocityX: 1000,
        snapScrollEnd: (rightEdgeX) => Math.round(rightEdgeX / 40) * 40,
        onScrollEndTarget,
      });
      scrollBounds.value = [-80, 130];

      expect(onScrollEndTarget.mock.calls).toEqual([[[-190, 110]]]);
      expect(runToRest(decay, 0).restingScroll).toBe(110);
    });

    it("picks a reachable bar again when a limit contracts past its bar, and curves there without passing the limit", () => {
      const onScrollEndTarget = vi.fn();
      const scrolls: number[] = [];
      const { scrollBounds, decay } = fling([-80, 600], {
        velocityX: -400,
        // Rests on 5 px bars inside the limits.
        snapScrollEnd: (rightEdgeX, [first, last]) =>
          Math.min(Math.max(Math.round(rightEdgeX / 5) * 5, first), last),
        onScrollEndTarget,
      });

      const { restingScroll } = runToRest(
        decay,
        0,
        (now) => {
          if (now === 32) scrollBounds.value = [-20, 600];
        },
        (scroll) => scrolls.push(scroll),
      );

      expect(onScrollEndTarget.mock.calls).toEqual([
        [[-380, -80]],
        [[-320, -20]],
      ]);
      expect(restingScroll).toBe(-20);
      for (const [index, scroll] of scrolls.entries()) {
        expect(scroll).toBeGreaterThanOrEqual(-20);
        expect(scroll).toBeLessThanOrEqual(scrolls[index - 1] ?? scroll);
      }
    });

    it("rests on a bar at a limit, reported once, though converting it to offsets lands a rounding error past the limit", () => {
      // Epoch-sized x values: -0.7 to x and back gives -0.7000000476837158, just past the limit.
      const onScrollEndTarget = vi.fn();
      const { decay } = fling([-0.7, 600], {
        velocityX: -2000,
        geometry: { shift: 1_000_000_000.1 },
        snapScrollEnd: (_rightEdgeX, [newest]) => newest,
        onScrollEndTarget,
      });

      const { restingScroll, restedAtMs } = runToRest(decay, 0);

      expect(onScrollEndTarget).toHaveBeenCalledTimes(1);
      expect(restingScroll).toBe(-0.7);
      expect(restedAtMs).toBeLessThan(1500);
    });

    it("picks where a release rests from the limits published with the scale, though the scroll bounds haven't caught up", () => {
      const onScrollEndTarget = vi.fn();
      const snapScrollEnd = vi.fn(snapToBars);
      const { decay } = fling([-80, 600], {
        velocityX: 2000,
        snapshotLimits: [-80, 52.5],
        snapScrollEnd,
        onScrollEndTarget,
      });

      expect(snapScrollEnd).toHaveBeenCalledWith(52.5, [-80, 52.5]);
      expect(onScrollEndTarget.mock.calls).toEqual([[[-260, 40]]]);
      expect(runToRest(decay, 0).restingScroll).toBe(40);
    });

    it("drops the momentum and reports nothing at release when the system cancels the pan", () => {
      const onScrollEndTarget = vi.fn();
      const { release } = scrollChart([-80, 600], {
        snapScrollEnd: snapToBars,
        onScrollEndTarget,
      });

      const settling = release({
        translationX: 47,
        velocityX: 2000,
        success: false,
      });

      expect(onScrollEndTarget).not.toHaveBeenCalled();
      expect(runToRest(settling, 47).restingScroll).toBe(40);
    });

    it("starts at the release speed when it rests short of where its momentum would stop", () => {
      const { decay } = fling([-80, 25], {
        velocityX: 2000,
        snapScrollEnd: (rightEdgeX) => Math.round(rightEdgeX / 5) * 5,
      });

      // Momentum alone would carry it about 500 px; it rests at 25.
      const speed = startSpeed(decay, 0);
      expect(speed).toBeGreaterThan(2000 * 0.95);
      expect(speed).toBeLessThan(2000 * 1.05);
      expect(runToRest(decay, 0).restingScroll).toBe(25);
    });

    it("starts at the release speed when it rests past where its momentum would stop", () => {
      const { decay } = fling([-80, 2000], {
        velocityX: 1000,
        snapScrollEnd: () => 400,
      });

      // Momentum alone would carry it about 250 px; it rests at 400.
      const speed = startSpeed(decay, 0);
      expect(speed).toBeGreaterThan(1000 * 0.95);
      expect(speed).toBeLessThan(1000 * 1.05);
      expect(runToRest(decay, 0).restingScroll).toBe(400);
    });

    it("comes to rest at once, reported once, when released already on a bar", () => {
      const { onScrollEnd, release, settle } = scrollChart([-80, 600], {
        snapScrollEnd: snapToBars,
      });

      const settling = release({ translationX: 40, velocityX: 0 });
      const { restingScroll, restedAtMs } = runToRest(settling, 40);
      settle(settling, restingScroll ?? Number.NaN);

      expect(restedAtMs).toBe(0);
      expect(onScrollEnd.mock.calls).toEqual([[[-260, 40]]]);
    });

    it("decelerates as a higher-order animation, which Reduce Motion doesn't skip", () => {
      // Momentum is the finger's own motion, as in a UIScrollView. Reanimated jumps only plain animations to their end.
      const { decay } = fling([-80, 600], {
        velocityX: 300,
        snapScrollEnd: snapToBars,
      });

      expect(decay.isHigherOrder).toBe(true);
    });

    it("brings a fast fling to rest within a second and a half", () => {
      const { decay } = fling([-2000, 2000], {
        velocityX: 2000,
        snapScrollEnd: snapToBars,
      });

      expect(runToRest(decay, 0).restedAtMs).toBeLessThan(1500);
    });

    it("keeps where it rests inside the bounds", () => {
      const { decay } = fling([-80, 600], {
        velocityX: 5000,
        snapScrollEnd: snapToBars,
      });

      expect(runToRest(decay, 0).restingScroll).toBe(600);
    });

    it("flings without a resting place and reports nothing while the chart has no x values, then rests on a bar", () => {
      // A snap worklet that expects real dates, as an app's does.
      const snapScrollEnd = vi.fn(
        (rightEdgeX: number, reachable: [number, number]) => {
          if (
            !Number.isFinite(rightEdgeX) ||
            !reachable.every(Number.isFinite)
          ) {
            throw new Error("Not a date");
          }
          return snapToBars(rightEdgeX, reachable);
        },
      );
      const geometry = { shift: Number.NaN };
      const onScrollEndTarget = vi.fn();
      const { onScrollEnd, isScrolling, release, settle } = scrollChart(
        [-80, 600],
        { geometry, snapScrollEnd, onScrollEndTarget },
      );

      const decay = release({ velocityX: 300 });
      expect(decay.config?.clamp).toEqual([-80, 600]);
      settle(decay, 0);
      expect(snapScrollEnd).not.toHaveBeenCalled();
      expect(onScrollEndTarget).not.toHaveBeenCalled();
      expect(onScrollEnd).not.toHaveBeenCalled();
      expect(isScrolling.value).toBe(false);

      geometry.shift = 0;
      const deceleration = release({ velocityX: 300 });
      expect(runToRest(deceleration, 0).restingScroll).toBe(80);
      expect(onScrollEndTarget.mock.calls).toEqual([[[-220, 80]]]);
    });
  });
});
