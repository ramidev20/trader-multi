import React, { useEffect, useMemo, useState } from "react";
import {
  AppBar,
  Toolbar,
  Box,
  Typography,
  Chip,
  IconButton,
  Avatar,
  Menu,
  MenuItem,
  Divider,
  TextField,
  InputAdornment,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Stack,
  Checkbox,
  FormControlLabel,
} from "@mui/material";

import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import AccountCircleOutlinedIcon from "@mui/icons-material/AccountCircleOutlined";
import LoginRoundedIcon from "@mui/icons-material/LoginRounded";

import { drawerWidth } from "./sideBar";
import { useTradingStore } from "../store/tradingStore";
import { api } from "../api/client";

import {
  loadAccounts,
  saveAccounts,
  loadSettings,
  saveSettings,
  makeAccountId,
  type SavedAccount,
} from "../store/prefs";

function formatNum(v: number, digits = 2) {
  if (!Number.isFinite(v)) return "--";
  return v.toFixed(digits);
}

export default function Topbar() {
  const { equity, bid, ask, isLoggedIn, account, setLoggedIn, setAccount } =
    useTradingStore() as any;

  // menu
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(anchorEl);

  // settings dialog
  const [settingsOpen, setSettingsOpen] = useState(false);

  // saved accounts + settings (global path)
  const [accounts, setAccounts] = useState<SavedAccount[]>(() =>
    loadAccounts(),
  );
  const [terminalPath, setTerminalPath] = useState(
    () => loadSettings().terminalPath,
  );
  const [selectedAccountId, setSelectedAccountId] = useState(
    () => loadSettings().lastAccountId || "",
  );

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId),
    [accounts, selectedAccountId],
  );
  const hasSavedAccount = !!selectedAccount;
  const savedHasPassword = !!selectedAccount?.password;

  // login dialog
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);

  // creds
  const [accountName, setAccountName] = useState("");
  const [saveThisAccount, setSaveThisAccount] = useState(true);
  const [savePassword, setSavePassword] = useState(false);

  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("");

  // When selecting a saved account, fill fields (including password if stored)
  useEffect(() => {
    if (!selectedAccount) return;

    setAccountName(selectedAccount.name);
    setLogin(selectedAccount.login);
    setServer(selectedAccount.server);
    setPassword(selectedAccount.password ?? ""); // if not stored, user will type it
    setLoginErr(null);
  }, [selectedAccount]);

  const spread = useMemo(() => {
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
    return ask - bid;
  }, [bid, ask]);

  async function refreshAccount() {
    try {
      const res = await api.get("/account/info");
      setLoggedIn(true);
      setAccount(res.data);
    } catch {
      setLoggedIn(false);
      setAccount(null);
    }
  }

  async function doLogin() {
    setLoginBusy(true);
    setLoginErr(null);

    try {
      if (!terminalPath?.trim()) {
        setLoginErr(
          "Terminal Path is empty. Open Settings and set the MT5 terminal path.",
        );
        return;
      }

      if (!login?.trim() || !server?.trim()) {
        setLoginErr("Login and Server are required.");
        return;
      }

      // If we selected a saved account without saved password, require password input
      if (hasSavedAccount && !savedHasPassword && !password) {
        setLoginErr(
          "This saved account has no stored password. Please enter the password.",
        );
        return;
      }

      await api.post("/auth/login", {
        login: Number(login),
        password,
        server,
        path: terminalPath, // global setting
      });

      await refreshAccount();

      // remember last selection + path
      const id = makeAccountId(login, server);
      saveSettings({
        terminalPath,
        lastAccountId: id,
      });
      setSelectedAccountId(id);

      // Save/update account only if user wants saving (mainly for manual/new account)
      if (saveThisAccount) {
        setAccounts((prev) => {
          const existing = prev.find((x) => x.id === id);

          const item: SavedAccount = {
            id,
            name: (accountName || `${login} @ ${server}`).trim(),
            login: login.trim(),
            server: server.trim(),
            // If savePassword checked, update stored password.
            // If not checked, keep existing password (so we don't wipe it).
            password: savePassword ? password : existing?.password,
          };

          const next = [item, ...prev.filter((x) => x.id !== id)];
          saveAccounts(next);
          return next;
        });
      }

      setLoginOpen(false);
      setPassword(""); // clear after login (unless selected saved account will fill next time)
      setSavePassword(false);
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        "Login failed. Check credentials/server.";
      setLoginErr(String(msg));
    } finally {
      setLoginBusy(false);
    }
  }

  async function doLogout() {
    try {
      await api.post("/auth/logout");
    } catch {
      // ignore
    } finally {
      await refreshAccount();
      setAnchorEl(null);
    }
  }

  // stable quote chips (no layout shifting)
  const quoteChipSx = {
    width: 128,
    "& .MuiChip-label": {
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      fontVariantNumeric: "tabular-nums",
    },
  } as const;

  return (
    <AppBar
      position="fixed"
      elevation={0}
      sx={{
        ml: `${drawerWidth}px`,
        width: `calc(100% - ${drawerWidth}px)`,
        bgcolor: "background.paper",
        color: "text.primary",
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      <Toolbar sx={{ gap: 2 }}>
        {/* Left */}
        <Box sx={{ minWidth: 220 }}>
          <Typography
            variant="subtitle1"
            sx={{ fontWeight: 900, lineHeight: 1 }}
          >
            Trading Console
          </Typography>

          <Chip
            sx={{ mt: 1 }}
            size="small"
            label={isLoggedIn ? "Connected" : "Not logged in"}
            color={isLoggedIn ? "success" : "default"}
            variant={isLoggedIn ? "filled" : "outlined"}
          />
        </Box>

        {/* Search */}
        <Box
          sx={{ flex: 1, maxWidth: 520, display: { xs: "none", md: "block" } }}
        >
          <TextField
            fullWidth
            placeholder="Search…"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRoundedIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
        </Box>

        {/* Chips */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            flexWrap: "nowrap",
          }}
        >
          <Chip
            sx={quoteChipSx}
            variant="outlined"
            label={
              <span>
                <span>Bid </span>
                <span>{formatNum(bid, 2)}</span>
              </span>
            }
          />
          <Chip
            sx={quoteChipSx}
            variant="outlined"
            label={
              <span>
                <span>Ask </span>
                <span>{formatNum(ask, 2)}</span>
              </span>
            }
          />
          <Chip
            sx={quoteChipSx}
            variant="outlined"
            label={
              <span>
                <span>Spr </span>
                <span>{spread == null ? "--" : formatNum(spread, 2)}</span>
              </span>
            }
          />
        </Box>

        <Box sx={{ flexGrow: 1 }} />

        {/* Right actions */}
        <IconButton size="small" onClick={() => setSettingsOpen(true)}>
          <SettingsOutlinedIcon />
        </IconButton>

        {!isLoggedIn ? (
          <Button
            variant="contained"
            startIcon={<LoginRoundedIcon />}
            onClick={() => {
              setLoginErr(null);
              setLoginOpen(true);
            }}
            sx={{ borderRadius: 999 }}
          >
            Login
          </Button>
        ) : (
          <>
            <IconButton
              size="small"
              onClick={(e) => setAnchorEl(e.currentTarget)}
              sx={{ ml: 0.5 }}
            >
              <Avatar sx={{ width: 32, height: 32 }}>
                <AccountCircleOutlinedIcon />
              </Avatar>
            </IconButton>

            <Menu
              anchorEl={anchorEl}
              open={menuOpen}
              onClose={() => setAnchorEl(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
              transformOrigin={{ vertical: "top", horizontal: "right" }}
            >
              <MenuItem disabled>
                <Box>
                  <Typography sx={{ fontWeight: 900 }}>Account</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Balance {formatNum(account?.balance ?? 0, 2)} • Equity{" "}
                    {formatNum(account?.equity ?? equity, 2)}
                  </Typography>
                </Box>
              </MenuItem>
              <Divider />
              <MenuItem onClick={() => setAnchorEl(null)}>
                Risk Settings
              </MenuItem>
              <Divider />
              <MenuItem onClick={doLogout}>
                <LogoutOutlinedIcon
                  fontSize="small"
                  style={{ marginRight: 8 }}
                />
                Logout
              </MenuItem>
            </Menu>
          </>
        )}
      </Toolbar>

      {/* Login dialog */}
      <Dialog
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 900 }}>Login to MT5</DialogTitle>
        <DialogContent>
          <Stack gap={1.5} sx={{ mt: 1 }}>
            {loginErr && <Alert severity="error">{loginErr}</Alert>}

            {/* Saved accounts picker */}
            <TextField
              select
              label="Saved Accounts"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              fullWidth
            >
              <MenuItem value="">(Manual entry)</MenuItem>
              {accounts.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {a.name} — {a.login} @ {a.server}
                </MenuItem>
              ))}
            </TextField>

            {/* If NO saved account selected -> show full inputs */}
            {!hasSavedAccount ? (
              <>
                <TextField
                  label="Account Name"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="e.g. rami demo 1"
                  fullWidth
                />

                <TextField
                  label="Login"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  inputProps={{ inputMode: "numeric" }}
                  fullWidth
                />

                <TextField
                  label="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  fullWidth
                />

                <TextField
                  label="Server"
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  placeholder="Broker-Server"
                  fullWidth
                />

                <FormControlLabel
                  control={
                    <Checkbox
                      checked={saveThisAccount}
                      onChange={(e) => setSaveThisAccount(e.target.checked)}
                    />
                  }
                  label="Save this account"
                />

                <FormControlLabel
                  control={
                    <Checkbox
                      checked={savePassword}
                      onChange={(e) => setSavePassword(e.target.checked)}
                      disabled={!saveThisAccount}
                    />
                  }
                  label="Also save password (not secure)"
                />
              </>
            ) : (
              <>
                {/* Saved account selected: hide inputs.
                    If password not stored, show only password input */}
                {!savedHasPassword && (
                  <TextField
                    label="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    fullWidth
                  />
                )}

                <Typography variant="caption" color="text.secondary">
                  Using saved account: <b>{selectedAccount?.name}</b>
                </Typography>

                {/* Optional: allow updating stored password for saved account */}
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={savePassword}
                      onChange={(e) => setSavePassword(e.target.checked)}
                    />
                  }
                  label="Update saved password (not secure)"
                />
              </>
            )}

            <Typography variant="caption" color="text.secondary">
              Terminal path is configured in Settings.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setLoginOpen(false)} disabled={loginBusy}>
            Cancel
          </Button>
          <Button onClick={doLogin} disabled={loginBusy} variant="contained">
            {loginBusy ? "Logging in…" : "Login"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Settings dialog */}
      <Dialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 900 }}>Settings</DialogTitle>
        <DialogContent>
          <Stack gap={1.5} sx={{ mt: 1 }}>
            <TextField
              label="MT5 Terminal Path"
              value={terminalPath}
              onChange={(e) => setTerminalPath(e.target.value)}
              placeholder="C:\\Program Files\\MetaTrader 5\\terminal64.exe"
              fullWidth
            />

            <Divider />

            <Typography sx={{ fontWeight: 900 }}>Saved Accounts</Typography>

            {accounts.length === 0 ? (
              <Typography color="text.secondary">No saved accounts.</Typography>
            ) : (
              <Stack gap={1}>
                {accounts.map((a) => (
                  <Box
                    key={a.id}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 1,
                      p: 1,
                      border: "1px solid",
                      borderColor: "divider",
                      borderRadius: 2,
                      bgcolor: "background.paper",
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 800 }} noWrap>
                        {a.name}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        noWrap
                      >
                        {a.login} @ {a.server}
                        {a.password ? " • (password saved)" : ""}
                      </Typography>
                    </Box>

                    <Button
                      color="error"
                      variant="outlined"
                      onClick={() => {
                        setAccounts((prev) => {
                          const next = prev.filter((x) => x.id !== a.id);
                          saveAccounts(next);

                          if (selectedAccountId === a.id) {
                            setSelectedAccountId("");
                            const s = loadSettings();
                            saveSettings({ ...s, lastAccountId: "" });
                          }

                          return next;
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </Box>
                ))}
              </Stack>
            )}
          </Stack>
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setSettingsOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              const s = loadSettings();
              saveSettings({
                ...s,
                terminalPath,
                lastAccountId: selectedAccountId || s.lastAccountId,
              });
              setSettingsOpen(false);
            }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </AppBar>
  );
}
