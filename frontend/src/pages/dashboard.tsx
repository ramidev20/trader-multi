import { Box, Card } from "@mui/material";
import ChartPanel from "../components/chartpanel";
import TradeDock from "../components/tradePanel";
import TerminalPanel from "../components/footerPanel";

const DOCK_W = 380;
const TERMINAL_H = 280; // adjust

export default function Dashboard() {
  return (
    <Box
      sx={{
        height: "100%", // ✅ AppLayout already gives a viewport with overflow hidden
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: { xs: "1fr", lg: `1fr ${DOCK_W}px` },
        gridTemplateRows: { xs: "1fr auto", lg: `1fr ${TERMINAL_H}px` },
        gap: 2,
        p: 2, // ✅ page-level padding (since we removed it globally)
        boxSizing: "border-box",
      }}
    >
      {/* Chart */}
      <Card
        sx={{
          borderRadius: 3,
          overflow: "hidden",
          minWidth: 0,
          minHeight: 0,
          display: "flex",
        }}
      >
        <ChartPanel />
      </Card>

      {/* Trade dock */}
      <Box sx={{ minWidth: 0, minHeight: 0 }}>
        <TradeDock />
      </Box>

      {/* Terminal (spans full width) */}
      <Card
        sx={{
          gridColumn: { xs: "1 / -1", lg: "1 / -1" },
          borderRadius: 3,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <TerminalPanel />
      </Card>
    </Box>
  );
}
