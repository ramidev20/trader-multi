import React from "react";

type TableFrameProps = React.PropsWithChildren<{
  className?: string;
}>;

export function TableFrame({ children, className = "" }: TableFrameProps) {
  return (
    <div className={`table-frame ${className}`}>
      <div className="table-frame__scroll">{children}</div>
    </div>
  );
}
