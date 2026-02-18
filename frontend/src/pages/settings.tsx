import React, { useEffect, useState } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  TextField,
  Divider,
  Stack,
  Button,
  Switch,
  FormControlLabel,
  Chip,
} from "@mui/material";

type SettingsState = {
  defaultSymbol: string;
  defaultTimeframe: string; // "M1"|"M5"|...
  apiBaseUrl: string;
  enableSounds: boolean;
};

const KEY = "app_settings_v1";

function loadSettings(): SettingsState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    defaultSymbol: "XAUUSD",
    defaultTimeframe: "M5",
    apiBaseUrl: "http://localhost:8000",
    enableSounds: false,
  };
}

function saveSettings(s: SettingsState) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export default function SettingsPage() {
  const [form, setForm] = useState<SettingsState>(loadSettings());
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setForm(loadSettings());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function onSave() {
    saveSettings(form);
    setSavedAt(Date.now());
  }

  function onReset() {
    const fresh = loadSettings();
    setForm(fresh);
    saveSettings(fresh);
    setSavedAt(Date.now());
  }

  return (
    <Box sx={{ width: "100%", maxWidth: "none", mx: 0, px: { xs: 1.5, sm: 2.5, md: 3 } }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
        gap={1.5}
        sx={{ mb: 2 }}
      >
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 900 }}>
            Settings
          </Typography>
          <Typography variant="body2" color="text.secondary">
            App defaults and preferences.
          </Typography>
        </Box>

        <Stack direction="row" gap={1} alignItems="center">
          {savedAt ? (
            <Chip size="small" color="success" label="Saved" />
          ) : (
            <Chip size="small" variant="outlined" label="Not saved" />
          )}
          <Button variant="contained" onClick={onSave}>
            Save
          </Button>
          <Button variant="outlined" onClick={onReset}>
            Reset
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={2}>
        <Grid item xs={12} lg={7}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 900, mb: 1 }}>
                Defaults
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Default Symbol"
                    value={form.defaultSymbol}
                    onChange={(e) => setForm((s) => ({ ...s, defaultSymbol: e.target.value }))}
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Default Timeframe"
                    value={form.defaultTimeframe}
                    onChange={(e) => setForm((s) => ({ ...s, defaultTimeframe: e.target.value }))}
                    helperText='Example: "M1", "M5", "M15", "H1"'
                  />
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} lg={5}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 900, mb: 1 }}>
                Connectivity & UI
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Stack gap={2}>
                <TextField
                  fullWidth
                  label="API Base URL"
                  value={form.apiBaseUrl}
                  onChange={(e) => setForm((s) => ({ ...s, apiBaseUrl: e.target.value }))}
                  helperText="Optional: if you later want dynamic baseURL."
                />

                <FormControlLabel
                  control={
                    <Switch
                      checked={form.enableSounds}
                      onChange={(e) => setForm((s) => ({ ...s, enableSounds: e.target.checked }))}
                    />
                  }
                  label="Enable Sounds"
                />
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
