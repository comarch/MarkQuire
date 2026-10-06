import { driveService } from "./googleDrive";

// Wikilink and backlink indexing for one Drive folder. Building the
// index costs one list call plus one fetch per file, so it is capped
// and cached per session folder.

export interface OutgoingLink {
  target: string;
  kind: "wikilink" | "md-link";
}

export interface Backlink {
  fromId: string;
  fromName: string;
}

export interface GraphNode {
  id: string;
  name: string;
  isCurrent: boolean;
}

export interface GraphEdge {
  fromId: string;
  toId: string;
}

export interface FolderGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Link targets that no folder file matches. */
  unresolved: string[];
}

export interface FolderDocument {
  id: string;
  name: string;
  content: string;
}

const WIKILINK_PATTERN = /\[\[([^\]|]{1,400})(?:\|[^\]]{0,400})?\]\]/g;
const MAX_INDEXED_FILES = 25;

function findMarkdownLinkTargets(line: string): string[] {
  const targets: string[] = [];
  let searchFrom = 0;
  let closingParenthesis = -1;
  let closingParenthesisSearchFrom = 0;

  while (searchFrom < line.length) {
    const labelStart = line.indexOf("[", searchFrom);
    if (labelStart === -1) break;
    const labelEnd = line.indexOf("]", labelStart + 1);
    if (labelEnd === -1) break;
    if (line[labelEnd + 1] !== "(") {
      searchFrom = labelEnd + 1;
      continue;
    }

    const targetStart = labelEnd + 2;
    if (targetStart >= closingParenthesisSearchFrom) {
      closingParenthesis = line.indexOf(")", targetStart);
      closingParenthesisSearchFrom =
        closingParenthesis === -1 ? line.length : closingParenthesis + 1;
    }
    const targetEnd = closingParenthesis;
    if (targetEnd === -1) {
      searchFrom = labelEnd + 1;
      continue;
    }

    const target = line.slice(targetStart, targetEnd);
    if (target.length === 0 || target.length > 2000 || /\s/.test(target)) {
      searchFrom = labelEnd + 1;
      continue;
    }

    targets.push(target);
    searchFrom = targetEnd + 1;
  }

  return targets;
}

function stripExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "");
}

function normalizeTarget(target: string): string {
  return stripExtension(target.split("#")[0] ?? target)
    .trim()
    .toLowerCase();
}

function scanOutsideFences(
  content: string,
  scanLine: (line: string) => void,
): void {
  let fence: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trimStart();
    if (fence === null) {
      if (/^(```|~~~)/.test(trimmed)) {
        fence = trimmed.slice(0, 3);
        continue;
      }
    } else {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    scanLine(line);
  }
}

/**
 * Extracts wikilink and relative Markdown link targets from a document,
 * skipping fenced code. Targets keep no extension and no fragment.
 */
export function scanOutgoingLinks(content: string): OutgoingLink[] {
  const links: OutgoingLink[] = [];

  scanOutsideFences(content, (line) => {
    for (const match of line.matchAll(WIKILINK_PATTERN)) {
      const name = match[1]?.trim();
      if (name) links.push({ target: name, kind: "wikilink" });
    }
    for (const href of findMarkdownLinkTargets(line)) {
      if (
        !href ||
        /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:)/i.test(href) ||
        !/\.(md|markdown)(#.*)?$/i.test(href)
      ) {
        continue;
      }
      links.push({ target: href, kind: "md-link" });
    }
  });

  return links;
}

/**
 * Lists documents in the folder whose outgoing links point at the named
 * document.
 */
export function computeBacklinks(
  currentName: string,
  documents: FolderDocument[],
): Backlink[] {
  const wanted = normalizeTarget(currentName);
  const backlinks: Backlink[] = [];

  for (const doc of documents) {
    if (normalizeTarget(doc.name) === wanted) continue;
    const links = scanOutgoingLinks(doc.content);
    if (links.some((link) => normalizeTarget(link.target) === wanted)) {
      backlinks.push({ fromId: doc.id, fromName: doc.name });
    }
  }
  return backlinks;
}

/**
 * Builds the folder-level link graph: every Markdown file is a node,
 * every resolved outgoing link is an edge. Results cache per folder for
 * the session, because building costs one fetch per file.
 */
const graphCache = new Map<string, FolderGraph>();

// Files that fail to load stay as isolated nodes so the graph keeps them.
async function loadFolderDocument(
  id: string,
  name: string,
): Promise<FolderDocument> {
  try {
    const result = await driveService.getFile(id);
    return { id, name, content: result.content };
  } catch {
    return { id, name, content: "" };
  }
}

export async function buildFolderGraph(
  folderId: string,
  currentFileId: string | null,
): Promise<FolderGraph> {
  const cacheKey = `${folderId}/${currentFileId ?? "none"}`;
  const cached = graphCache.get(cacheKey);
  if (cached) return cached;

  const files = await driveService.listMarkdownFilesInFolder(folderId);
  const inspected = files.slice(0, MAX_INDEXED_FILES);
  const documents: FolderDocument[] = [];

  for (const file of inspected) {
    if (!file.id) continue;
    documents.push(await loadFolderDocument(file.id, file.name));
  }

  const byNormalizedName = new Map<string, string>();
  for (const doc of documents) {
    byNormalizedName.set(normalizeTarget(doc.name), doc.id);
  }

  const nodes: GraphNode[] = documents.map((doc) => ({
    id: doc.id,
    name: doc.name,
    isCurrent: doc.id === currentFileId,
  }));

  const edges: GraphEdge[] = [];
  const unresolved = new Set<string>();
  const seen = new Set<string>();

  for (const doc of documents) {
    for (const link of scanOutgoingLinks(doc.content)) {
      const normalized = normalizeTarget(link.target);
      const toId = byNormalizedName.get(normalized);
      if (!toId) {
        unresolved.add(link.target);
        continue;
      }
      const key = `${doc.id}->${toId}`;
      if (doc.id === toId || seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromId: doc.id, toId });
    }
  }

  const graph: FolderGraph = { nodes, edges, unresolved: [...unresolved] };
  graphCache.set(cacheKey, graph);
  return graph;
}
