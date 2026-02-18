import React from "react";
import {
  Drawer,
  Box,
  Typography,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Divider,
} from "@mui/material";
import { NavLink } from "react-router-dom";

import DashboardRoundedIcon from "@mui/icons-material/DashboardRounded";
import AutoGraphRoundedIcon from "@mui/icons-material/AutoGraphRounded";
import BuildRoundedIcon from "@mui/icons-material/BuildRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";

export const drawerWidth = 260;

const navItems = [
  {
    label: "Dashboard",
    to: "/",
    icon: <DashboardRoundedIcon fontSize="small" />,
  },
  {
    label: "Strategy",
    to: "/strategy",
    icon: <AutoGraphRoundedIcon fontSize="small" />,
  },
  {
    label: "Utility",
    to: "/utility",
    icon: <BuildRoundedIcon fontSize="small" />,
  },
  {
    label: "Settings",
    to: "/settings",
    icon: <SettingsRoundedIcon fontSize="small" />,
  },
];

export default function Sidebar() {
  return (
    <Drawer
      variant="permanent"
      sx={{
        width: drawerWidth,
        flexShrink: 0,
        "& .MuiDrawer-paper": {
          width: drawerWidth,
          boxSizing: "border-box",
          borderRight: "1px solid rgba(255,255,255,0.08)",
          background: "linear-gradient(180deg, #0b1220 0%, #0b1630 100%)",
          color: "#e2e8f0",
        },
      }}
    >
      {/* Brand */}
      <Box
        sx={{
          px: 2.5,
          py: 2.2,
          display: "flex",
          alignItems: "center",
          gap: 1.2,
        }}
      >
        <Box
          sx={{
            width: 34,
            height: 34,
            borderRadius: 2,
            bgcolor: "rgba(47, 111, 237, 0.15)",
            display: "grid",
            placeItems: "center",
            border: "1px solid rgba(47, 111, 237, 0.35)",
          }}
        >
          <Typography sx={{ fontWeight: 900, color: "#93c5fd" }}>MT</Typography>
        </Box>
        <Box>
          <Typography sx={{ fontWeight: 900, lineHeight: 1 }}>
            Trader
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: "rgba(226,232,240,0.65)" }}
          >
            Liquidity System
          </Typography>
        </Box>
      </Box>

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)" }} />

      <Box sx={{ px: 2.5, pt: 2, pb: 1 }}>
        <Typography
          variant="caption"
          sx={{ color: "rgba(226,232,240,0.55)", fontWeight: 800 }}
        >
          NAVIGATION
        </Typography>
      </Box>

      <List sx={{ px: 1.5 }}>
        {navItems.map((item) => (
          <ListItemButton
            key={item.to}
            component={NavLink}
            to={item.to}
            sx={{
              borderRadius: 2,
              mb: 0.5,
              color: "rgba(226,232,240,0.85)",
              "& .MuiListItemIcon-root": {
                color: "rgba(226,232,240,0.75)",
                minWidth: 36,
              },
              "&:hover": { backgroundColor: "rgba(148,163,184,0.12)" },
              "&.active": {
                backgroundColor: "rgba(47, 111, 237, 0.18)",
                border: "1px solid rgba(47, 111, 237, 0.35)",
                "& .MuiListItemIcon-root": { color: "#93c5fd" },
              },
            }}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText
              primary={item.label}
              primaryTypographyProps={{ fontWeight: 800 }}
            />
          </ListItemButton>
        ))}
      </List>
    </Drawer>
  );
}
