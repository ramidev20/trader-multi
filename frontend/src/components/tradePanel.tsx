import React, { useMemo, useState } from "react";
import {
  Box,
  Card,
  Typography,
  Tabs,
  Tab,
  Divider,
  Stack,
  TextField,
  Button,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Chip,
} from "@mui/material";
import { useTradingStore } from "../store/tradingStore";

function a11yProps(index: number) {
  return {
    id: `trade-tab-${index}`,
    "aria-controls": `trade-tabpanel-${index}`,
  };
}

import { api } from "../api/client"; // at top of file

function TabPanel(props: {
  value: number;
  index: number;
  children: React.ReactNode;
}) {
  const { value, index, children } = props;
  if (value !== index) return null;
  return <Box sx={{ pt: 2 }}>{children}</Box>;
}

// ----- Manual Order (your current panel, compact) -----
function ManualOrder() {
  const isLoggedIn = useTradingStore((s) => s.isLoggedIn);

  const [lot, setLot] = useState("0.10");
  const [tp, setTp] = useState("50");
  const [sl, setSl] = useState("50");

  const disabled = !isLoggedIn;

  // inside ManualOrder component:
  const addLog = useTradingStore((s) => s.addLog);

  async function place(side: "BUY" | "SELL") {
    try {
      const res = await api.post("/trade/open", {
        type: side,
        lot: Number(lot),
        tp: Number(tp),
        sl: Number(sl),
      });

      addLog?.(`Order ${side} sent: ${JSON.stringify(res.data)}`);
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || "Order failed";
      addLog?.(`Order error: ${msg}`);
      console.error(msg);
    }
  }

  return (
    <Stack spacing={1.5}>
      {!isLoggedIn && (
        <Chip
          label="Login required to trade"
          variant="outlined"
          sx={{ alignSelf: "flex-start" }}
        />
      )}

      <TextField
        size="small"
        label="Lot"
        value={lot}
        onChange={(e) => setLot(e.target.value)}
        inputProps={{ inputMode: "decimal" }}
        disabled={disabled}
      />
      <TextField
        size="small"
        label="Take Profit (pips)"
        value={tp}
        onChange={(e) => setTp(e.target.value)}
        inputProps={{ inputMode: "numeric" }}
        disabled={disabled}
      />
      <TextField
        size="small"
        label="Stop Loss (pips)"
        value={sl}
        onChange={(e) => setSl(e.target.value)}
        inputProps={{ inputMode: "numeric" }}
        disabled={disabled}
      />

      <Stack direction="row" spacing={1}>
        <Button
          fullWidth
          variant="contained"
          color="success"
          disabled={disabled}
          onClick={() => place("BUY")}
        >
          BUY
        </Button>

        <Button
          fullWidth
          variant="contained"
          color="error"
          disabled={disabled}
          onClick={() => place("SELL")}
        >
          SELL
        </Button>
      </Stack>

      <Typography variant="caption" color="text.secondary">
        Tip: we can add “Market/Limit/Stop” later just like MT5.
      </Typography>
    </Stack>
  );
}

// ----- Open Positions (UI now, hook API later) -----
function OpenPositions() {
  // Replace with real data later from /api/trade/positions
  const rows: any[] = [];

  return (
    <Box>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Symbol</TableCell>
            <TableCell>Side</TableCell>
            <TableCell>Vol</TableCell>
            <TableCell align="right">P/L</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} sx={{ color: "text.secondary" }}>
                No open positions.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.symbol}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={r.side}
                    color={r.side === "BUY" ? "success" : "error"}
                    variant="outlined"
                  />
                </TableCell>
                <TableCell>{r.volume}</TableCell>
                <TableCell align="right">{r.profit}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Box>
  );
}

// ----- History (UI now, hook API later) -----
function TradeHistory() {
  // Replace with real data later from /api/trade/history
  const rows: any[] = [];

  return (
    <Box>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Time</TableCell>
            <TableCell>Symbol</TableCell>
            <TableCell align="right">Result</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} sx={{ color: "text.secondary" }}>
                No history yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.time}</TableCell>
                <TableCell>{r.symbol}</TableCell>
                <TableCell align="right">{r.result}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Box>
  );
}

export default function TradeDock() {
  const [tab, setTab] = useState(0);

  return (
    <Card
      sx={{
        height: "100%",
        borderRadius: 3,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Box sx={{ px: 2, pt: 1.5 }}>
        <Typography sx={{ fontWeight: 900, lineHeight: 1.1 }}>Trade</Typography>
        <Typography variant="caption" color="text.secondary">
          Orders • Positions • History
        </Typography>
      </Box>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="fullWidth"
        sx={{ px: 1, mt: 1 }}
      >
        <Tab label="Order" {...a11yProps(0)} />
        <Tab label="Positions" {...a11yProps(1)} />
        <Tab label="History" {...a11yProps(2)} />
      </Tabs>

      <Divider />

      {/* Scrollable content area */}
      <Box sx={{ flex: 1, overflow: "auto", px: 2, pb: 2 }}>
        <TabPanel value={tab} index={0}>
          <ManualOrder />
        </TabPanel>
        <TabPanel value={tab} index={1}>
          <OpenPositions />
        </TabPanel>
        <TabPanel value={tab} index={2}>
          <TradeHistory />
        </TabPanel>
      </Box>
    </Card>
  );
}
