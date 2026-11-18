import * as React from "react";
import { type ComposedGesture } from "react-native-gesture-handler";
import type { MutableRefObject } from "react";
import type { ScaleLinear } from "d3-scale";
import type { AxisProps, CartesianChartRenderArg, InputFields, NumericalFields, SidedNumber, ChartBounds, YAxisInputProps, XAxisInputProps, FrameInputProps, ChartPressPanConfig, Viewport, ValueOf } from "../types";
import type { ChartPressState, ChartPressStateInit } from "./hooks/useChartPressState";
import type { ChartTransformState } from "./hooks/useChartTransformState";
import { type PanTransformGestureConfig, type PinchTransformGestureConfig } from "./utils/transformGestures";
export type CartesianActionsHandle<T = undefined> = T extends ChartPressState<infer S> ? S extends ChartPressStateInit ? {
    handleTouch: (v: T, x: number, y: number) => void;
} : never : never;
export type ScrollToRef = {
    scrollTo: (x: number) => void;
    getScrollX: () => number;
} | null;
type CartesianChartProps<RawData extends Record<string, unknown>, XK extends keyof InputFields<RawData>, YK extends keyof NumericalFields<RawData>> = {
    data: RawData[];
    xKey: XK;
    yKeys: YK[];
    padding?: SidedNumber;
    domainPadding?: SidedNumber;
    domain?: {
        x?: [number] | [number, number];
        y?: [number] | [number, number];
    };
    viewport?: Viewport;
    chartPressState?: ChartPressState<{
        x: InputFields<RawData>[XK];
        y: Record<YK, number>;
    }> | ChartPressState<{
        x: InputFields<RawData>[XK];
        y: Record<YK, number>;
    }>[];
    chartPressConfig?: {
        pan?: ChartPressPanConfig;
    };
    children: (args: CartesianChartRenderArg<RawData, YK>) => React.ReactNode;
    renderOutside?: (args: CartesianChartRenderArg<RawData, YK>) => React.ReactNode;
    axisOptions?: Partial<Omit<AxisProps<RawData, XK, YK>, "xScale" | "yScale">>;
    onChartBoundsChange?: (bounds: ChartBounds) => void;
    onScaleChange?: (xScale: ScaleLinear<number, number>, yScale: ScaleLinear<number, number>) => void;
    /**
     * @deprecated This prop will eventually be replaced by the new `chartPressConfig`. For now it's being kept around for backwards compatibility sake.
     */
    gestureLongPressDelay?: number;
    xAxis?: XAxisInputProps<RawData, XK>;
    yAxis?: YAxisInputProps<RawData, YK>[];
    frame?: FrameInputProps;
    transformState?: ChartTransformState;
    transformConfig?: {
        pan?: PanTransformGestureConfig;
        pinch?: PinchTransformGestureConfig;
    };
    customGestures?: ComposedGesture;
    onScroll?: (data: any) => void;
    /**
     * Called once when a user scroll comes to rest, with the x values at the plot's left and right edges. Not called
     * for `scrollTo`/`scrollToEnd`, or for a scroll whose fling another scroll interrupts. A scroll reports to the
     * `onScrollEnd` passed when its finger lifted, so a caller can tell a report from before a later change.
     */
    onScrollEnd?: (visibleXDomain: [number, number]) => void;
    /**
     * Called when a released drag or fling starts settling onto `snapScrollEnd`'s rest, with the x values at the plot's
     * edges there, worked out at release: what `onScrollEnd` will report, before the scroll gets there. A new drag can
     * stop it short, and then `onScrollEnd` doesn't report. Not called for a pan the system cancels.
     */
    onScrollEndTarget?: (visibleXDomain: [number, number]) => void;
    /**
     * Where a user scroll comes to rest, as a worklet: given the x value at the plot's right edge where a released drag
     * or fling would stop, inside the scroll limits, the x value to stop at instead, such as the edge of a whole bar. The
     * scroll decelerates onto it, keeping a fling's momentum, or springs back to it from past a limit, and rests on it
     * if the chart remeasures meanwhile.
     */
    snapScrollEnd?: (rightEdgeX: number) => number;
    scrollState?: boolean;
    actionsRef?: MutableRefObject<CartesianActionsHandle<ChartPressState<{
        x: InputFields<RawData>[XK];
        y: Record<YK, number>;
    }> | undefined> | null>;
    onVisibleTicksChange?: (visibleTickData: Array<ValueOf<RawData[any]>>) => void;
    scrollControllerRef?: MutableRefObject<ScrollToRef>;
    maxScrollOffset?: number;
};
export declare function CartesianChartScroll<RawData extends Record<string, unknown>, XK extends keyof InputFields<RawData>, YK extends keyof NumericalFields<RawData>>({ transformState, children, ...rest }: CartesianChartProps<RawData, XK, YK>): React.JSX.Element;
export {};
