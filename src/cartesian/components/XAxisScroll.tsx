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
  type SharedValue,
  useDerivedValue,
  useAnimatedReaction,
} from "react-native-reanimated";

import {
  DEFAULT_TICK_COUNT,
  downsampleTicks,
  getDrawnTickRange,
  getTickRange,
} from "../../utils/tickHelpers";
import type {
  ChartBounds,
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
}: XAxisProps<RawData, XK> & {
  scrollX: SharedValue<number>;
  ignoreClip: boolean;
  onVisibleTicksChange?: (visibleTickData: Array<ValueOf<RawData[XK]>>) => void;
  scrollXDerived: SharedValue<number>;
  isScrolling: SharedValue<boolean>;
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

  // Use tickValues if provided, otherwise generate ticks
  const xTicksNormalized = useMemo(
    () =>
      tickValues
        ? downsampleTicks(tickValues, tickCount)
        : enableRescaling
          ? xScale.ticks(tickCount)
          : xScaleProp.ticks(tickCount),
    [tickValues, tickCount, enableRescaling, xScale, xScaleProp],
  );
  // Each tick's x in the scrolling content, which `transformX` moves. Ticks are ascending, so these are too.
  const tickXs = useMemo(
    () => xTicksNormalized.map((tick) => xScale(tick)),
    [xTicksNormalized, xScale],
  );
  // What each tick's label formats: the tick, or for non-numerical data the datum at its index.
  const labelValues = useMemo(() => {
    if (isNumericalData) return xTicksNormalized;
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
  // JS, so it formats every tick here, which is fine for the few ticks such charts pass.
  const jsLabels = useMemo(
    () =>
      isWorkletFunction(formatXLabel)
        ? null
        : labelValues.map((value) => formatXLabel(value as never)),
    [formatXLabel, labelValues],
  );

  useReportVisibleTicks({
    tickXs,
    labelValues,
    chartBounds,
    scrollXDerived,
    isScrolling,
    labelXCenter,
    onVisibleTicksChange,
  });

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

  // Drawn on the UI thread from the scroll, so a fling never outruns the axis however busy JS is, and only near the
  // plot, so the cost doesn't grow with the axis. Each frame finds the drawn ticks by binary search; the picture is
  // recorded again only when a tick enters or leaves them.
  const drawnStart = useDerivedValue(
    () => getDrawnTickRange(tickXs, scrollXDerived.value, chartBounds)[0],
  );
  const drawnEnd = useDerivedValue(
    () => getDrawnTickRange(tickXs, scrollXDerived.value, chartBounds)[1],
  );
  const picture = useDerivedValue(() => {
    const start = drawnStart.value;
    const end = drawnEnd.value;
    if (start >= end) return createPicture(() => {});

    // Room for the labels either side of the outer ticks.
    const labelRoom = chartBounds.right - chartBounds.left;
    const pictureLeft = tickXs[start]! - labelRoom;
    const pictureRight = tickXs[end - 1]! + labelRoom;
    // Without bounds a picture covers only positive x, and older ticks sit far left of 0 in the content.
    const bounds = Skia.XYWHRect(
      pictureLeft,
      0,
      pictureRight - pictureLeft,
      axisBottom,
    );
    return createPicture((canvas) => {
      for (let index = start; index < end; index++) {
        const x = tickXs[index]!;
        if (lineWidth > 0) {
          canvas.drawLine(x, lineTop, x, lineBottom, linePaint);
        }
        if (!font) continue;

        const label = jsLabels
          ? jsLabels[index]!
          : formatXLabel(labelValues[index] as never);
        const top = typeof label === "string" ? label : label.top;
        const bottom = typeof label === "string" ? null : label.bottom;
        const topWidth = getTextWidth(font, top);
        if (!topWidth) continue;

        const bottomWidth =
          bottom && secondaryXFont ? getTextWidth(secondaryXFont, bottom) : 0;
        let centerX = x;
        if (labelXCenter) {
          const next = tickXs[index + 1];
          const previous = tickXs[index - 1];
          centerX =
            next !== undefined
              ? (x + next) / 2
              : previous !== undefined
                ? x + (x - previous) / 2
                : x;
        }
        // Nudge the first and last labels inward from the content's ends.
        const nudge = index === 0 ? 10 : index === tickXs.length - 1 ? -4 : 0;
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
>({
  tickXs,
  labelValues,
  chartBounds,
  scrollXDerived,
  isScrolling,
  labelXCenter,
  onVisibleTicksChange,
}: {
  tickXs: number[];
  labelValues: unknown[];
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
        (start: number, end: number) =>
          onVisibleTicksChange(
            labelValues.slice(start, end) as Array<ValueOf<RawData[XK]>>,
          ),
        50,
      ),
    [onVisibleTicksChange, labelValues],
  );

  useAnimatedReaction(
    () => {
      if (!report) return null;
      const detectionOffset = labelXCenter ? 30 : 0;
      return getTickRange(
        tickXs,
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
          current[0] !== previous[0] ||
          current[1] !== previous[1])
      ) {
        runOnJS(report)(current[0], current[1]);
      }
    },
    [report, tickXs, chartBounds, labelXCenter, scrollXDerived, isScrolling],
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
  formatXLabel: (label: ValueOf<InputDatum>) => String(label),
  labelColor: "#000000",
  labelRotate: 0,
} satisfies XAxisPropsWithDefaults<never, never>;
