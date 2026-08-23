import React from "react";

type CardProps = React.PropsWithChildren<{
  className?: string;
  style?: React.CSSProperties;
}>;

export function Card({ children, className = "", style }: CardProps) {
  return (
    <div
      className={`app-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-950/[0.03] ${className}`}
      style={style}
    >
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

const buttonVariantClasses: Record<ButtonVariant, string> = {
  dark: "bg-slate-950 text-white hover:bg-slate-800",
  blue: "bg-blue-600 text-white hover:bg-blue-700",
  green: "bg-emerald-600 text-white hover:bg-emerald-700",
  red: "bg-rose-600 text-white hover:bg-rose-700",
  soft: "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
};

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
      className={`app-button app-button--${variant} inline-flex items-center justify-center gap-2 rounded-xl border-0 px-4 py-2.5 text-sm font-bold transition duration-150 disabled:cursor-default disabled:opacity-60 ${buttonVariantClasses[variant]} ${className}`}
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
  labelExtra?: React.ReactNode;
  value?: string | number;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
};

const fieldCaptionClass = "block text-xs font-black uppercase tracking-wide text-slate-500";
const fieldInputClass =
  "app-field-control mt-1.5 block w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition placeholder:font-medium placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60";

export function Field({
  label,
  labelExtra,
  value,
  type = "text",
  onChange,
  className = "",
  ...props
}: FieldProps & { className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className={labelExtra ? `${fieldCaptionClass} flex items-center justify-between gap-2` : fieldCaptionClass}>
        <span>{label}</span>
        {labelExtra}
      </span>
      <input
        type={type}
        value={onChange ? value : undefined}
        defaultValue={onChange ? undefined : value}
        onChange={onChange}
        {...props}
        className={fieldInputClass}
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
    <label className="block">
      <span className={fieldCaptionClass}>{label}</span>
      <select
        value={onChange ? value : undefined}
        defaultValue={onChange ? undefined : value}
        onChange={onChange}
        className={fieldInputClass}
      >
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

export function Dialog({ open, title, children, onClose }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/40 p-4 backdrop-blur-sm">
      <div className="app-dialog mx-auto mt-12 w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-950/20">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="m-0 text-lg font-black text-slate-950">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="app-dialog-close rounded-lg border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
