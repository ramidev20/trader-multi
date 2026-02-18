import React, { useEffect } from "react";
import { Box, Toolbar } from "@mui/material";
import { Outlet } from "react-router-dom";
import Sidebar from "./sideBar";
import Topbar from "./topBar";
import { api } from "../api/client";
import { useTradingStore } from "../store/tradingStore";

export default function AppLayout() {
  const setLoggedIn = useTradingStore((s) => s.setLoggedIn);
  const setAccount = useTradingStore((s) => s.setAccount);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get("/account/info");
        setLoggedIn(true);
        setAccount(res.data);
      } catch {
        setLoggedIn(false);
        setAccount(null);
      }
    })();
  }, [setLoggedIn, setAccount]);

  return (
    <Box
      sx={{
        display: "flex",
        height: "100vh", // ✅ use height, not minHeight
        overflow: "hidden", // ✅ prevent page scroll at root
        bgcolor: "background.default",
      }}
    >
      <Sidebar />

      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          overflow: "hidden", // ✅ critical
        }}
      >
        <Topbar />

        {/* Spacer under fixed Topbar */}
        <Toolbar />

        {/* Page viewport */}
        <Box
          sx={{
            flex: 1,
            minHeight: 0, // ✅ critical for nested flex children
            overflow: "hidden", // ✅ page itself won't scroll
            p: 0, // ✅ removes the left empty gutter
          }}
        >
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
