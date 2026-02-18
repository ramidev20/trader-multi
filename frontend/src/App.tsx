import React, { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { connectSocket, disconnectSocket } from "./api/socket";
import { useTradingStore } from "./store/tradingStore";
import AppLayout from "./layout/appLayout";
import Dashboard from "./pages/dashboard";
import StrategyPage from "./pages/strategy";
import UtilityPage from "./pages/utility";
import SettingsPage from "./pages/settings";

export default function App() {
  const isLoggedIn = useTradingStore((s) => s.isLoggedIn);

  useEffect(() => {
    if (isLoggedIn) connectSocket();
    else disconnectSocket();

    return () => disconnectSocket();
  }, [isLoggedIn]);

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/strategy" element={<StrategyPage />} />
        <Route path="/utility" element={<UtilityPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
