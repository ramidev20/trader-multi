import React from "react";
import { Info } from "lucide-react";

type NoteHintProps = {
  text: string;
  label?: string;
};

export function NoteHint({ text, label = "Show note" }: NoteHintProps) {
  return (
    <button
      type="button"
      className="note-hint"
      title={text}
      aria-label={`${label}: ${text}`}
    >
      <Info size={14} strokeWidth={2.5} />
    </button>
  );
}
