import { useEffect } from "react";
import { createChart } from "lightweight-charts";
import axios from "axios";

export default function Chart() {
  useEffect(() => {
    const chart = createChart(document.getElementById("chart")!, {
      height: 500,
    });

    const series = chart.addCandlestickSeries();

    async function load() {
      const res = await axios.get("/api/chart");
      series.setData(res.data.candles);
    }

    load();
  }, []);

  return <div id="chart"></div>;
}
