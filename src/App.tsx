import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { AppHeader, type EditingMode } from "./components/Header/AppHeader";
import { EditorToolbar } from "./components/Editor/EditorToolbar";
import {
  CodeMirrorEditor,
  CodeMirrorEditorHandle,
} from "./components/Editor/CodeMirrorEditor";
import { FloatingCommentButton } from "./components/Editor/FloatingCommentButton";
import {
  MarkdownPreview,
  MarkdownPreviewHandle,
  extractOutline,
} from "./components/Preview/MarkdownPreview";
import { CommentsSidebar } from "./components/Comments/CommentsSidebar";
import { NewCommentModal } from "./components/Comments/NewCommentModal";
import { SettingsModal } from "./components/Modals/SettingsModal";
import { ExportModal } from "./components/Modals/ExportModal";
import { InsertTableModal } from "./components/Modals/InsertTableModal";
import { OutlineSidebar } from "./components/Modals/OutlineSidebar";
import { ConflictModal } from "./components/Modals/ConflictModal";
import { HistorySidebar } from "./components/Modals/HistorySidebar";
import { FileBrowserModal } from "./components/Modals/FileBrowserModal";
import { PropertiesPanel } from "./components/Editor/PropertiesPanel";
import { TableToolbar } from "./components/Editor/TableToolbar";
import { ReviewQueueModal } from "./components/Modals/ReviewQueueModal";
import { TemplatesModal } from "./components/Modals/TemplatesModal";
import { GraphModal } from "./components/Modals/GraphModal";
import { PresentModal } from "./components/Present/PresentModal";
import { exportAsStaticSite, type StaticSitePage } from "./utils/exportUtils";
import {
  expandTemplateVariables,
  type DocumentTemplate,
} from "./services/templates";

import { authService } from "./services/googleAuth";
import { driveService } from "./services/googleDrive";
import { AI_BUILD_ENABLED, defaultAISettings } from "./services/ai";
import {
  enqueueSave,
  isNetworkError,
  listQueuedSaves,
  removeQueuedSave,
  replayQueue as replayQueuedSaves,
  type OfflineSaveEntry,
} from "./services/offlineQueue";
import {
  applyContentToText,
  openCollabSession,
  type CollabPeer,
  type CollabSession,
} from "./services/collab";
import {
  indexForSearch,
  notifyIntegration,
  openEventStream,
  registerDriveWatch,
  type CompanionEventStream,
} from "./services/companion";
import { AIPanel } from "./components/AI/AIPanel";
import { commentsService } from "./services/googleComments";
import {
  parseDriveStateFromUrl,
  updateUrlFileId,
  parseLineAnchorFromUrl,
} from "./services/driveState";
import { SAMPLE_MARKDOWN } from "./utils/sampleDocument";
import { persistDraft, readPersistedDraft } from "./utils/draft";
import { safeGetItem, safeSetItem } from "./utils/safeStorage";
import { toggleTaskLine } from "./utils/tasks";
import { parseFrontmatter, updateFrontmatterField } from "./utils/frontmatter";
import { REVIEW_STATUS_FIELD } from "./utils/reviewStatus";
import { setLanguage, t } from "./i18n";
import { Eye, PenLine, CloudDownload } from "lucide-react";
import { applyTableAction, type TableAction } from "./utils/tableUtils";
import {
  generateTableOfContents,
  moveSectionBy,
  numberHeadings,
} from "./utils/structure";
import {
  applySuggestionHunks,
  buildSuggestionHunks,
  parseSuggestions,
  serializeSuggestions,
} from "./utils/patch";
import type { TableCursorContext } from "./components/Editor/CodeMirrorEditor";

import {
  DriveUser,
  DriveFileMetadata,
  SaveStatus,
  DriveComment,
  DriveRevision,
} from "./types/drive";
import {
  ViewMode,
  SelectionInfo,
  AppSettings,
  OutlineItem,
} from "./types/editor";

/**
 * Allow-list for links that may open after a Drive export: the API
 * response is external input, so only Google-owned hosts pass.
 */
const isGoogleHost = (hostname: string): boolean =>
  /(^|\.)google\.com$/.test(hostname) ||
  /(^|\.)googleusercontent\.com$/.test(hostname);

const DEFAULT_SETTINGS: AppSettings = {
  googleClientId: authService.getClientId(),
  autoSaveIntervalMs: 2000,
  theme: "system",
  fontSize: 14,
  syncScroll: true,
  templatesFolderId: "",
  language: "en",
  richView: true,
  ai: defaultAISettings(),
  companionUrl: "",
};

const LOCAL_STORAGE_SETTINGS_KEY = "gdrive_md_settings";

/**
 * Fields written to the settings cache on modal save. The header zoom
 * controls stay session-only, so nothing they touch reaches storage.
 * googleClientId stays out too: it has its own storage key in authService.
 */
/**
 * Fields written to the settings cache on modal save. The header zoom
 * controls stay session-only, so nothing they touch reaches storage.
 * googleClientId stays out (own storage key in authService), and the AI
 * API key is never persisted: it lives in memory for this session only.
 */
const toPersistableSettings = (
  value: AppSettings,
): Omit<AppSettings, "googleClientId"> => ({
  autoSaveIntervalMs: value.autoSaveIntervalMs,
  theme: value.theme,
  fontSize: value.fontSize,
  syncScroll: value.syncScroll,
  templatesFolderId: value.templatesFolderId,
  language: value.language,
  richView: value.richView,
  companionUrl: value.companionUrl,
  ai: { ...value.ai, apiKey: "" },
});

type DriveHeadState =
  | { outcome: "clear" }
  | { outcome: "adopted"; headRevisionId: string }
  | { outcome: "conflict"; baseContent: string; remoteContent: string };

/**
 * Compares the Drive head revision with the one this session synced
 * from. "adopted" means both sides hold the same merged text, so the
 * new head is safe to take without a conflict dialog.
 */
const checkDriveHead = async (input: {
  fileId: string;
  knownHead: string | null | undefined;
  content: string;
  lastSynced: string;
}): Promise<DriveHeadState> => {
  if (!input.knownHead) return { outcome: "clear" };
  let remoteHead: string | null = null;
  try {
    remoteHead = await driveService.fetchHeadRevisionId(input.fileId);
  } catch {
    // The revision check is best effort; the update call still
    // reports hard failures.
  }
  if (remoteHead === null || remoteHead === input.knownHead) {
    return { outcome: "clear" };
  }
  const remote = await driveService.getFile(input.fileId);
  if (remote.content === input.content) {
    return { outcome: "adopted", headRevisionId: remoteHead };
  }
  return {
    outcome: "conflict",
    baseContent: input.lastSynced,
    remoteContent: remote.content,
  };
};

/** Best-effort offline queue write; false means the caller should
 * surface a save error instead. */
const tryQueueOfflineSave = async (entry: {
  fileId: string;
  name: string;
  content: string;
  baseRevisionId: string | null;
  baseContent: string;
}): Promise<boolean> => {
  try {
    await enqueueSave({ ...entry, savedAt: new Date().toISOString() });
    return true;
  } catch (queueError) {
    console.error("Offline queue write failed:", queueError);
    return false;
  }
};

export const App: React.FC = () => {
  // Application Settings
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const stored = safeGetItem(LOCAL_STORAGE_SETTINGS_KEY);
      if (!stored) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(stored) as Partial<AppSettings>;
      // The AI block merges field by field so older stored settings
      // never lose new defaults.
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        ai: { ...defaultAISettings(), ...parsed.ai },
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  // Dark Mode
  const [isDark, setIsDark] = useState<boolean>(() => {
    return (
      localStorage.getItem("theme") === "dark" ||
      (!("theme" in localStorage) &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
    );
  });

  // Document State
  const [documentTitle, setDocumentTitle] = useState<string>(() => {
    return readPersistedDraft("Welcome.md", SAMPLE_MARKDOWN).title;
  });
  const [content, setContent] = useState<string>(() => {
    return readPersistedDraft("Welcome.md", SAMPLE_MARKDOWN).content;
  });
  const [fileMetadata, setFileMetadata] = useState<DriveFileMetadata | null>(
    null,
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");

  // Google User
  const [user, setUser] = useState<DriveUser | null>(
    authService.getCurrentUser(),
  );

  // Comments
  const [comments, setComments] = useState<DriveComment[]>([]);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null,
  );
  const [isCommentsOpen, setIsCommentsOpen] = useState(false);
  const [isNewCommentModalOpen, setIsNewCommentModalOpen] = useState(false);

  // Outline
  const [isOutlineOpen, setIsOutlineOpen] = useState(false);

  // Other Modals
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isTableModalOpen, setIsTableModalOpen] = useState(false);

  // Save conflict detected when Drive moved ahead of this session
  const [conflict, setConflict] = useState<{
    baseContent: string;
    remoteContent: string;
  } | null>(null);

  // Drive version history
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyRevisions, setHistoryRevisions] = useState<DriveRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySelectedId, setHistorySelectedId] = useState<string | null>(
    null,
  );
  const [historySelectedContent, setHistorySelectedContent] = useState<
    string | null
  >(null);

  // Recent Markdown files browser
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [fileBrowserFiles, setFileBrowserFiles] = useState<DriveFileMetadata[]>(
    [],
  );
  const [fileBrowserLoading, setFileBrowserLoading] = useState(false);
  const [fileBrowserError, setFileBrowserError] = useState<string | null>(null);

  // Frontmatter properties panel
  const [isPropertiesOpen, setIsPropertiesOpen] = useState(false);

  // Review workflow: queue modal and passage deep link anchor
  const [isReviewQueueOpen, setIsReviewQueueOpen] = useState(false);
  // Templates and snippets modal
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  // Folder link graph modal
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  // Slide presentation mode
  const [isPresentOpen, setIsPresentOpen] = useState(false);
  // AI assistant panel, feature-flagged by the build and the settings
  const [isAIOpen, setIsAIOpen] = useState(false);
  // Collaborative editing (optional companion relay)
  const [collabPeers, setCollabPeers] = useState<CollabPeer[]>([]);
  const [driveChangeNotice, setDriveChangeNotice] = useState(false);
  const collabSessionRef = useRef<CollabSession | null>(null);
  const collabEventStreamRef = useRef<CompanionEventStream | null>(null);
  // Mirrors content for session lifecycle effects that must not re-run
  // on every keystroke; updated in an effect, never during render.
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);
  // Passage deep link (#line=N), parsed once on mount.
  const [lineAnchor] = useState<number | null>(() => parseLineAnchorFromUrl());
  const lineAnchorAppliedRef = useRef(false);

  // Table context toolbar
  const [tableContext, setTableContext] = useState<TableCursorContext | null>(
    null,
  );

  // Editor Selection & View Mode
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("split");

  // Zoom moves the shared text size for editor and preview together.
  // It stays session-only: nothing derived from restored settings is
  // written back to storage from here. The settings modal owns the
  // persisted font size.
  const handleZoomIn = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      fontSize: Math.min(22, prev.fontSize + 1),
    }));
  }, []);
  const handleZoomOut = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      fontSize: Math.max(12, prev.fontSize - 1),
    }));
  }, []);

  // Collaborative editing over the optional companion relay. The session
  // opens with the file and the companion URL; the Yjs text is the live
  // editing truth, Drive stays the durability layer through autosave.
  const companionUrl = settings.companionUrl.trim();
  const collabFileId = fileMetadata?.id ?? null;
  useEffect(() => {
    if (!companionUrl || !collabFileId) return;
    const author = {
      name: user?.displayName?.trim() || "Guest author",
    };
    const session = openCollabSession(
      companionUrl,
      collabFileId,
      author,
      contentRef.current,
      (peers) => setCollabPeers(peers),
    );
    collabSessionRef.current = session;

    // Remote edits flow into the app content state; the editor syncs
    // from it through the usual value effect.
    const observer = () => {
      const next = session.text.toString();
      if (next !== contentRef.current) setContent(next);
    };
    session.text.observe(observer);

    // Drive change notifications (item 28): the companion pushes
    // webhook events into the event stream for this room.
    const stream = openEventStream(companionUrl, collabFileId, () => {
      setDriveChangeNotice(true);
    });
    collabEventStreamRef.current = stream;

    // Register a Drive watch through the companion with this session's
    // token. Demo tokens are never sent; the event stream still works.
    const token = authService.getAccessToken();
    if (token && !token.startsWith("mock_google_token_")) {
      void registerDriveWatch(companionUrl, collabFileId, token);
    }

    return () => {
      session.text.unobserve(observer);
      session.destroy();
      collabSessionRef.current = null;
      stream?.close();
      collabEventStreamRef.current = null;
      setCollabPeers([]);
    };
  }, [companionUrl, collabFileId, user?.displayName]);

  // Local content changes (typing, patches, conflict merges) push into
  // the shared text with a middle diff when a session is open.
  useEffect(() => {
    const session = collabSessionRef.current;
    if (!session) return;
    applyContentToText(session.text, content);
  }, [content]);

  // AI assistant: open discussion threads as plain text for prompts.
  const aiThreadSnippets = useMemo(
    () =>
      comments
        .filter((comment) => !comment.deleted)
        .map((comment) =>
          [
            comment.content,
            ...(comment.replies ?? []).map((reply) => reply.content),
          ]
            .filter((part) => part.length > 0)
            .join("\n"),
        ),
    [comments],
  );

  // Interface language applies to the whole shell. The catalogue is a
  // module singleton, so the mirror state forces the re-render that picks
  // the new strings up; the root data attribute makes it observable.
  const [uiLanguage, setUiLanguage] = useState(settings.language);
  useEffect(() => {
    setLanguage(settings.language);
    setUiLanguage(settings.language);
  }, [settings.language]);

  // Mobile: single pane with a floating switch, because a 50/50 split
  // is unreadable below tablet widths.
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
  );
  const [mobilePane, setMobilePane] = useState<"editor" | "preview">("editor");
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const showEditorPane =
    (viewMode === "split" || viewMode === "editor") &&
    (!isMobile || mobilePane === "editor");
  const showPreviewPane =
    (viewMode === "split" || viewMode === "preview") &&
    (!isMobile || mobilePane === "preview");
  // Suggestion mode: edits are recorded as a patch, not written to Drive.
  const [editingMode, setEditingMode] = useState<EditingMode>("edit");
  // Mirror of editingMode for handlers that must see the mode
  // synchronously, before the next render lands. Kept in sync by the
  // effect below; AI suggestion application writes it directly.
  const editingModeRef = useRef<EditingMode>("edit");
  useEffect(() => {
    editingModeRef.current = editingMode;
  }, [editingMode]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  // Document text the suggester started from; null outside suggest mode.
  const [suggestionBase, setSuggestionBase] = useState<string | null>(null);

  // Component Refs
  const editorRef = useRef<CodeMirrorEditorHandle>(null);
  const previewRef = useRef<MarkdownPreviewHandle>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Content last synced with Drive; acts as the base for conflict merges.
  // Handlers update the state (compiler-safe); sync reads use the ref,
  // which a dedicated effect keeps in step.
  const lastSyncedContentRef = useRef<string>(content);
  const [lastSyncedContent, setLastSyncedContent] = useState(content);
  useEffect(() => {
    lastSyncedContentRef.current = lastSyncedContent;
  }, [lastSyncedContent]);

  // Reload the Drive version when the change notification banner says
  // the document moved on. Unsaved local edits stay in the editor until
  // saved; the reload is explicit, never silent.
  const handleReloadFromDrive = useCallback(async () => {
    if (!fileMetadata) return;
    try {
      const remote = await driveService.getFile(fileMetadata.id);
      setFileMetadata(remote.metadata);
      setContent(remote.content);
      // The draft cache is not written here: the reloaded text comes
      // straight from Drive, and the cache refreshes on the next edit.
      setLastSyncedContent(remote.content);
      setDriveChangeNotice(false);
    } catch (err) {
      console.error("Reload from Drive failed:", err);
    }
  }, [fileMetadata]);
  // Suppresses auto-save while the conflict dialog is open.
  const isConflictOpenRef = useRef(false);
  // Resolved cross-document links, cached per session folder and file name.
  const docLinkCacheRef = useRef(new Map<string, string | null>());

  // Leaves suggestion mode without a dialog when the document is about to
  // be replaced wholesale (open, restore, conflict, new document).
  const exitSuggestModeSilently = useCallback(() => {
    setEditingMode("edit");
    setSuggestionError(null);
    setSuggestionBase(null);
  }, []);

  // Turns an AI answer for commentToPatch into a suggestion patch: the
  // replacement covers the current selection, so suggestion mode records
  // exactly that change for the author to accept or reject.
  const handleAISuggestion = useCallback(
    (text: string) => {
      if (selection === null) return;
      const base = content;
      // The replacement goes through the editor transaction, so the
      // content change surfaces through the normal change listener with
      // the same origin as typed edits. Suggest mode must already be
      // active for the listener to treat it as a proposal.
      editingModeRef.current = "suggest";
      setEditingMode("suggest");
      setSuggestionBase(base);
      editorRef.current?.replaceSelection(text);
      setIsAIOpen(false);
    },
    [content, selection],
  );

  // Google Docs export: Drive converts an uploaded copy, the Markdown
  // original stays untouched.
  const handleExportGoogleDocs = useCallback(async () => {
    try {
      const metadata = await driveService.createGoogleDocsFile(
        documentTitle,
        content,
        fileMetadata?.parents?.[0],
      );
      // The view link comes from the Drive API response, so it only
      // opens after passing an allow-list check for Google hosts.
      if (metadata.webViewLink) {
        try {
          const url = new URL(metadata.webViewLink);
          if (url.protocol === "https:" && isGoogleHost(url.hostname)) {
            window.open(url.toString(), "_blank", "noopener,noreferrer");
          }
        } catch {
          // A malformed link is skipped; the export itself succeeded.
        }
      }
    } catch (error) {
      console.error("Google Docs export failed:", error);
    }
  }, [content, documentTitle, fileMetadata]);

  // Passage deep link: scroll the editor to the linked line once the
  // document text is available.
  useEffect(() => {
    if (lineAnchor === null || lineAnchorAppliedRef.current) return;
    if (content.length === 0) return;
    lineAnchorAppliedRef.current = true;
    editorRef.current?.scrollToLine(lineAnchor);
  }, [lineAnchor, content]);

  // Sync theme with DOM
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
    // Keep the mobile browser chrome aligned with the header surface
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", isDark ? "#000000" : "#FFFFFF");
  }, [isDark]);

  // Subscribe to Google Auth changes
  useEffect(() => {
    const unsubscribe = authService.subscribe(() => {
      setUser(authService.getCurrentUser());
    });
    return unsubscribe;
  }, []);

  // Load comments for active file
  const loadComments = useCallback(async (fileId: string) => {
    try {
      const list = await commentsService.listComments(fileId);
      setComments(list);
    } catch (err) {
      console.warn("Failed to load Google Drive comments:", err);
    }
  }, []);

  // Initialize from Google Drive URL state (New or Open)
  useEffect(() => {
    const driveState = parseDriveStateFromUrl();
    if (!driveState) {
      // Standalone load
      const mockFileId = "local_draft";
      loadComments(mockFileId);
      return;
    }

    const initDrive = async () => {
      setSaveStatus("saving");
      try {
        if (
          driveState.action === "open" &&
          driveState.ids &&
          driveState.ids.length > 0
        ) {
          const fileId = driveState.ids[0];
          if (!fileId) {
            throw new Error("Google Drive did not provide a file ID.");
          }
          const result = await driveService.getFile(fileId);
          setFileMetadata(result.metadata);
          setDocumentTitle(result.metadata.name);
          setContent(result.content);
          setLastSyncedContent(result.content);
          setSaveStatus("saved");
          updateUrlFileId(fileId);
          await loadComments(fileId);
        } else if (driveState.action === "create") {
          // Create new file in specified folder
          const created = await driveService.createFile(
            "Untitled.md",
            SAMPLE_MARKDOWN,
            driveState.folderId,
          );
          setFileMetadata(created);
          setDocumentTitle(created.name);
          setContent(SAMPLE_MARKDOWN);
          setLastSyncedContent(SAMPLE_MARKDOWN);
          setSaveStatus("saved");
          updateUrlFileId(created.id);
          await loadComments(created.id);
        }
      } catch (err) {
        console.error("Error handling Drive state:", err);
        setSaveStatus("error");
      }
    };

    // Fire-and-forget init: the internal try/catch keeps it from ever
    // rejecting, and the void operator marks the floating promise as
    // intentional.
    void initDrive();
  }, [loadComments]);

  // Save document to Google Drive / LocalStorage
  const handleSaveDocument = useCallback(async () => {
    if (isConflictOpenRef.current) return; // resolve the open conflict first
    setSaveStatus("saving");

    // Draft mode: the content and title change handlers already keep
    // the local cache current, so re-writing the restored values here
    // would only copy storage-read data back into browser storage.
    if (!fileMetadata) {
      setSaveStatus("saved");
      return;
    }

    // Detect concurrent edits: compare the Drive head revision with the
    // revision this session last synced from. Co-editing sessions save
    // the same merged content from both sides; adopting the new head
    // instead of opening a dialog is what lets two authors edit without
    // conflict dialogs.
    const headState = await checkDriveHead({
      fileId: fileMetadata.id,
      knownHead: fileMetadata.headRevisionId,
      content,
      lastSynced: lastSyncedContentRef.current,
    });
    if (headState.outcome === "conflict") {
      setConflict({
        baseContent: headState.baseContent,
        remoteContent: headState.remoteContent,
      });
      isConflictOpenRef.current = true;
      setSaveStatus("unsaved");
      return;
    }
    if (headState.outcome === "adopted") {
      setFileMetadata((prev) =>
        prev ? { ...prev, headRevisionId: headState.headRevisionId } : prev,
      );
    }

    try {
      const updated = await driveService.updateFile(
        fileMetadata.id,
        content,
        documentTitle,
      );
      // Merge instead of replace: update responses omit fields like
      // parents, and losing them would misplace later image uploads.
      setFileMetadata((prev) => (prev ? { ...prev, ...updated } : updated));
      setLastSyncedContent(content);
      // Best effort: keep the organization search index fresh.
      if (companionUrl) {
        void indexForSearch(companionUrl, {
          fileId: fileMetadata.id,
          name: documentTitle,
          content,
        });
      }
      setSaveStatus("saved");
    } catch (err) {
      console.error("Save failed:", err);
      // Offline: queue the save and replay it on reconnect instead of
      // surfacing a hard error the user cannot act on.
      const queued = isNetworkError(err)
        ? await tryQueueOfflineSave({
            fileId: fileMetadata.id,
            name: documentTitle,
            content,
            baseRevisionId: fileMetadata.headRevisionId ?? null,
            baseContent: lastSyncedContentRef.current,
          })
        : false;
      if (queued) {
        setSaveStatus("offline");
        return;
      }
      setSaveStatus("error");
    }
  }, [companionUrl, content, documentTitle, fileMetadata]);

  // Replays queued offline saves when the network returns. The first
  // conflict opens the merge dialog; the rest stay queued.
  const replayOfflineSaves = useCallback(async () => {
    let queued: OfflineSaveEntry[];
    try {
      queued = await listQueuedSaves();
    } catch {
      return; // no queue support (private mode): nothing to replay
    }
    if (queued.length === 0) return;
    const result = await replayQueuedSaves(queued, {
      fetchHeadRevisionId: (fileId) => driveService.fetchHeadRevisionId(fileId),
      getFile: (fileId) => driveService.getFile(fileId),
      updateFile: (fileId, content, name) =>
        driveService.updateFile(fileId, content, name),
    });
    for (const entry of result.replayed) {
      await removeQueuedSave(entry.fileId);
      if (fileMetadata?.id === entry.fileId) {
        // The open document reached Drive; refresh its synced base.
        const updated = await driveService
          .getFile(entry.fileId)
          .catch(() => null);
        if (updated) {
          setFileMetadata((prev) =>
            prev ? { ...prev, ...updated.metadata } : updated.metadata,
          );
          setLastSyncedContent(updated.content);
        }
        setSaveStatus("saved");
      }
    }
    const conflict = result.conflicts[0];
    if (conflict && !isConflictOpenRef.current) {
      if (conflict.entry.fileId === fileMetadata?.id) {
        setConflict({
          baseContent: conflict.entry.baseContent,
          remoteContent: conflict.remoteContent,
        });
        isConflictOpenRef.current = true;
        setSaveStatus("unsaved");
        await removeQueuedSave(conflict.entry.fileId);
      }
      // Conflicts on other files stay queued; they surface when those
      // files open and save.
    }
    if (
      result.replayed.length > 0 &&
      result.conflicts.length === 0 &&
      result.failures.length === 0 &&
      fileMetadata
    ) {
      setSaveStatus((status) => (status === "offline" ? "saved" : status));
    }
  }, [fileMetadata]);

  useEffect(() => {
    const onOnline = () => {
      void replayOfflineSaves();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [replayOfflineSaves]);

  // Auto-save timers must call the latest save handler; a plain closure
  // would capture stale content from the render that scheduled the timer.
  const saveDocumentRef = useRef(handleSaveDocument);
  useEffect(() => {
    saveDocumentRef.current = handleSaveDocument;
  }, [handleSaveDocument]);

  // Write the resolved content from the conflict dialog to Drive
  const handleResolveConflict = useCallback(
    async (resolvedContent: string) => {
      if (!fileMetadata) return;
      exitSuggestModeSilently();
      setConflict(null);
      isConflictOpenRef.current = false;
      setSaveStatus("saving");
      try {
        const updated = await driveService.updateFile(
          fileMetadata.id,
          resolvedContent,
          documentTitle,
        );
        setFileMetadata((prev) => (prev ? { ...prev, ...updated } : updated));
        setContent(resolvedContent);
        persistDraft(documentTitle, resolvedContent);
        setLastSyncedContent(resolvedContent);
        setSaveStatus("saved");
      } catch (err) {
        console.error("Failed to save merged content:", err);
        setSaveStatus("error");
      }
    },
    [documentTitle, exitSuggestModeSilently, fileMetadata],
  );

  // Dismiss the conflict dialog without saving
  const handleDismissConflict = useCallback(() => {
    setConflict(null);
    isConflictOpenRef.current = false;
    setSaveStatus("unsaved");
  }, []);

  // Load the revision list for the open Drive file
  const loadHistory = useCallback(async (fileId: string) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const revisions = await driveService.listRevisions(fileId);
      setHistoryRevisions(revisions);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Unknown error");
      setHistoryRevisions([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const handleOpenHistory = useCallback(async () => {
    setIsHistoryOpen(true);
    setHistorySelectedId(null);
    setHistorySelectedContent(null);
    if (fileMetadata) {
      await loadHistory(fileMetadata.id);
    }
  }, [fileMetadata, loadHistory]);

  const handleSelectRevision = useCallback(
    async (revisionId: string) => {
      if (!fileMetadata) return;
      // Only revisions from the loaded history can be previewed, so the id
      // is always one Drive returned and never an arbitrary string.
      if (!historyRevisions.some((revision) => revision.id === revisionId)) {
        setHistoryError("Unknown revision");
        return;
      }
      setHistorySelectedId(revisionId);
      setHistorySelectedContent(null);
      setHistoryError(null);
      try {
        const revisionContent = await driveService.getRevisionContent(
          fileMetadata.id,
          revisionId,
        );
        setHistorySelectedContent(revisionContent);
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [fileMetadata, historyRevisions],
  );

  const handleRestoreRevision = useCallback(
    async (revisionId: string) => {
      if (!fileMetadata) return;
      // Restoring accepts only ids from the loaded revision list.
      if (!historyRevisions.some((revision) => revision.id === revisionId)) {
        setHistoryError("Unknown revision");
        return;
      }
      if (saveStatus === "unsaved") {
        const confirmRestore = window.confirm(
          "You have unsaved changes. Restore the selected version anyway?",
        );
        if (!confirmRestore) return;
      }
      // Restoring replaces the document; pending suggestions cannot apply.
      exitSuggestModeSilently();
      try {
        // restoreRevision writes the selected content to Drive as a new
        // revision, then we mirror it locally.
        await driveService.restoreRevision(fileMetadata.id, revisionId);
        const restored = await driveService.getFile(fileMetadata.id);
        setFileMetadata((prev) =>
          prev ? { ...prev, ...restored.metadata } : restored.metadata,
        );
        setContent(restored.content);
        // The local draft cache is not written here: the restored text comes
        // straight from Drive, and the cache refreshes on the next edit.
        setLastSyncedContent(restored.content);
        setSaveStatus("saved");
        await loadHistory(fileMetadata.id);
        setHistorySelectedId(null);
        setHistorySelectedContent(null);
      } catch (err) {
        console.error("Failed to restore revision:", err);
        setHistoryError(err instanceof Error ? err.message : "Unknown error");
      }
    },
    [
      exitSuggestModeSilently,
      fileMetadata,
      historyRevisions,
      loadHistory,
      saveStatus,
    ],
  );

  // Load the recent Markdown file list
  const loadFileList = useCallback(async () => {
    setFileBrowserLoading(true);
    setFileBrowserError(null);
    try {
      const files = await driveService.listMarkdownFiles();
      setFileBrowserFiles(files);
    } catch (err) {
      setFileBrowserError(err instanceof Error ? err.message : "Unknown error");
      setFileBrowserFiles([]);
    } finally {
      setFileBrowserLoading(false);
    }
  }, []);

  const handleOpenFileBrowser = useCallback(async () => {
    setIsFileBrowserOpen(true);
    await loadFileList();
  }, [loadFileList]);

  // Switch to another Drive document without leaving the app
  const handleOpenFile = useCallback(
    async (fileId: string) => {
      if (saveStatus === "unsaved") {
        const confirmSwitch = window.confirm(
          "You have unsaved changes. Open another file anyway?",
        );
        if (!confirmSwitch) return;
      }
      // The new document replaces the text; suggestions do not carry over.
      exitSuggestModeSilently();
      setSaveStatus("saving");
      try {
        const result = await driveService.getFile(fileId);
        setFileMetadata(result.metadata);
        setDocumentTitle(result.metadata.name);
        setContent(result.content);
        // The draft cache is not written here: opened Drive content stays out
        // of local storage until the user edits, which refreshes the cache.
        setLastSyncedContent(result.content);
        setSaveStatus("saved");
        setIsFileBrowserOpen(false);
        updateUrlFileId(fileId);
        setSelectedCommentId(null);
        setComments([]);
        await loadComments(fileId);
      } catch (err) {
        console.error("Failed to open file:", err);
        setSaveStatus("error");
      }
    },
    [exitSuggestModeSilently, loadComments, saveStatus],
  );

  // Resolve a relative Markdown link against the document's Drive folder
  const handleOpenDocLink = useCallback(
    async (target: string) => {
      const name = target.split("#")[0] ?? target;
      if (!name) return;
      const folderId = fileMetadata?.parents?.[0];
      if (!folderId) {
        window.alert(
          "Cross-document links need a file opened from a Drive folder.",
        );
        return;
      }
      const cacheKey = `${folderId}/${name.toLowerCase()}`;
      let fileId: string | null | undefined =
        docLinkCacheRef.current.get(cacheKey);
      if (fileId === undefined) {
        try {
          // Wikilinks name documents without the .md extension.
          const candidates = /\.(md|markdown)$/i.test(name)
            ? [name]
            : [name, `${name}.md`, `${name}.markdown`];
          for (const candidate of candidates) {
            const found = await driveService.findFileInFolder(
              candidate,
              folderId,
            );
            fileId = found;
            if (fileId) break;
          }
          docLinkCacheRef.current.set(cacheKey, fileId ?? null);
        } catch (err) {
          console.error("Failed to resolve document link:", err);
          window.alert("Could not resolve the linked file. Check the folder.");
          return;
        }
      }
      if (!fileId) {
        window.alert(`No file named "${name}" exists in the document folder.`);
        return;
      }
      await handleOpenFile(fileId);
    },
    [fileMetadata, handleOpenFile],
  );

  // Handle document content change & auto-save
  const handleContentChange = (newContent: string) => {
    setContent(newContent);

    // In suggestion mode the edit is a proposal: keep it in the editor
    // only, never in the draft cache or the autosave pipeline.
    if (editingModeRef.current === "suggest") return;

    setSaveStatus("unsaved");
    // Draft persistence is best effort; keep editing when the quota is full.
    persistDraft(documentTitle, newContent);

    if (settings.autoSaveIntervalMs > 0) {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
      autoSaveTimerRef.current = setTimeout(() => {
        saveDocumentRef.current();
      }, settings.autoSaveIntervalMs);
    }
  };

  // Pending suggestion hunks, shown in the suggestion banner.
  const pendingSuggestionHunks = useMemo(
    () =>
      editingMode === "suggest" && suggestionBase !== null
        ? buildSuggestionHunks(suggestionBase, content)
        : [],
    [editingMode, suggestionBase, content],
  );

  const handleEditingModeChange = (mode: EditingMode) => {
    if (mode === editingMode) return;

    if (mode === "suggest") {
      // A pending autosave must not fire while suggestions accumulate.
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      setSuggestionBase(content);
      setSuggestionError(null);
      setEditingMode("suggest");
      return;
    }

    const hasPending = suggestionBase !== null && content !== suggestionBase;
    if (hasPending && suggestionBase !== null) {
      const confirmDiscard = window.confirm(
        "Discard unsubmitted suggestions and return to direct editing?",
      );
      if (!confirmDiscard) return;
      setContent(suggestionBase);
    }
    exitSuggestModeSilently();
  };

  const handleSubmitSuggestions = async () => {
    if (suggestionBase === null) return;
    const hunks = buildSuggestionHunks(suggestionBase, content);
    if (hunks.length === 0) {
      exitSuggestModeSilently();
      return;
    }

    const firstHunk = hunks[0];
    const quotedText =
      firstHunk && firstHunk.contextBefore.length > 0
        ? firstHunk.contextBefore[firstHunk.contextBefore.length - 1]
        : undefined;
    const anchorLine = firstHunk ? firstHunk.anchorLine + 1 : undefined;

    const fileId = fileMetadata?.id || "local_draft";
    try {
      const newComment = await commentsService.createComment(
        fileId,
        serializeSuggestions(hunks),
        quotedText,
        anchorLine,
      );
      setComments((prev) => [newComment, ...prev]);
      setContent(suggestionBase);
      exitSuggestModeSilently();
      setIsCommentsOpen(true);
      setSelectedCommentId(newComment.id);
    } catch (err) {
      console.error("Failed to submit suggestions:", err);
      setSuggestionError(
        "Submitting suggestions failed. Check your connection and try again.",
      );
    }
  };

  const handleDiscardSuggestions = () => {
    if (suggestionBase !== null) setContent(suggestionBase);
    exitSuggestModeSilently();
  };

  // Applies one hunk from a suggestion comment to the live document.
  const handleAcceptSuggestionHunk = async (
    commentId: string,
    hunkId: string,
  ): Promise<"applied" | "unresolvable"> => {
    const comment = comments.find((c) => c.id === commentId);
    const hunks = comment ? parseSuggestions(comment.content) : null;
    const hunk = hunks?.find((h) => h.id === hunkId);
    if (!hunk) return "unresolvable";

    const result = applySuggestionHunks(content, [hunk]);
    const status = result.results[0]?.status ?? "unresolvable";
    if (status === "applied") {
      handleContentChange(result.content);
    }
    return status;
  };

  const handleAcceptAllSuggestions = async (commentId: string) => {
    const comment = comments.find((c) => c.id === commentId);
    const hunks = comment ? parseSuggestions(comment.content) : null;
    if (!hunks || hunks.length === 0) return;

    const result = applySuggestionHunks(content, hunks);
    if (result.results.some((r) => r.status === "applied")) {
      handleContentChange(result.content);
    }
    if (result.results.every((r) => r.status === "applied")) {
      await handleReplyComment(commentId, "Accepted all suggested changes");
      await handleResolveComment(commentId);
    }
  };

  const handleRejectSuggestion = async (commentId: string) => {
    const fileId = fileMetadata?.id || "local_draft";
    try {
      await commentsService.createReply(
        fileId,
        commentId,
        "Rejected suggestion",
        "resolve",
      );
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? { ...c, resolved: true } : c)),
      );
    } catch (err) {
      console.error("Failed to reject suggestion:", err);
    }
  };

  // Handle document title change
  const handleTitleChange = async (newTitle: string) => {
    const formatted = newTitle.endsWith(".md") ? newTitle : `${newTitle}.md`;
    setDocumentTitle(formatted);
    persistDraft(formatted, content);

    if (fileMetadata) {
      try {
        const updated = await driveService.renameFile(
          fileMetadata.id,
          formatted,
        );
        // Merge instead of replace: rename responses omit fields like
        // parents, and losing them would misplace later image uploads.
        setFileMetadata((prev) => (prev ? { ...prev, ...updated } : updated));
      } catch (err) {
        console.error("Failed to rename Drive file:", err);
      }
    }
  };

  // Create new document
  const handleNewDocument = async () => {
    if (saveStatus === "unsaved") {
      const confirmNew = window.confirm(
        "You have unsaved changes. Create a new document anyway?",
      );
      if (!confirmNew) return;
    }
    exitSuggestModeSilently();

    try {
      setSaveStatus("saving");
      const newFile = await driveService.createFile(
        "Untitled.md",
        "# Untitled Document\n\n",
      );
      setFileMetadata(newFile);
      setDocumentTitle(newFile.name);
      setContent("# Untitled Document\n\n");
      setLastSyncedContent("# Untitled Document\n\n");
      setSaveStatus("saved");
      updateUrlFileId(newFile.id);
      await loadComments(newFile.id);
    } catch (err) {
      console.error("Failed to create new file:", err);
      setSaveStatus("error");
    }
  };

  // Create a new document from a template, expanding its variables
  const handleCreateFromTemplate = async (template: DocumentTemplate) => {
    if (saveStatus === "unsaved") {
      const confirmNew = window.confirm(
        "You have unsaved changes. Create a new document anyway?",
      );
      if (!confirmNew) return;
    }
    exitSuggestModeSilently();

    let templateContent = template.content;
    if (template.fileId) {
      // Organization templates fetch their content from Drive on use.
      const result = await driveService.getFile(template.fileId);
      templateContent = result.content;
    }

    const variables = {
      date: new Date().toISOString().slice(0, 10),
      author: user?.displayName || "Unknown author",
      title: documentTitle.replace(/\.md$/i, ""),
    };
    const expanded = expandTemplateVariables(templateContent, variables);

    try {
      setSaveStatus("saving");
      const fileName = `${template.name}.md`.replace(/\s+/g, " ").trim();
      const newFile = await driveService.createFile(fileName, expanded);
      setFileMetadata(newFile);
      setDocumentTitle(newFile.name);
      setContent(expanded);
      setLastSyncedContent(expanded);
      persistDraft(newFile.name, expanded);
      setSaveStatus("saved");
      updateUrlFileId(newFile.id);
      setSelectedCommentId(null);
      setComments([]);
      await loadComments(newFile.id);
    } catch (err) {
      console.error("Failed to create file from template:", err);
      setSaveStatus("error");
      throw err;
    }
  };

  // Insert a snippet at the cursor with variables expanded
  const handleInsertSnippet = (snippetContent: string) => {
    const expanded = expandTemplateVariables(snippetContent, {
      date: new Date().toISOString().slice(0, 10),
      author: user?.displayName || "Unknown author",
      title: documentTitle.replace(/\.md$/i, ""),
    });
    editorRef.current?.insertBlock(expanded);
  };

  // Export every Markdown file in the document's Drive folder as a
  // browsable single-file static site.
  const handleExportStaticSite = async () => {
    const folderId = fileMetadata?.parents?.[0];
    if (!folderId) {
      window.alert("Open a file from a Drive folder to export its site.");
      return;
    }
    try {
      const files = await driveService.listMarkdownFilesInFolder(folderId);
      const pages: StaticSitePage[] = [];
      for (const file of files.slice(0, 25)) {
        if (!file.id) continue;
        try {
          const result = await driveService.getFile(file.id);
          pages.push({ name: file.name, content: result.content });
        } catch {
          // Files that fail to load are left out of the site.
        }
      }
      if (pages.length === 0) {
        window.alert("No readable Markdown files in this folder.");
        return;
      }
      await exportAsStaticSite(documentTitle.replace(/\.md$/i, ""), pages);
    } catch (err) {
      console.error("Static site export failed:", err);
      window.alert(
        err instanceof Error ? err.message : "Static site export failed.",
      );
    }
  };

  // Comments Handlers
  // Review activity reaches the tools the team already watches (item
  // 30), best effort through the companion when it is configured.
  const notifyReviewActivity = (event: string, text: string) => {
    if (!companionUrl || !fileMetadata?.id) return;
    void notifyIntegration(companionUrl, {
      event,
      fileId: fileMetadata.id,
      text: `${documentTitle}: ${text}`,
    });
  };

  const handleCreateComment = async (
    commentText: string,
    quotedText?: string,
    line?: number,
  ) => {
    const fileId = fileMetadata?.id || "local_draft";
    const newComment = await commentsService.createComment(
      fileId,
      commentText,
      quotedText,
      line,
    );
    setComments((prev) => [newComment, ...prev]);
    setIsCommentsOpen(true);
    setSelectedCommentId(newComment.id);
    notifyReviewActivity(
      "review.comment",
      commentText.slice(0, 200) || "new comment",
    );
  };

  const handleReplyComment = async (commentId: string, replyText: string) => {
    const fileId = fileMetadata?.id || "local_draft";
    const newReply = await commentsService.createReply(
      fileId,
      commentId,
      replyText,
    );
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? { ...c, replies: [...(c.replies || []), newReply] }
          : c,
      ),
    );
  };

  const handleResolveComment = async (commentId: string) => {
    const fileId = fileMetadata?.id || "local_draft";
    await commentsService.createReply(
      fileId,
      commentId,
      "Resolved discussion",
      "resolve",
    );
    setComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, resolved: true } : c)),
    );
    notifyReviewActivity("review.resolved", "a discussion was resolved");
  };

  const handleReopenComment = async (commentId: string) => {
    const fileId = fileMetadata?.id || "local_draft";
    await commentsService.createReply(
      fileId,
      commentId,
      "Reopened discussion",
      "reopen",
    );
    setComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, resolved: false } : c)),
    );
  };

  const handleDeleteComment = async (commentId: string) => {
    const fileId = fileMetadata?.id || "local_draft";
    await commentsService.deleteComment(fileId, commentId);
    setComments((prev) => prev.filter((c) => c.id !== commentId));
    if (selectedCommentId === commentId) {
      setSelectedCommentId(null);
    }
  };

  // Interactive task checkbox in the preview writes back to the source
  const handleToggleTask = (lineNumber: number, checked: boolean) => {
    const updated = toggleTaskLine(content, lineNumber, checked);
    if (updated !== content) {
      handleContentChange(updated);
    }
  };

  // Upload pasted or dropped images to Drive and reference them inline
  const handleImagePaste = async (files: File[]) => {
    if (!fileMetadata) {
      window.alert(
        "Image upload needs a Google Drive document. Sign in and open a Drive file first.",
      );
      return;
    }
    try {
      for (const file of files) {
        const uploaded = await driveService.uploadImageFile(
          file,
          fileMetadata.parents?.[0],
        );
        const altText = uploaded.name.replace(/[[\]]/g, "");
        // The thumbnail endpoint renders Drive-hosted images in the browser
        // more reliably than the legacy uc?export=view URLs.
        const imageMarkdown = `![${altText}](https://drive.google.com/thumbnail?id=${uploaded.id}&sz=w2000)`;
        editorRef.current?.insertText(`${imageMarkdown}\n\n`, "", "");
      }
      editorRef.current?.focus();
    } catch (err) {
      console.error("Image upload failed:", err);
      window.alert(err instanceof Error ? err.message : "Image upload failed.");
    }
  };

  // Frontmatter fields shown in the properties panel
  const frontmatterFields = useMemo(
    () => parseFrontmatter(content).fields,
    [content],
  );

  // Review status pill in the header, from the frontmatter field
  const reviewStatus = useMemo(() => {
    const value = frontmatterFields[REVIEW_STATUS_FIELD];
    return typeof value === "string" && value ? value : null;
  }, [frontmatterFields]);

  // Table context toolbar actions rewrite the table block around the cursor
  const handleTableAction = (action: TableAction) => {
    const updated = applyTableAction(content, tableContext?.line ?? 0, action);
    if (updated !== content) {
      handleContentChange(updated);
    }
  };

  const handleUpdateFrontmatterField = (key: string, value: string) => {
    const updated = updateFrontmatterField(content, key, value);
    if (updated !== content) {
      handleContentChange(updated);
    }
  };

  // Structure tools: section moves, numbering, and generated TOC
  const [headingNumbering, setHeadingNumbering] = useState(false);

  const handleMoveSection = (headingLine: number, offset: -1 | 1) => {
    const updated = moveSectionBy(content, headingLine, offset);
    if (updated !== content) {
      handleContentChange(updated);
    }
  };

  const handleToggleNumbering = () => {
    const next = !headingNumbering;
    setHeadingNumbering(next);
    const updated = numberHeadings(content, next);
    if (updated !== content) {
      handleContentChange(updated);
    }
  };

  const handleInsertTableOfContents = () => {
    const toc = generateTableOfContents(content);
    if (toc) {
      editorRef.current?.insertBlock(toc);
    }
  };

  // Synchronized Scrolling Handlers
  const handleEditorScroll = (pct: number) => {
    if (settings.syncScroll && viewMode === "split") {
      previewRef.current?.scrollToPercentage(pct);
    }
  };

  const handlePreviewScroll = (pct: number) => {
    if (settings.syncScroll && viewMode === "split") {
      editorRef.current?.scrollToPercentage(pct);
    }
  };

  // Jump to heading in TOC outline
  const handleSelectHeading = (item: OutlineItem) => {
    editorRef.current?.scrollToLine(item.line);
    previewRef.current?.scrollToHeading(item.id);
  };

  // Keyboard Shortcuts: Ctrl+S for Save, Ctrl+Alt+M for Comment
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSaveDocument();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.altKey &&
        (e.key === "m" || e.key === "M")
      ) {
        e.preventDefault();
        setIsNewCommentModalOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSaveDocument]);

  const outline = extractOutline(content);
  const openCommentsCount = comments.filter((c) => !c.resolved).length;

  return (
    <div
      data-ui-language={uiLanguage}
      className="flex flex-col h-screen w-screen overflow-hidden bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-sans"
    >
      {/* App Header */}
      <AppHeader
        documentTitle={documentTitle}
        onChangeTitle={handleTitleChange}
        saveStatus={saveStatus}
        editingMode={editingMode}
        onChangeEditingMode={handleEditingModeChange}
        reviewStatus={reviewStatus}
        onOpenReviewQueue={() => setIsReviewQueueOpen(true)}
        onOpenTemplates={() => setIsTemplatesOpen(true)}
        onOpenGraph={() => setIsGraphOpen(true)}
        onPresent={() => setIsPresentOpen(true)}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        zoom={settings.fontSize}
        user={user}
        fileMetadata={fileMetadata}
        isDark={isDark}
        onToggleTheme={() => setIsDark(!isDark)}
        onSave={handleSaveDocument}
        onNewDocument={handleNewDocument}
        onOpenFileBrowser={handleOpenFileBrowser}
        onOpenExportModal={() => setIsExportOpen(true)}
        onToggleOutline={() => setIsOutlineOpen(!isOutlineOpen)}
        richView={settings.richView}
        onToggleRichView={() =>
          setSettings((prev) => ({ ...prev, richView: !prev.richView }))
        }
        aiEnabled={settings.ai.enabled && AI_BUILD_ENABLED}
        collabPeers={collabPeers}
        isAIOpen={isAIOpen}
        onToggleAI={() => setIsAIOpen((open) => !open)}
        isOutlineOpen={isOutlineOpen}
        onOpenHistory={handleOpenHistory}
        isHistoryOpen={isHistoryOpen}
        onOpenProperties={() => setIsPropertiesOpen(true)}
        onToggleComments={() => setIsCommentsOpen(!isCommentsOpen)}
        isCommentsOpen={isCommentsOpen}
        openCommentsCount={openCommentsCount}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onSignIn={() => authService.signIn()}
        onSignOut={() => authService.signOut()}
      />

      {/* Drive change notification banner (companion webhooks) */}
      {driveChangeNotice && (
        <div className="flex items-center justify-between gap-3 px-4 py-1.5 bg-sky-50 dark:bg-sky-950/30 border-b border-sky-200 dark:border-sky-900 text-xs no-print">
          <div className="flex items-center gap-2 text-sky-800 dark:text-sky-200">
            <CloudDownload className="w-3.5 h-3.5 shrink-0" />
            <span>{t("collab.changed")}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void handleReloadFromDrive()}
              className="px-2.5 py-1 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-medium"
            >
              {t("collab.reload")}
            </button>
            <button
              onClick={() => setDriveChangeNotice(false)}
              className="px-2.5 py-1 rounded-md border border-sky-300 dark:border-sky-800 text-sky-700 dark:text-sky-300 text-[11px] font-medium hover:bg-sky-100 dark:hover:bg-sky-900/40"
            >
              {t("collab.dismiss")}
            </button>
          </div>
        </div>
      )}

      {/* Suggestion mode banner: edits are recorded, not saved */}
      {editingMode === "suggest" && (
        <div className="flex items-center justify-between gap-3 px-4 py-1.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-xs no-print">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
            <span className="font-medium">Suggesting.</span>
            <span className="hidden sm:inline">{t("suggest.banner")}</span>
            <span>
              {pendingSuggestionHunks.length === 1
                ? t("suggest.pending.one", {
                    count: pendingSuggestionHunks.length,
                  })
                : t("suggest.pending.many", {
                    count: pendingSuggestionHunks.length,
                  })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDiscardSuggestions}
              className="px-2.5 py-1 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium transition"
            >
              {t("suggest.discard")}
            </button>
            <button
              onClick={() => void handleSubmitSuggestions()}
              disabled={pendingSuggestionHunks.length === 0}
              className="px-2.5 py-1 rounded-md bg-amber-500 hover:bg-amber-600 text-white font-medium disabled:opacity-50 transition"
            >
              {t("suggest.submit")}
            </button>
          </div>
        </div>
      )}

      {editingMode === "suggest" && suggestionError && (
        <div className="px-4 py-1.5 bg-rose-50 dark:bg-rose-950/30 border-b border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300 no-print">
          {suggestionError}
        </div>
      )}

      {/* Editor Toolbar */}
      <EditorToolbar
        onInsert={(before, after, defaultText) =>
          editorRef.current?.insertText(before, after, defaultText)
        }
        onInsertBlock={(text) => editorRef.current?.insertBlock(text)}
        onOpenTableModal={() => setIsTableModalOpen(true)}
        onOpenComment={() => setIsNewCommentModalOpen(true)}
        onOpenSearch={() => editorRef.current?.openSearch()}
        hasSelection={Boolean(selection?.text)}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
      />

      {/* Workspace Area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Outline Sidebar */}
        <OutlineSidebar
          isOpen={isOutlineOpen}
          onClose={() => setIsOutlineOpen(false)}
          outline={outline}
          onSelectHeading={handleSelectHeading}
          onMoveSection={handleMoveSection}
          numberingEnabled={headingNumbering}
          onToggleNumbering={handleToggleNumbering}
          onInsertTableOfContents={handleInsertTableOfContents}
        />

        {/* Code Editor Pane */}
        {showEditorPane && (
          <div
            className={`editor-pane h-full overflow-hidden relative ${
              viewMode === "split" && !isMobile ? "w-1/2" : "w-full"
            }`}
          >
            <CodeMirrorEditor
              ref={editorRef}
              value={content}
              onChange={handleContentChange}
              isDark={isDark}
              fontSize={settings.fontSize}
              richView={settings.richView}
              onScroll={handleEditorScroll}
              onSelectionChange={setSelection}
              onImagePaste={handleImagePaste}
              onTableCursorChange={setTableContext}
            />

            {/* Floating Add Comment tooltip */}
            <FloatingCommentButton
              selection={selection}
              onAddComment={() => setIsNewCommentModalOpen(true)}
            />

            {/* Table context toolbar while the cursor is inside a table */}
            {tableContext && (
              <TableToolbar
                columnIndex={tableContext.column}
                onAction={handleTableAction}
              />
            )}
          </div>
        )}

        {/* Markdown Live Preview Pane */}
        {showPreviewPane && (
          <div
            className={`preview-container preview-canvas h-full overflow-hidden ${
              viewMode === "split" && !isMobile ? "w-1/2" : "w-full"
            }`}
          >
            <MarkdownPreview
              ref={previewRef}
              content={content}
              comments={comments}
              isDark={isDark}
              fontSize={settings.fontSize}
              onScroll={handlePreviewScroll}
              onSelectComment={(id) => {
                setIsCommentsOpen(true);
                setSelectedCommentId(id);
              }}
              onToggleTask={handleToggleTask}
              onOpenDocLink={handleOpenDocLink}
            />
          </div>
        )}

        {/* Mobile single-pane switch */}
        {isMobile && viewMode === "split" && (
          <button
            onClick={() =>
              setMobilePane((pane) =>
                pane === "editor" ? "preview" : "editor",
              )
            }
            title={
              mobilePane === "editor"
                ? t("mobile.showPreview")
                : t("mobile.showEditor")
            }
            aria-label={
              mobilePane === "editor"
                ? t("mobile.showPreview")
                : t("mobile.showEditor")
            }
            className="fixed bottom-4 right-4 z-40 p-3 rounded-full bg-brand-600 hover:bg-brand-700 text-white shadow-lg no-print"
          >
            {mobilePane === "editor" ? (
              <Eye className="w-5 h-5" />
            ) : (
              <PenLine className="w-5 h-5" />
            )}
          </button>
        )}

        {/* AI assistant panel; only mounted when the build allows it */}
        <AIPanel
          isOpen={isAIOpen && AI_BUILD_ENABLED}
          onClose={() => setIsAIOpen(false)}
          settings={settings.ai}
          context={{
            document: content,
            selection: selection?.text ?? null,
            commentThreads: aiThreadSnippets,
            previousRevision: historySelectedContent,
          }}
          onInsertAtCursor={(text) => editorRef.current?.replaceSelection(text)}
          onReplaceDocument={(text) => editorRef.current?.replaceDocument(text)}
          onApplySuggestion={handleAISuggestion}
        />

        {/* Google Drive Comments Sidebar Drawer */}
        <CommentsSidebar
          isOpen={isCommentsOpen}
          onClose={() => setIsCommentsOpen(false)}
          comments={comments}
          fileId={fileMetadata?.id ?? null}
          selectedCommentId={selectedCommentId}
          onSelectComment={setSelectedCommentId}
          onReplyComment={handleReplyComment}
          onResolveComment={handleResolveComment}
          onReopenComment={handleReopenComment}
          onDeleteComment={handleDeleteComment}
          onOpenNewComment={() => setIsNewCommentModalOpen(true)}
          onAcceptSuggestionHunk={handleAcceptSuggestionHunk}
          onAcceptAllSuggestions={handleAcceptAllSuggestions}
          onRejectSuggestion={handleRejectSuggestion}
        />

        {/* Drive Version History Sidebar Drawer */}
        <HistorySidebar
          isOpen={isHistoryOpen}
          onClose={() => setIsHistoryOpen(false)}
          revisions={historyRevisions}
          loading={historyLoading}
          error={historyError}
          selectedId={historySelectedId}
          selectedContent={historySelectedContent}
          currentContent={content}
          comments={comments}
          onSelect={handleSelectRevision}
          onRestore={handleRestoreRevision}
          onRefresh={() => fileMetadata && loadHistory(fileMetadata.id)}
          onSelectComment={(commentId) => {
            setIsCommentsOpen(true);
            setSelectedCommentId(commentId);
          }}
        />
      </div>

      {/* New Comment Modal */}
      <NewCommentModal
        isOpen={isNewCommentModalOpen}
        onClose={() => setIsNewCommentModalOpen(false)}
        selection={selection}
        onSubmit={handleCreateComment}
      />

      {/* Insert Table Modal */}
      <InsertTableModal
        isOpen={isTableModalOpen}
        onClose={() => setIsTableModalOpen(false)}
        onInsertTable={(table) => editorRef.current?.insertBlock(table)}
      />

      {/* Recent Markdown Files Modal */}
      <FileBrowserModal
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
        files={fileBrowserFiles}
        loading={fileBrowserLoading}
        error={fileBrowserError}
        onSelect={handleOpenFile}
        onRefresh={loadFileList}
        companionUrl={companionUrl || undefined}
      />

      {/* Frontmatter Properties Panel */}
      <PropertiesPanel
        isOpen={isPropertiesOpen}
        onClose={() => setIsPropertiesOpen(false)}
        fields={frontmatterFields}
        onUpdateField={handleUpdateFrontmatterField}
      />

      {/* Review queue of documents marked in review */}
      <ReviewQueueModal
        isOpen={isReviewQueueOpen}
        onClose={() => setIsReviewQueueOpen(false)}
        onOpenFile={handleOpenFile}
      />

      {/* Templates and snippets */}
      <TemplatesModal
        isOpen={isTemplatesOpen}
        onClose={() => setIsTemplatesOpen(false)}
        templatesFolderId={settings.templatesFolderId}
        onCreateFromTemplate={handleCreateFromTemplate}
        onInsertSnippet={handleInsertSnippet}
      />

      {/* Folder link graph and backlinks */}
      <GraphModal
        isOpen={isGraphOpen}
        onClose={() => setIsGraphOpen(false)}
        folderId={fileMetadata?.parents?.[0] ?? null}
        currentFileId={fileMetadata?.id ?? null}
        currentFileName={documentTitle}
        onOpenFile={handleOpenFile}
      />

      {/* Slide presentation of the open document */}
      <PresentModal
        isOpen={isPresentOpen}
        onClose={() => setIsPresentOpen(false)}
        content={content}
      />

      {/* Save Conflict Resolution Modal */}
      {conflict !== null && (
        <ConflictModal
          isOpen
          onClose={handleDismissConflict}
          localContent={content}
          remoteContent={conflict.remoteContent}
          baseContent={conflict.baseContent}
          onResolve={handleResolveConflict}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSaveSettings={(newSettings) => {
          setSettings(newSettings);
          authService.setClientId(newSettings.googleClientId);
          safeSetItem(
            LOCAL_STORAGE_SETTINGS_KEY,
            JSON.stringify(toPersistableSettings(newSettings)),
          );
        }}
      />

      {/* Export Modal */}
      <ExportModal
        isOpen={isExportOpen}
        onClose={() => setIsExportOpen(false)}
        documentTitle={documentTitle}
        markdownContent={content}
        onExportStaticSite={
          fileMetadata?.parents?.[0] ? handleExportStaticSite : undefined
        }
        onExportGoogleDocs={handleExportGoogleDocs}
      />
    </div>
  );
};
export default App;
