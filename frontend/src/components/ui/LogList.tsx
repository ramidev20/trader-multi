import React from "react";

type LogListProps = {
  logs?: string[];
  emptyMessage: string;
  className?: string;
};

export function LogList({ logs = [], emptyMessage, className = "" }: LogListProps) {
  const entries = logs.length ? logs : [emptyMessage];
  return (
    <div className={`log-list ${className}`}>
      {entries.map((line, index) => (
        <div
          key={`${line}-${index}`}
          className={
            /ERROR/i.test(line)
              ? "log-list__line log-list__line--error"
              : /WARNING/i.test(line)
                ? "log-list__line log-list__line--warning"
                : /SUCCESS|TP/i.test(line)
                  ? "log-list__line log-list__line--success"
                  : "log-list__line"
          }
        >
          {line}
        </div>
      ))}
    </div>
  );
}
