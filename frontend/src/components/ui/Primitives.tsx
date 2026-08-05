import React from "react";

type CardProps = React.PropsWithChildren<{
  className?: string;
  style?: React.CSSProperties;
}>;

export function Card({ children, className = "", style }: CardProps) {
  return (
    <div className={className} style={{ ...styles.card, ...style }}>
      {children}
    </div>
  );
}

type ButtonVariant = "dark" | "blue" | "green" | "red" | "soft";
type AppButtonProps = React.PropsWithChildren<{
  variant?: ButtonVariant;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
}>;

export function AppButton({
  children,
  variant = "dark",
  className = "",
  onClick,
  disabled = false,
  type = "button",
}: AppButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={className}
      style={{
        ...styles.button,
        ...styles.buttonVariants[variant],
        ...(disabled ? styles.buttonDisabled : {}),
      }}
    >
      {children}
    </button>
  );
}

type FieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
> & {
  label: string;
  value?: string | number;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
};

export function Field({
  label,
  value,
  type = "text",
  onChange,
  ...props
}: FieldProps) {
  return (
    <label style={styles.fieldLabel}>
      <span style={styles.fieldCaption}>{label}</span>
      <input
        type={type}
        value={onChange ? value : undefined}
        defaultValue={onChange ? undefined : value}
        onChange={onChange}
        {...props}
        style={styles.fieldInput}
      />
    </label>
  );
}

type SelectBoxProps = {
  label: string;
  value?: string;
  options: string[];
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
};

export function SelectBox({ label, value, options, onChange }: SelectBoxProps) {
  return (
    <label style={styles.fieldLabel}>
      <span style={styles.fieldCaption}>{label}</span>
      <select
        value={onChange ? value : undefined}
        defaultValue={onChange ? undefined : value}
        onChange={onChange}
        style={styles.fieldInput}
      >
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

export function Toggle({ label, checked = true }) {
  return (
    <div style={styles.toggle}>
      <span style={styles.toggleLabel}>{label}</span>
      <span
        style={{
          ...styles.toggleTrack,
          backgroundColor: checked ? "#2563eb" : "#cbd5e1",
        }}
      >
        <span style={{ ...styles.toggleThumb, left: checked ? 24 : 4 }} />
      </span>
    </div>
  );
}

export function Dialog({ open, title, children, onClose }) {
  if (!open) return null;
  return (
    <div style={styles.dialogOverlay}>
      <div style={styles.dialog}>
        <div style={styles.dialogHeader}>
          <h3 style={styles.dialogTitle}>{title}</h3>
          <button onClick={onClose} style={styles.dialogClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const styles = {
  card: {
    borderRadius: 16,
    border: "1px solid #e2e8f0",
    backgroundColor: "#ffffff",
    padding: 20,
    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.05)",
  } as React.CSSProperties,
  button: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    border: 0,
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    transition: "background-color 160ms ease, opacity 160ms ease",
  } as React.CSSProperties,
  buttonVariants: {
    dark: { backgroundColor: "#020617", color: "#ffffff" },
    blue: { backgroundColor: "#2563eb", color: "#ffffff" },
    green: { backgroundColor: "#059669", color: "#ffffff" },
    red: { backgroundColor: "#e11d48", color: "#ffffff" },
    soft: {
      border: "1px solid #e2e8f0",
      backgroundColor: "#ffffff",
      color: "#334155",
    },
  } as Record<ButtonVariant, React.CSSProperties>,
  buttonDisabled: { cursor: "default", opacity: 0.6 } as React.CSSProperties,
  fieldLabel: { display: "block" } as React.CSSProperties,
  fieldCaption: {
    display: "block",
    color: "#64748b",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  } as React.CSSProperties,
  fieldInput: {
    boxSizing: "border-box",
    display: "block",
    width: "100%",
    marginTop: 4,
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    backgroundColor: "#f8fafc",
    padding: "12px 16px",
    color: "#0f172a",
    fontSize: 14,
    fontWeight: 600,
    outline: "none",
  } as React.CSSProperties,
  toggle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    backgroundColor: "#f8fafc",
    padding: "12px 16px",
  } as React.CSSProperties,
  toggleLabel: {
    color: "#334155",
    fontSize: 14,
    fontWeight: 600,
  } as React.CSSProperties,
  toggleTrack: {
    position: "relative",
    display: "inline-flex",
    width: 44,
    height: 24,
    borderRadius: 9999,
    transition: "background-color 160ms ease",
  } as React.CSSProperties,
  toggleThumb: {
    position: "absolute",
    top: 4,
    width: 16,
    height: 16,
    borderRadius: "50%",
    backgroundColor: "#ffffff",
    transition: "left 160ms ease",
  } as React.CSSProperties,
  dialogOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    backgroundColor: "rgba(15, 23, 42, 0.4)",
    padding: 16,
  } as React.CSSProperties,
  dialog: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: 672,
    margin: "48px auto 0",
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    backgroundColor: "#ffffff",
    padding: 20,
    boxShadow: "0 20px 40px rgba(15, 23, 42, 0.2)",
  } as React.CSSProperties,
  dialogHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  } as React.CSSProperties,
  dialogTitle: {
    margin: 0,
    color: "#020617",
    fontSize: 18,
    fontWeight: 900,
  } as React.CSSProperties,
  dialogClose: {
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    backgroundColor: "#ffffff",
    padding: "4px 12px",
    color: "#475569",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  } as React.CSSProperties,
};
