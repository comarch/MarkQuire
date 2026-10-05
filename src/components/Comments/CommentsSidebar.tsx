import React, { useState } from "react";
import { X, MessageSquare, Plus, CheckCircle2, ListFilter } from "lucide-react";
import { DriveComment } from "../../types/drive";
import { CommentThread } from "./CommentThread";
import { AcceptSuggestionHunkResult } from "./SuggestionCard";

interface CommentsSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  comments: DriveComment[];
  fileId: string | null;
  selectedCommentId: string | null;
  onSelectComment: (commentId: string | null) => void;
  onReplyComment: (commentId: string, content: string) => Promise<void>;
  onResolveComment: (commentId: string) => Promise<void>;
  onReopenComment: (commentId: string) => Promise<void>;
  onDeleteComment: (commentId: string) => Promise<void>;
  onOpenNewComment: () => void;
  onAcceptSuggestionHunk?: (
    commentId: string,
    hunkId: string,
  ) => Promise<AcceptSuggestionHunkResult> | AcceptSuggestionHunkResult;
  onAcceptAllSuggestions?: (commentId: string) => Promise<void>;
  onRejectSuggestion?: (commentId: string) => Promise<void>;
}

type FilterTab = "open" | "resolved" | "all";

export const CommentsSidebar: React.FC<CommentsSidebarProps> = ({
  isOpen,
  onClose,
  comments,
  fileId,
  selectedCommentId,
  onSelectComment,
  onReplyComment,
  onResolveComment,
  onReopenComment,
  onDeleteComment,
  onOpenNewComment,
  onAcceptSuggestionHunk,
  onAcceptAllSuggestions,
  onRejectSuggestion,
}) => {
  const [filter, setFilter] = useState<FilterTab>("open");

  if (!isOpen) return null;

  const openComments = comments.filter((c) => !c.resolved);
  const resolvedComments = comments.filter((c) => c.resolved);

  const displayedComments =
    filter === "open"
      ? openComments
      : filter === "resolved"
        ? resolvedComments
        : comments;

  return (
    <div className="w-80 sm:w-96 shrink-0 h-full bg-slate-50 dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 flex flex-col z-30 shadow-lg no-print select-none">
      {/* Sidebar Header */}
      <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-brand-600 dark:text-brand-400" />
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            Drive Comments
          </h2>
          {openComments.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white">
              {openComments.length}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onOpenNewComment}
            title="Add new comment"
            className="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-brand-600 transition"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            title="Close comments sidebar"
            className="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 text-xs">
        <button
          onClick={() => setFilter("open")}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition ${
            filter === "open"
              ? "bg-brand-50 dark:bg-brand-950/40 text-brand-600 dark:text-brand-400"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          <span>Open ({openComments.length})</span>
        </button>
        <button
          onClick={() => setFilter("resolved")}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition ${
            filter === "resolved"
              ? "bg-brand-50 dark:bg-brand-950/40 text-brand-600 dark:text-brand-400"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          <CheckCircle2 className="w-3 h-3" />
          <span>Resolved ({resolvedComments.length})</span>
        </button>
        <button
          onClick={() => setFilter("all")}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition ${
            filter === "all"
              ? "bg-brand-50 dark:bg-brand-950/40 text-brand-600 dark:text-brand-400"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          <ListFilter className="w-3 h-3" />
          <span>All ({comments.length})</span>
        </button>
      </div>

      {/* Comment Threads List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {displayedComments.length === 0 ? (
          <div className="text-center py-12 px-4 text-slate-400">
            <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="text-xs font-medium">No {filter} comments found.</p>
            <p className="text-[11px] mt-1 text-slate-400">
              Select text in editor or click &ldquo;+&rdquo; above to start a
              discussion.
            </p>
          </div>
        ) : (
          displayedComments.map((comment) => (
            <CommentThread
              key={comment.id}
              comment={comment}
              fileId={fileId}
              isSelected={comment.id === selectedCommentId}
              onSelect={() => onSelectComment(comment.id)}
              onReply={onReplyComment}
              onResolve={onResolveComment}
              onReopen={onReopenComment}
              onDelete={onDeleteComment}
              onAcceptSuggestionHunk={onAcceptSuggestionHunk}
              onAcceptAllSuggestions={onAcceptAllSuggestions}
              onRejectSuggestion={onRejectSuggestion}
            />
          ))
        )}
      </div>
    </div>
  );
};
