import React, { useState } from "react";
import { AlertTriangle, Bell, CheckCircle2, Info } from "lucide-react";
import { Card } from "../components/ui/Primitives";
import { cx } from "../utils/format";

export function NotificationsPage({ notifications = [] }) {
  const [filter, setFilter] = useState("all");
  const visible = notifications.filter(
    (notification) => filter === "all" || notification.category === filter,
  );

  return (
    <Card className="min-h-[calc(100vh-150px)]">
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-xl font-black text-slate-950">
            <Bell className="h-5 w-5 text-blue-600" /> Notifications
          </h3>
        </div>
        <div className="flex gap-2">
          {["all", "system", "other"].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cx(
                "rounded-full px-3 py-1.5 text-xs font-bold capitalize",
                filter === value
                  ? "bg-slate-950 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {value === "other" ? "Other notifications" : value}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {visible.length ? (
          visible.map((notification) => {
            const Icon =
              notification.level === "error" || notification.level === "warning"
                ? AlertTriangle
                : notification.level === "success"
                  ? CheckCircle2
                  : Info;
            return (
              <div key={notification.id} className="flex gap-4 px-4 py-4">
                <Icon
                  className={cx(
                    "mt-0.5 h-5 w-5 shrink-0",
                    notification.level === "error"
                      ? "text-rose-500"
                      : notification.level === "warning"
                        ? "text-amber-500"
                        : notification.level === "success"
                          ? "text-emerald-500"
                          : "text-blue-500",
                  )}
                />
                <div>
                  <p className="text-sm font-black text-slate-800">
                    {notification.title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    {notification.message}
                  </p>
                </div>
              </div>
            );
          })
        ) : (
          <p className="px-4 py-12 text-center text-sm font-semibold text-slate-400">
            No notifications in this category.
          </p>
        )}
      </div>
    </Card>
  );
}
