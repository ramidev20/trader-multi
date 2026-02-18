import { useMemo, useState } from "react";
import {
  Box,
  Tabs,
  Tab,
  Typography,
  Divider,
  Stack,
  Chip,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from "@mui/material";
import { useTradingStore } from "../store/tradingStore";

function TabPanel(props: { value: number; index: number; children: any }) {
  const { value, index, children } = props;
  if (value !== index) return null;
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}>{children}</Box>
  );
}

export default function TerminalPanel() {
  const [tab, setTab] = useState(0);
  const logs = useTradingStore((s) => s.logs);
  const isLoggedIn = useTradingStore((s) => s.isLoggedIn);
  const account = useTradingStore((s) => s.account);

  const positions = useTradingStore((s) => s.positions);
  const history = useTradingStore((s) => s.history);
  const liq = useTradingStore((s) => s.liquidity);

  const triggered = useMemo(() => liq.filter((x) => x.triggered), [liq]);
  const pending = useMemo(() => liq.filter((x) => !x.triggered), [liq]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ px: 2 }}
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab label="Journals" />
        <Tab label="Positions" />
        <Tab label="History" />
        <Tab label="Liquidity" />
        <Tab label="Account" />
      </Tabs>

      <Divider />

      {/* Journals */}
      <TabPanel value={tab} index={0}>
        {logs.length === 0 ? (
          <Typography color="text.secondary">No logs yet.</Typography>
        ) : (
          <Box
            component="pre"
            sx={{ m: 0, fontSize: 12, whiteSpace: "pre-wrap" }}
          >
            {logs.slice(-300).join("\n")}
          </Box>
        )}
      </TabPanel>

      {/* Positions */}
      <TabPanel value={tab} index={1}>
        {!isLoggedIn ? (
          <Typography color="text.secondary">
            Login to view positions.
          </Typography>
        ) : positions.length === 0 ? (
          <Typography color="text.secondary">No open positions.</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Ticket</TableCell>
                <TableCell>Symbol</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Vol</TableCell>
                <TableCell>Open</TableCell>
                <TableCell align="right">P/L</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {positions.map((p) => (
                <TableRow key={p.ticket}>
                  <TableCell>{p.ticket}</TableCell>
                  <TableCell>{p.symbol}</TableCell>
                  <TableCell>{p.type}</TableCell>
                  <TableCell>{p.volume}</TableCell>
                  <TableCell>{p.price_open}</TableCell>
                  <TableCell align="right">
                    {Number(p.profit).toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabPanel>

      {/* History */}
      <TabPanel value={tab} index={2}>
        {!isLoggedIn ? (
          <Typography color="text.secondary">Login to view history.</Typography>
        ) : history.length === 0 ? (
          <Typography color="text.secondary">No history found.</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Ticket</TableCell>
                <TableCell>Time</TableCell>
                <TableCell>Symbol</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Vol</TableCell>
                <TableCell align="right">P/L</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {history.slice(0, 200).map((d) => (
                <TableRow key={d.ticket}>
                  <TableCell>{d.ticket}</TableCell>
                  <TableCell>
                    {new Date(d.time * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell>{d.symbol}</TableCell>
                  <TableCell>{d.type}</TableCell>
                  <TableCell>{d.volume}</TableCell>
                  <TableCell align="right">
                    {Number(d.profit).toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabPanel>

      {/* Liquidity */}
      <TabPanel value={tab} index={3}>
        {!isLoggedIn ? (
          <Typography color="text.secondary">
            Login to view liquidity.
          </Typography>
        ) : (
          <Stack gap={2}>
            <Box>
              <Typography sx={{ fontWeight: 800, mb: 1 }}>Pending</Typography>
              {pending.length === 0 ? (
                <Typography color="text.secondary">
                  No pending liquidity.
                </Typography>
              ) : (
                pending.map((x) => (
                  <Chip
                    key={x.id}
                    label={`${x.side.toUpperCase()} @ ${x.price}`}
                    sx={{ mr: 1, mb: 1 }}
                    variant="outlined"
                    color={x.side === "buy" ? "success" : "error"}
                  />
                ))
              )}
            </Box>

            <Box>
              <Typography sx={{ fontWeight: 800, mb: 1 }}>Triggered</Typography>
              {triggered.length === 0 ? (
                <Typography color="text.secondary">
                  No triggered liquidity.
                </Typography>
              ) : (
                triggered.map((x) => (
                  <Chip
                    key={x.id}
                    label={`${x.side.toUpperCase()} @ ${x.price} (TRIGGERED)`}
                    sx={{ mr: 1, mb: 1 }}
                    color="warning"
                  />
                ))
              )}
            </Box>
          </Stack>
        )}
      </TabPanel>

      {/* Account */}
      <TabPanel value={tab} index={4}>
        {!isLoggedIn ? (
          <Typography color="text.secondary">
            Login to view account info.
          </Typography>
        ) : (
          <Stack direction="row" gap={2} flexWrap="wrap">
            <Chip
              label={`Balance: ${Number(account?.balance ?? 0).toFixed(2)}`}
            />
            <Chip
              label={`Equity: ${Number(account?.equity ?? 0).toFixed(2)}`}
            />
            <Chip
              label={`Profit: ${Number(account?.profit ?? 0).toFixed(2)}`}
            />
            <Chip
              label={`Margin: ${Number(account?.margin ?? 0).toFixed(2)}`}
            />
          </Stack>
        )}
      </TabPanel>
    </Box>
  );
}
