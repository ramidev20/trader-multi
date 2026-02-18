import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    background: {
      default: "#f5f7fb", // light admin background
      paper: "#ffffff",
    },
    primary: {
      main: "#2f6fed", // clean blue
    },
    secondary: {
      main: "#22c55e",
    },
    text: {
      primary: "#0f172a", // slate-900
      secondary: "#64748b", // slate-500
    },
    divider: "rgba(15, 23, 42, 0.08)",
  },
  typography: {
    fontFamily: `"Inter", system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`,
    h5: { fontWeight: 900, letterSpacing: -0.3 },
    subtitle1: { fontWeight: 800 },
    button: { fontWeight: 700, textTransform: "none" },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: "#f5f7fb",
        },
      },
    },

    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 14,
          border: "1px solid rgba(15, 23, 42, 0.06)",
          boxShadow: "0 6px 20px rgba(15, 23, 42, 0.06)",
        },
      },
    },

    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },

    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          paddingInline: 14,
          height: 40,
        },
      },
    },

    MuiTextField: {
      defaultProps: {
        size: "small",
      },
    },

    MuiInputBase: {
      styleOverrides: {
        root: {
          borderRadius: 10,
        },
      },
    },

    MuiTableCell: {
      styleOverrides: {
        head: {
          fontWeight: 800,
          color: "#0f172a",
          backgroundColor: "rgba(15, 23, 42, 0.02)",
        },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontWeight: 600,
        },
        label: {
          fontVariantNumeric: "tabular-nums", // ✅ stops digit-width jitter
        },
      },
    },
  },
});
