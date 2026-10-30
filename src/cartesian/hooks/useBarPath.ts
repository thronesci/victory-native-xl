import * as React from "react";
import { Skia } from "react-native-skia";
import {
  createRoundedRectPath,
  type RoundedCorners,
} from "../../utils/createRoundedRectPath";
import type { ChartBounds, PointsArray } from "../../types";
import { useCartesianChartContext } from "../contexts/CartesianChartContext";
import { useBarWidth } from "./useBarWidth";

export const useBarPath = (
  points: PointsArray,
  chartBounds: ChartBounds,
  innerPadding = 0.2,
  roundedCorners?: RoundedCorners,
  customBarWidth?: number,
  barCount?: number,
) => {
  const { yScale } = useCartesianChartContext();
  const barWidth = useBarWidth({
    points,
    chartBounds,
    innerPadding,
    customBarWidth,
    barCount,
  });

  const path = React.useMemo(() => {
    const builder = Skia.PathBuilder.Make();

    points.forEach(({ x, y, yValue }) => {
      if (typeof y !== "number") return;

      const barHeight = yScale(0) - y;

      if (roundedCorners) {
        const nonUniformRoundedRect = createRoundedRectPath(
          x - barWidth / 2,
          y,
          barWidth,
          barHeight,
          roundedCorners,
          Number(yValue),
        );
        builder.addRRect(nonUniformRoundedRect);
      } else {
        builder.addRect(Skia.XYWHRect(x - barWidth / 2, y, barWidth, barHeight));
      }
    });

    return builder.build();
  }, [barWidth, points, roundedCorners, yScale]);

  return { path, barWidth };
};
