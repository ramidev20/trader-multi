// Shared parsing for the backend's "search" log channel, used by every page
// that renders it through ConsoleLogPanel (Manual Trade's Log tab, the
// Search page, ...) so they all look and behave the same way instead of
// each page reinventing its own line format.

// Backend lines are "[HH:MM:SS] [LEVEL] message"; split both brackets out so
// the panel can color by the real level instead of guessing.
export function parseSearchLogLine(line, index) {
  const text = String(line);
  const match = text.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[(\w+)\]\s*(.*)$/);
  if (match) {
    const [, at, levelWord, message] = match;
    const level = ["error", "warning", "success", "info"].includes(levelWord.toLowerCase())
      ? levelWord.toLowerCase()
      : "info";
    const sideMatch = message.match(/\[scalping:(demand|supply)\]/i);
    const side = sideMatch?.[1]?.toLowerCase();
    return { id: `search-${index}-${at}-${message}`, level, message, at, ...(side ? { side } : {}) };
  }
  const fallback = text.match(/^\[(.*?)\]\s*(.*)$/);
  return {
    id: `search-${index}-${text}`,
    level: "info",
    message: fallback?.[2] ?? text,
    at: fallback?.[1] ?? "--:--:--",
  };
}
