import { describe, it, expect, vi } from "vitest";
import type { SharedValue } from "react-native-reanimated";
import {
  getContractedScroll,
  getScrollBounds,
  type ScrollRest,
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

describe("scrollTransformGesture", () => {
  function scrollChart(
    bounds: [number, number],
    {
      scrollRest,
      onScrollEndTarget,
    }: {
      scrollRest?: ScrollRest;
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
      scrollRest,
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
    expect(onScrollEnd).toHaveBeenCalledTimes(1);
    expect(onScrollEnd).toHaveBeenCalledWith(-20);
    expect(isScrolling.value).toBe(false);
  });

  it("reports a fling that rests inside the bounds where it rests", () => {
    const { onScrollEnd, decay, settle } = fling([-80, 600]);
    expect(settle(decay, -30)).toBe(-30);
    expect(onScrollEnd).toHaveBeenCalledTimes(1);
    expect(onScrollEnd).toHaveBeenCalledWith(-30);
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
    // A 300 px plot whose x values are its scroll offsets plus `shift`, which a remeasure changes. Bars are 40 px wide.
    function scrollRestFor(
      geometry = { shift: 0 },
      snap = (rightEdgeX: number) => Math.round(rightEdgeX / 40) * 40,
    ): ScrollRest {
      return {
        rightEdgeXAt: (scroll) => scroll + geometry.shift,
        scrollAt: (rightEdgeX) => rightEdgeX - geometry.shift,
        visibleXDomainAt: (scroll) => [
          scroll + geometry.shift - 300,
          scroll + geometry.shift,
        ],
        snap,
      };
    }
    // Runs a deceleration frame by frame from `from`, as Reanimated does, with `beforeFrame` run ahead of each.
    function runToRest(
      animation: Animation,
      from: number,
      beforeFrame?: (now: number) => void,
    ) {
      animation.onStart?.(animation, from, 0);
      for (let now = 0; now <= 10_000; now += 16) {
        beforeFrame?.(now);
        if (animation.onFrame?.(animation, now)) {
          return { restingScroll: animation.current, restedAtMs: now };
        }
      }
      throw new Error("The scroll did not come to rest");
    }

    it("decelerates a fling onto the bar edge nearest where its momentum would stop", () => {
      const { onScrollEnd, decay, settle } = fling([-80, 600], {
        velocityX: 300,
        scrollRest: scrollRestFor(),
      });

      // Momentum alone would stop at about 75 px.
      const { restingScroll } = runToRest(decay, 0);
      expect(restingScroll).toBe(80);
      settle(decay, 80);
      expect(onScrollEnd).toHaveBeenCalledWith(80);
    });

    it("reports where a fling will rest, as x values, when the finger lifts", () => {
      const onScrollEndTarget = vi.fn();
      const { onScrollEnd } = fling([-80, 600], {
        velocityX: 300,
        scrollRest: scrollRestFor(),
        onScrollEndTarget,
      });

      expect(onScrollEndTarget).toHaveBeenCalledTimes(1);
      expect(onScrollEndTarget).toHaveBeenCalledWith([-220, 80]);
      expect(onScrollEnd).not.toHaveBeenCalled();
    });

    it("keeps the x value it picked when the chart remeasures as it settles, before or after the report arrives", () => {
      const geometry = { shift: 0 };
      const onScrollEndTarget = vi.fn();
      jsQueue.calls = [];
      try {
        const { decay } = fling([-80, 600], {
          velocityX: 300,
          scrollRest: scrollRestFor(geometry),
          onScrollEndTarget,
        });
        // The chart remeasures before the JS thread runs the report, then again as the scroll settles.
        geometry.shift = 7;
        for (const call of jsQueue.calls) call();
        const { restingScroll } = runToRest(decay, 0, (now) => {
          if (now === 160) geometry.shift = 12;
        });

        expect(onScrollEndTarget).toHaveBeenCalledWith([-220, 80]);
        // Still x = 80 at the plot's right edge.
        expect(restingScroll).toBe(68);
      } finally {
        jsQueue.calls = null;
      }
    });

    it("rests a fling past a scroll limit on the last whole bar it can reach, reported once", () => {
      const onScrollEndTarget = vi.fn();
      const { decay } = fling([-80, 95], {
        velocityX: 1000,
        scrollRest: scrollRestFor(),
        onScrollEndTarget,
      });

      expect(onScrollEndTarget.mock.calls).toEqual([[[-220, 80]]]);
      expect(runToRest(decay, 0).restingScroll).toBe(80);
    });

    it("springs a drag released past a scroll limit back to the last whole bar, reported once", () => {
      const onScrollEndTarget = vi.fn();
      const { onScrollEnd, release, settle } = scrollChart([-80, 95], {
        scrollRest: scrollRestFor(),
        onScrollEndTarget,
      });

      const springBack = release({ translationX: 130, velocityX: 0 });

      expect(springBack.toValue).toBe(80);
      expect(onScrollEndTarget.mock.calls).toEqual([[[-220, 80]]]);
      settle(springBack, 80);
      expect(onScrollEnd).toHaveBeenCalledWith(80);
    });

    it("drops the momentum and reports nothing at release when the system cancels the pan", () => {
      const onScrollEndTarget = vi.fn();
      const { release } = scrollChart([-80, 600], {
        scrollRest: scrollRestFor(),
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
        scrollRest: scrollRestFor(undefined, (x) => Math.round(x / 5) * 5),
      });

      decay.onStart?.(decay, 0, 0);
      decay.onFrame?.(decay, 0);
      decay.onFrame?.(decay, 1);
      const initialSpeed = (decay.current ?? 0) * 1000;

      // Momentum alone would carry it about 500 px.
      expect(initialSpeed).toBeGreaterThan(2000 * 0.9);
      expect(initialSpeed).toBeLessThan(2000 * 1.2);
      expect(runToRest(decay, 0).restingScroll).toBe(25);
    });

    it("decelerates as a higher-order animation, which Reduce Motion doesn't skip", () => {
      // Momentum is the finger's own motion, as in a UIScrollView. Reanimated jumps only plain animations to their end.
      const { decay } = fling([-80, 600], {
        velocityX: 300,
        scrollRest: scrollRestFor(),
      });

      expect(decay.isHigherOrder).toBe(true);
    });

    it("brings a fast fling to rest within a second and a half", () => {
      const { decay } = fling([-2000, 2000], {
        velocityX: 2000,
        scrollRest: scrollRestFor(),
      });

      expect(runToRest(decay, 0).restedAtMs).toBeLessThan(1500);
    });

    it("keeps where it rests inside the bounds", () => {
      const { decay } = fling([-80, 600], {
        velocityX: 5000,
        scrollRest: scrollRestFor(),
      });

      expect(runToRest(decay, 0).restingScroll).toBe(600);
    });

    it("flings without a resting place while the chart can't place one, then rests on a bar once it can", () => {
      // An unmeasured chart, or one whose data is briefly empty, has no x values to rest on.
      const geometry = { shift: Number.NaN };
      const onScrollEndTarget = vi.fn();
      const { release, settle } = scrollChart([-80, 600], {
        scrollRest: scrollRestFor(geometry),
        onScrollEndTarget,
      });

      const decay = release({ velocityX: 300 });
      expect(decay.config?.clamp).toEqual([-80, 600]);
      expect(onScrollEndTarget).not.toHaveBeenCalled();
      settle(decay, 0);

      geometry.shift = 0;
      const deceleration = release({ velocityX: 300 });
      expect(runToRest(deceleration, 0).restingScroll).toBe(80);
      expect(onScrollEndTarget).toHaveBeenCalledWith([-220, 80]);
    });
  });
});
