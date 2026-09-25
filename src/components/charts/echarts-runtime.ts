import * as echarts from "echarts/core";
import { BarChart, GraphChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  GraphChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };
