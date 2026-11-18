import React, { memo, useMemo } from "react";
import { StyleSheet } from "react-native";
import {
  createPicture,
  Group,
  Picture,
  Skia,
  type SkFont,
} from "@shopify/react-native-skia";
import {
  isWorkletFunction,
  runOnJS,
  type DerivedValue,
  type SharedValue,
  useDerivedValue,
  useAnimatedReaction,
} from "react-native-reanimated";

import {
  DEFAULT_TICK_COUNT,
  getDrawnRange,
  getFixedTicks,
  getPageTicks,
  getTicksIn,
  type PageTickSource,
} from "../../utils/tickHelpers";
import type {
  ChartBounds,
  GetXTicks,
  InputDatum,
  InputFields,
  ValueOf,
  XAxisProps,
  XAxisPropsWithDefaults,
} from "../../types";

// Simple debounce utility
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}

export const MemoizedXAxis = <
  RawData extends Record<string, unknown>,
  XK extends keyof InputFields<RawData>,
>({
  xScale: xScaleProp,
  yScale,
  axisSide = "bottom",
  labelPosition = "outset",
  tickCount = DEFAULT_TICK_COUNT,
  tickValues,
  labelOffset = 2,
  labelColor = "#000000",
  lineWidth = StyleSheet.hairlineWidth,
  lineColor = "hsla(0, 0%, 0%, 0.25)",
  font,
  formatXLabel = defaultFormatXLabel,
  ix = [],
  isNumericalData,
  chartBounds,
  enableRescaling,
  zoom,
  onVisibleTicksChange,
  secondaryXFont,
  labelXCenter = false,
  scrollXDerived,
  isScrolling,
  getXTicks,
}: XAxisProps<RawData, XK> & {
  scrollX: SharedValue<number>;
  ignoreClip: boolean;
  onVisibleTicksChange?: (visibleTickData: Array<ValueOf<RawData[XK]>>) => void;
  scrollXDerived: SharedValue<number>;
  isScrolling: SharedValue<boolean>;
  getXTicks?: GetXTicks;
}) => {
  const transformX = useDerivedValue(() => {
    "worklet";
    return [{ translateX: scrollXDerived.value }];
  }, [scrollXDerived]);

  const xScale = useMemo(
    () => (zoom ? zoom.rescaleX(xScaleProp) : xScaleProp),
    [zoom, xScaleProp],
  );
  const [y1 = 0, y2 = 0] = yScale.domain();
  const fontSize = font?.getSize() ?? 0;

  // Use tickValues if provided, otherwise generate ticks, ascending. With `getXTicks` the axis asks for them as it
  // scrolls instead.
  const xTicksNormalized = useMemo(
    () =>
      getXTicks
        ? []
        : getFixedTicks(tickValues, tickCount, (count) =>
            (enableRescaling ? xScale : xScaleProp).ticks(count),
          ),
    [getXTicks, tickValues, tickCount, enableRescaling, xScale, xScaleProp],
  );
  // Each tick's x in the scrolling content, which `transformX` moves. Ticks are ascending, so these are too. Typed
  // arrays reach the UI thread in one copy; worklets copy a plain array's numbers one by one, which for thousands of
  // ticks slowed every chart render.
  const tickXs = useMemo(
    () => Float64Array.from(xTicksNormalized, (tick) => xScale(tick)),
    [xTicksNormalized, xScale],
  );
  // What each tick's label formats: the tick, or for non-numerical data the datum at its index.
  const labelValues = useMemo((): ArrayLike<unknown> => {
    if (isNumericalData) return Float64Array.from(xTicksNormalized);
    // The first occurrence of each value.
    const firstIndices = new Map<string, number>();
    ix.forEach((value, index) => {
      if (!firstIndices.has(String(value)))
        firstIndices.set(String(value), index);
    });
    return xTicksNormalized.map(
      (tick) => ix[firstIndices.get(String(tick)) ?? tick],
    );
  }, [isNumericalData, xTicksNormalized, ix]);
  // A worklet formats each label on the UI thread as its tick scrolls into view. Any other formatter can only run on
  // JS, so it formats every fixed tick here, which is fine for the few ticks such charts pass, and labels no generated
  // tick.
  const jsLabels = useMemo(
    () =>
      isWorkletFunction(formatXLabel)
        ? null
        : Array.from(labelValues, (value) => formatXLabel(value as never)),
    [formatXLabel, labelValues],
  );

  const linePaint = useMemo(() => {
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(lineColor));
    paint.setStrokeWidth(lineWidth);
    return paint;
  }, [lineColor, lineWidth]);
  const labelPaint = useMemo(() => {
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(labelColor));
    return paint;
  }, [labelColor]);
  const lineTop = yScale(y2);
  const lineBottom = yScale(y1);
  const labelY = (() => {
    // bottom, outset
    if (axisSide === "bottom" && labelPosition === "outset") {
      return chartBounds.bottom + labelOffset + fontSize;
    }
    // bottom, inset
    if (axisSide === "bottom" && labelPosition === "inset") {
      return yScale(y2) - labelOffset;
    }
    // top, outset
    if (axisSide === "top" && labelPosition === "outset") {
      return yScale(y1) - labelOffset;
    }
    // top, inset
    return yScale(y1) + fontSize + labelOffset;
  })();
  // Below the second label line, for the picture's bounds.
  const axisBottom = labelY + SECOND_LINE_OFFSET + fontSize;

  // The scale is linear: a value's x in the content is xOffset + value * xPerValue.
  const [domainStart = 0, domainEnd = 1] = xScale.domain();
  const [rangeStart = 0, rangeEnd = 1] = xScale.range();
  const xPerValue = (rangeEnd - rangeStart) / (domainEnd - domainStart);
  const xOffset = rangeStart - domainStart * xPerValue;
  const firstValue = Number(ix[0]);
  const lastValue = Number(ix[ix.length - 1]);
  // Memoized, as the worklets below restart when an object they capture changes.
  const source = useMemo(
    (): PageTickSource<unknown> =>
      getXTicks
        ? { getXTicks, xOffset, xPerValue, firstValue, lastValue }
        : { tickXs, values: labelValues },
    [getXTicks, xOffset, xPerValue, firstValue, lastValue, tickXs, labelValues],
  );

  // Drawn on the UI thread from the scroll, so a fling never outruns the axis however busy JS is, and only around the
  // plot (`getDrawnRange`), so the cost doesn't grow with the axis. `drawnFrom` is a number, which notifies only when
  // it changes, so the ticks are found and the picture recorded again only when the scroll crosses into another page.
  const drawnFrom = useDerivedValue(
    () => getDrawnRange(scrollXDerived.value, chartBounds)[0],
  );
  const drawnTo = useDerivedValue(
    () => getDrawnRange(scrollXDerived.value, chartBounds)[1],
  );
  // The page's ticks, which the picture draws and `onVisibleTicksChange` reports from.
  const drawn = useDerivedValue(() => {
    const page = getPageTicks(drawnFrom.value, drawnTo.value, source);
    const labels = jsLabels
      ? jsLabels.slice(page.start, page.start + page.xs.length)
      : page.values.map((value) => formatXLabel(value as never));
    return { ...page, labels };
  });
  useReportVisibleTicks({
    drawn,
    chartBounds,
    scrollXDerived,
    isScrolling,
    labelXCenter,
    onVisibleTicksChange,
  });
  const picture = useDerivedValue(() => {
    const { xs, labels, hasFirst, hasLast } = drawn.value;
    if (xs.length === 0) return createPicture(() => {});

    // Room for the labels either side of the outer ticks.
    const labelRoom = chartBounds.right - chartBounds.left;
    const pictureLeft = xs[0]! - labelRoom;
    const pictureRight = xs[xs.length - 1]! + labelRoom;
    // Without bounds a picture covers only positive x, and older ticks sit far left of 0 in the content.
    const bounds = Skia.XYWHRect(
      pictureLeft,
      0,
      pictureRight - pictureLeft,
      axisBottom,
    );
    return createPicture((canvas) => {
      for (let index = 0; index < xs.length; index++) {
        const x = xs[index]!;
        if (lineWidth > 0) {
          canvas.drawLine(x, lineTop, x, lineBottom, linePaint);
        }
        const label = labels[index];
        if (!font || label === undefined) continue;

        const top = typeof label === "string" ? label : label.top;
        const bottom = typeof label === "string" ? null : label.bottom;
        const topWidth = getTextWidth(font, top);
        if (!topWidth) continue;

        const bottomWidth =
          bottom && secondaryXFont ? getTextWidth(secondaryXFont, bottom) : 0;
        let centerX = x;
        if (labelXCenter) {
          const next = xs[index + 1];
          const previous = xs[index - 1];
          centerX =
            next !== undefined
              ? (x + next) / 2
              : previous !== undefined
                ? x + (x - previous) / 2
                : x;
        }
        // Nudge the first and last labels inward from the content's ends.
        const nudge =
          hasFirst && index === 0
            ? 10
            : hasLast && index === xs.length - 1
              ? -4
              : 0;
        canvas.drawText(
          top,
          centerX - topWidth / 2 + nudge,
          labelY,
          labelPaint,
          font,
        );
        if (bottom) {
          canvas.drawText(
            bottom,
            centerX - bottomWidth / 2 + nudge,
            labelY + SECOND_LINE_OFFSET,
            labelPaint,
            secondaryXFont || font,
          );
        }
      }
    }, bounds);
  });

  return (
    <Group transform={transformX}>
      <Picture picture={picture} />
    </Group>
  );
};

// The second label line's baseline, below the first's.
const SECOND_LINE_OFFSET = 15;

function defaultFormatXLabel(label: ValueOf<InputDatum>) {
  "worklet";
  return String(label);
}

function getTextWidth(font: SkFont, text: string) {
  "worklet";
  return font
    .getGlyphWidths(font.getGlyphIDs(text))
    .reduce((sum, width) => sum + width, 0);
}

/** Reports the ticks in view to `onVisibleTicksChange` while the user scrolls, when they change. */
function useReportVisibleTicks<
  RawData extends Record<string, unknown>,
  XK extends keyof InputFields<RawData>,
  Page extends { xs: number[]; values: unknown[] },
>({
  drawn,
  chartBounds,
  scrollXDerived,
  isScrolling,
  labelXCenter,
  onVisibleTicksChange,
}: {
  drawn: DerivedValue<Page>;
  chartBounds: ChartBounds;
  scrollXDerived: SharedValue<number>;
  isScrolling: SharedValue<boolean>;
  labelXCenter: boolean;
  onVisibleTicksChange?: (visibleTickData: Array<ValueOf<RawData[XK]>>) => void;
}) {
  const report = useMemo(
    () =>
      onVisibleTicksChange &&
      debounce(
        (visible: unknown[]) =>
          onVisibleTicksChange(visible as Array<ValueOf<RawData[XK]>>),
        50,
      ),
    [onVisibleTicksChange],
  );

  useAnimatedReaction(
    () => {
      if (!report) return null;
      const { xs, values } = drawn.value;
      const detectionOffset = labelXCenter ? 30 : 0;
      return getTicksIn(
        xs,
        values,
        chartBounds.left - detectionOffset - scrollXDerived.value,
        chartBounds.right - detectionOffset - scrollXDerived.value,
      );
    },
    (current, previous) => {
      if (
        report &&
        current &&
        isScrolling.value &&
        (previous === null ||
          current.length !== previous.length ||
          current[0] !== previous[0] ||
          current[current.length - 1] !== previous[previous.length - 1])
      ) {
        runOnJS(report)(current);
      }
    },
    [report, drawn, chartBounds, labelXCenter, scrollXDerived, isScrolling],
  );
}

export const XAxis = memo(MemoizedXAxis);

export const XAxisDefaults = {
  lineColor: "hsla(0, 0%, 0%, 0.25)",
  lineWidth: StyleSheet.hairlineWidth,
  tickCount: 5,
  labelOffset: 2,
  axisSide: "bottom",
  yAxisSide: "left",
  labelPosition: "outset",
  // A worklet: a scroll axis with `getXTicks` labels its ticks on the UI thread.
  formatXLabel: (label: ValueOf<InputDatum>) => {
    "worklet";
    return String(label);
  },
  labelColor: "#000000",
  labelRotate: 0,
} satisfies XAxisPropsWithDefaults<never, never>;
