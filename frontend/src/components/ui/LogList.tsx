import React from "react";

type LogListProps = {
  logs?: string[];
  emptyMessage: string;
  className?: string;
};

function logLineClass(line: string) {
  if (/STOP|STOPPED|STRATEGY STOPPED|MANUAL STOP/i.test(line)) {
    return "log-list__line log-list__line--error";
  }
  if (/ERROR/i.test(line)) return "log-list__line log-list__line--error";
  if (/WARNING|PAUSE|PAUSED/i.test(line)) {
    return "log-list__line log-list__line--warning";
  }
  if (/INFO/i.test(line)) return "log-list__line log-list__line--info";
  if (/SUCCESS|TP/i.test(line)) return "log-list__line log-list__line--success";
  return "log-list__line";
}

export function LogList({ logs = [], emptyMessage, className = "" }: LogListProps) {
  const entries = logs.length ? logs : [emptyMessage];
  return (
    <div className={`log-list ${className}`}>
      {entries.map((line, index) => (
        <div
          key={`${line}-${index}`}
          className={logLineClass(line)}
        >
          {line}
        </div>
      ))}
    </div>
  );
}
