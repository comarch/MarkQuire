import React, { useState } from "react";
import { Check, X, AlertTriangle, FileDiff } from "lucide-react";
import { SuggestionHunk } from "../../utils/patch";

/** Result of applying one suggestion hunk; sync or promised. */
export type AcceptSuggestionHunkResult = "applied" | "unresolvable";

interface SuggestionCardProps {
  hunks: SuggestionHunk[];
  // Sync and async handlers both fit: the card awaits either shape.
  onAccept: (
    hunkId: string,
  ) => Promise<AcceptSuggestionHunkResult> | AcceptSuggestionHunkResult;
  onAcceptAll: () => Promise<void>;
  onReject: () => Promise<void>;
  disabled?: boolean;
}

const hunkStatusLabel = (status: string): string | null => {
  if (status === "applied") return "Applied";
  if (status === "unresolvable") return "Unresolvable - the text changed";
  return null;
};

// Diff lines have no id of their own, so keys pair the line text with an
// occurrence number to stay unique for repeated lines.
function zipWithKeys(lines: string[]): { key: string; line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = (seen.get(line) ?? 0) + 1;
    seen.set(line, occurrence);
    return { key: `${line}#${occurrence}`, line };
  });
}

export const SuggestionCard: React.FC<SuggestionCardProps> = ({
  hunks,
  onAccept,
  onAcceptAll,
  onReject,
  disabled,
}) => {
  const [busyHunkId, setBusyHunkId] = useState<string | null>(null);
  const [hunkStatus, setHunkStatus] = useState<Record<string, string>>({});

  const acceptHunk = async (hunk: SuggestionHunk) => {
    if (disabled || busyHunkId) return;
    setBusyHunkId(hunk.id);
    try {
      const status = await onAccept(hunk.id);
      setHunkStatus((prev) => ({ ...prev, [hunk.id]: status }));
    } finally {
      setBusyHunkId(null);
    }
  };

  const pendingCount = hunks.filter(
    (hunk) => hunkStatus[hunk.id] === undefined,
  ).length;

  return (
    <div className="mt-2 rounded-lg border border-brand-200 dark:border-brand-900 bg-brand-50/40 dark:bg-brand-950/20 p-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-700 dark:text-brand-300">
        <FileDiff className="w-3.5 h-3.5" />
        <span>
          Suggested edit{hunks.length === 1 ? "" : "s"} ({hunks.length})
        </span>
      </div>

      {hunks.map((hunk) => {
        const status = hunkStatusLabel(hunkStatus[hunk.id] ?? "");
        return (
          <div
            key={hunk.id}
            className="rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden"
          >
            <div className="font-mono text-[10px] leading-relaxed">
              {zipWithKeys(hunk.deletedLines).map(({ key, line }) => (
                <div
                  key={`d-${key}`}
                  className="bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 px-2 py-0.5 line-through overflow-x-auto whitespace-pre-wrap"
                >
                  - {line}
                </div>
              ))}
              {zipWithKeys(hunk.insertedLines).map(({ key, line }) => (
                <div
                  key={`i-${key}`}
                  className="bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 overflow-x-auto whitespace-pre-wrap"
                >
                  + {line}
                </div>
              ))}
              {hunk.deletedLines.length === 0 &&
                hunk.insertedLines.length === 0 && (
                  <div className="px-2 py-0.5 text-slate-400">
                    (empty change)
                  </div>
                )}
            </div>

            <div className="flex items-center justify-between gap-2 px-2 py-1 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700">
              {status ? (
                <span
                  className={`flex items-center gap-1 text-[10px] font-medium ${
                    hunkStatus[hunk.id] === "applied"
                      ? "text-emerald-600"
                      : "text-amber-600"
                  }`}
                >
                  {hunkStatus[hunk.id] === "unresolvable" && (
                    <AlertTriangle className="w-3 h-3" />
                  )}
                  {status}
                </span>
              ) : (
                <button
                  onClick={() => void acceptHunk(hunk)}
                  disabled={disabled || busyHunkId !== null}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded disabled:opacity-50 transition"
                >
                  <Check className="w-3 h-3" />
                  <span>Accept</span>
                </button>
              )}
            </div>
          </div>
        );
      })}

      {pendingCount > 1 && (
        <button
          onClick={() => void onAcceptAll()}
          disabled={disabled || busyHunkId !== null}
          className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-md disabled:opacity-50 transition"
        >
          <Check className="w-3 h-3" />
          <span>Accept all ({pendingCount})</span>
        </button>
      )}

      <button
        onClick={() => void onReject()}
        disabled={disabled || busyHunkId !== null}
        className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md disabled:opacity-50 transition"
      >
        <X className="w-3 h-3" />
        <span>Reject and close</span>
      </button>
    </div>
  );
};
