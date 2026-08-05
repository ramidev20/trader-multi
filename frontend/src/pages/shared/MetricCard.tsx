import React from "react";
import { Card } from "../../components/ui/Primitives";

type MetricTone = "slate" | "blue" | "green" | "amber";

type MetricCardProps = {
  label: string;
  value: React.ReactNode;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: MetricTone;
};

export function MetricCard({ label, value, hint, icon: Icon, tone = "slate" }: MetricCardProps) {
  return (
    <Card>
      <div style={styles.header}>
        <p style={styles.label}>{label}</p>
        <div style={{ ...styles.icon, ...styles.iconTones[tone] }}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p style={styles.value}>{value}</p>
      <p style={styles.hint}>{hint}</p>
    </Card>
  );
}

const styles = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  } satisfies React.CSSProperties,
  label: {
    margin: 0,
    color: "#64748b",
    fontSize: 14,
    fontWeight: 700,
  } satisfies React.CSSProperties,
  icon: {
    display: "grid",
    placeItems: "center",
    borderRadius: 16,
    padding: 8,
  } satisfies React.CSSProperties,
  iconTones: {
    slate: { backgroundColor: "#f1f5f9", color: "#475569" },
    blue: { backgroundColor: "#eff6ff", color: "#1d4ed8" },
    green: { backgroundColor: "#ecfdf5", color: "#047857" },
    amber: { backgroundColor: "#fffbeb", color: "#b45309" },
  } satisfies Record<MetricTone, React.CSSProperties>,
  value: {
    margin: "16px 0 0",
    color: "#020617",
    fontSize: 24,
    fontWeight: 900,
    letterSpacing: "-0.025em",
  } satisfies React.CSSProperties,
  hint: {
    margin: "4px 0 0",
    color: "#64748b",
    fontSize: 12,
  } satisfies React.CSSProperties,
};
