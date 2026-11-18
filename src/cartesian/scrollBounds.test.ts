import { describe, it, expect, vi } from "vitest";
import type { SharedValue } from "react-native-reanimated";
import {
  getContractedScroll,
  getScrollBounds,
  scrollTransformGesture,
} from "./utils/transformGestures";

type Animation = {
  config?: {
    clamp?: [number, number];
    duration?: number;
    easing?: (progress: number) => number;
    reduceMotion?: string;
  };
  toValue?: number;
  callback: (finished: boolean) => void;
};
type PanHandlers = {
  onStart: () => void;
  onUpdate: (event: { translationX: number }) => void;
  onEnd: (event: { velocityX: number }) => void;
};

const panHandlers = vi.hoisted(() => ({}) as PanHandlers);

// Animations are records whose completion the test calls, as Reanimated does when one ends or is cancelled.
vi.mock("react-native-reanimated", () => ({
  ReduceMotion: { Never: "never" },
  useSharedValue: (value: unknown) => ({ value }),
  cancelAnimation: () => {},
  runOnJS: (fn: (...args: unknown[]) => void) => fn,
  withDecay: (
    config: { clamp: [number, number] },
    callback: (finished: boolean) => void,
  ): Animation => ({ config, callback }),
  withSpring: (
    toValue: number,
    _config: unknown,
    callback: (finished: boolean) => void,
  ): Animation => ({ toValue, callback }),
  withTiming: (
    toValue: number,
    config: Animation["config"],
    callback: (finished: boolean) => void,
  ): Animation => ({ toValue, config, callback }),
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
  function fling(
    bounds: [number, number],
    {
      velocityX = -2000,
      snapScroll,
      onScrollEndTarget,
    }: {
      velocityX?: number;
      snapScroll?: (scrollX: number) => number;
      onScrollEndTarget?: (scrollX: number) => void;
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
      snapScroll,
      scrollBounds: scrollBounds as SharedValue<[number, number]>,
      isScrolling: isScrolling as SharedValue<boolean>,
    });
    panHandlers.onStart();
    panHandlers.onUpdate({ translationX: 0 });
    panHandlers.onEnd({ velocityX });
    const decay = scrollX.value as Animation;
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
    return { scrollBounds, isScrolling, onScrollEnd, decay, settle };
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

  describe("with a snap", () => {
    // Rests on multiples of 40 px, such as whole 40 px bars.
    const snapScroll = (scrollX: number) => Math.round(scrollX / 40) * 40;

    it("decelerates a fling onto the snapped rest nearest where its momentum would stop", () => {
      const { onScrollEnd, decay, settle } = fling([-80, 600], {
        velocityX: 300,
        snapScroll,
      });

      // Momentum alone would stop at about 75 px.
      expect(decay.toValue).toBe(80);
      expect(decay.config?.easing?.(0)).toBe(0);
      expect(decay.config?.easing?.(1)).toBeCloseTo(1);
      expect(decay.config?.duration).toBeGreaterThan(0);
      settle(decay, 80);
      expect(onScrollEnd).toHaveBeenCalledWith(80);
    });

    it("reports where a fling will rest as the finger lifts, before it gets there", () => {
      const onScrollEndTarget = vi.fn();
      const { onScrollEnd } = fling([-80, 600], {
        velocityX: 300,
        snapScroll,
        onScrollEndTarget,
      });

      expect(onScrollEndTarget).toHaveBeenCalledWith(80);
      expect(onScrollEnd).not.toHaveBeenCalled();
    });

    it("decelerates with Reduce Motion on, rather than jumping to where it rests", () => {
      // Momentum is the finger's own motion, as in a UIScrollView.
      const { decay } = fling([-80, 600], { velocityX: 300, snapScroll });

      expect(decay.config?.reduceMotion).toBe("never");
    });

    it("brings a fast fling to rest within a second and a half", () => {
      const { decay } = fling([-2000, 2000], { velocityX: 2000, snapScroll });

      expect(decay.config?.duration).toBeLessThan(1500);
    });

    it("keeps the snapped rest inside the bounds", () => {
      const { decay } = fling([-80, 600], { velocityX: 5000, snapScroll });

      expect(decay.toValue).toBe(600);
    });
  });
});
