export function cx(...classes) {
  return classes.filter(Boolean).join(" ");
}

export function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

export function decimalInput(value, digits = 2) {
  const cleaned = String(value ?? "")
    .replace(/[^0-9.]/g, "")
    .replace(/\.(?=.*\.)/g, "");
  const [whole, fraction = ""] = cleaned.split(".");
  return fraction ? `${whole}.${fraction.slice(0, digits)}` : whole;
}
