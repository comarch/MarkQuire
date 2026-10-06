import { DriveFileMetadata, DriveRevision } from "../types/drive";
import { authService } from "./googleAuth";

const GOOGLE_API_ORIGIN = "https://www.googleapis.com";
const DRIVE_API_BASE = `${GOOGLE_API_ORIGIN}/drive/v3`;
const UPLOAD_API_BASE = "https://www.googleapis.com/upload/drive/v3";

// Local mock storage for offline / testing without Google credentials
const MOCK_FILES_KEY = "gdrive_mock_files";

// Drive ids are opaque base64url tokens. Validate them before interpolating
// into request URLs so a malformed id from the drive state cannot alter it.
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function assertValidDriveId(id: string, label: string): void {
  if (!DRIVE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}`);
  }
}

function buildDriveFileUrl(
  fileId: string,
  params: Record<string, string>,
): string {
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  if (url.origin !== GOOGLE_API_ORIGIN) {
    throw new Error("Invalid Google Drive URL");
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

interface MockFileEntry {
  metadata: DriveFileMetadata;
  content: string;
  revisions?: MockRevisionEntry[];
}

interface MockRevisionEntry {
  revision: DriveRevision;
  content: string;
}

function getMockStorage(): Record<string, MockFileEntry> {
  try {
    const raw = localStorage.getItem(MOCK_FILES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveMockStorage(store: Record<string, MockFileEntry>): void {
  localStorage.setItem(MOCK_FILES_KEY, JSON.stringify(store));
}

export class GoogleDriveService {
  /**
   * Fetches file content and metadata from Google Drive
   */
  public async getFile(
    fileId: string,
  ): Promise<{ content: string; metadata: DriveFileMetadata }> {
    assertValidDriveId(fileId, "file id");
    const token = authService.getAccessToken();

    // Check mock storage if token is mock or no real token
    if (!token || token.startsWith("mock_google_token_")) {
      const store = getMockStorage();
      if (store[fileId]) {
        return store[fileId];
      }
      // Return a default entry
      return {
        metadata: {
          id: fileId,
          name: "Untitled.md",
          mimeType: "text/markdown",
          modifiedTime: new Date().toISOString(),
          capabilities: { canEdit: true, canComment: true },
        },
        content: "# Untitled Document\n\nStart writing markdown here...\n",
      };
    }

    // 1. Fetch metadata
    const metaRes = await fetch(
      buildDriveFileUrl(fileId, {
        fields:
          "id,name,mimeType,modifiedTime,webViewLink,parents,capabilities,headRevisionId",
      }),
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!metaRes.ok) {
      throw new Error(`Failed to load file metadata: ${metaRes.statusText}`);
    }

    const metadata: DriveFileMetadata = await metaRes.json();

    // 2. Fetch file content
    const contentRes = await fetch(
      buildDriveFileUrl(fileId, { alt: "media" }),
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!contentRes.ok) {
      throw new Error(
        `Failed to download file content: ${contentRes.statusText}`,
      );
    }

    const content = await contentRes.text();
    return { metadata, content };
  }

  /**
   * Updates file content and/or name in Google Drive
   */
  public async updateFile(
    fileId: string,
    content: string,
    name?: string,
  ): Promise<DriveFileMetadata> {
    assertValidDriveId(fileId, "file id");
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const store = getMockStorage();
      const existing = store[fileId] || {
        metadata: {
          id: fileId,
          name: name || "Untitled.md",
          mimeType: "text/markdown",
          capabilities: { canEdit: true, canComment: true },
        },
        content: "",
        revisions: [],
      };

      const revisions = existing.revisions ?? [];
      const modifiedTime = new Date().toISOString();
      const revision: MockRevisionEntry = {
        revision: {
          id: `mock_rev_${revisions.length + 1}`,
          modifiedTime,
          lastModifyingUser: { displayName: "Demo User" },
        },
        content,
      };
      revisions.push(revision);
      if (revisions.length > 50) {
        revisions.shift();
      }
      existing.revisions = revisions;
      existing.content = content;
      if (name) existing.metadata.name = name;
      existing.metadata.modifiedTime = modifiedTime;
      existing.metadata.headRevisionId = revision.revision.id;
      store[fileId] = existing;
      saveMockStorage(store);
      return existing.metadata;
    }

    // Multipart upload to update both content and metadata (if name changed)
    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadataPart = JSON.stringify({
      name: name,
      mimeType: "text/markdown",
      modifiedTime: new Date().toISOString(),
    });

    const multipartRequestBody =
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      metadataPart +
      delimiter +
      "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
      content +
      closeDelimiter;

    const res = await fetch(
      `${UPLOAD_API_BASE}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,parents,capabilities,headRevisionId`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartRequestBody,
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to update file on Google Drive: ${res.statusText}`,
      );
    }

    return await res.json();
  }

  /**
   * Creates a new Markdown file on Google Drive
   */
  public async createFile(
    name: string,
    content: string,
    folderId?: string,
  ): Promise<DriveFileMetadata> {
    if (folderId !== undefined) {
      assertValidDriveId(folderId, "folder id");
    }
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const id = "mock_file_" + Math.random().toString(36).substring(2, 10);
      const metadata: DriveFileMetadata = {
        id,
        name: name.endsWith(".md") ? name : `${name}.md`,
        mimeType: "text/markdown",
        modifiedTime: new Date().toISOString(),
        parents: folderId ? [folderId] : undefined,
        capabilities: { canEdit: true, canComment: true },
        headRevisionId: "mock_rev_1",
      };
      const store = getMockStorage();
      store[id] = {
        metadata,
        content,
        revisions: [
          {
            revision: {
              id: "mock_rev_1",
              modifiedTime: metadata.modifiedTime,
              lastModifyingUser: { displayName: "Demo User" },
            },
            content,
          },
        ],
      };
      saveMockStorage(store);
      return metadata;
    }

    const metadata: Record<string, unknown> = {
      name: name.endsWith(".md") ? name : `${name}.md`,
      mimeType: "text/markdown",
    };

    if (folderId) {
      metadata.parents = [folderId];
    }

    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartRequestBody =
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) +
      delimiter +
      "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
      content +
      closeDelimiter;

    const res = await fetch(
      `${UPLOAD_API_BASE}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink,capabilities,parents,headRevisionId`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartRequestBody,
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to create file on Google Drive: ${res.statusText}`,
      );
    }

    return await res.json();
  }

  /**
   * Creates a Google Docs file from Markdown. Drive performs the import
   * conversion: the file resource requests the Docs target type while
   * the media part stays Markdown, so the stored source of truth never
   * leaves the browser.
   */
  public async createGoogleDocsFile(
    name: string,
    content: string,
    folderId?: string,
  ): Promise<DriveFileMetadata> {
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const id =
        "mock_docs_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const metadata: DriveFileMetadata = {
        id,
        name: name.replace(/\.(md|markdown|docx)$/i, ""),
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: new Date().toISOString(),
        parents: folderId ? [folderId] : undefined,
        webViewLink: `https://docs.google.com/document/d/${id}/edit`,
        capabilities: { canEdit: true, canComment: true },
      };
      return metadata;
    }

    const metadata: Record<string, unknown> = {
      name: name.replace(/\.(md|markdown|docx)$/i, ""),
      mimeType: "application/vnd.google-apps.document",
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartRequestBody =
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) +
      delimiter +
      "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
      content +
      closeDelimiter;

    const res = await fetch(
      `${UPLOAD_API_BASE}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink,capabilities,parents`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartRequestBody,
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to create Google Docs file: ${res.statusText}`);
    }

    return await res.json();
  }

  /**
   * Lists Markdown files the app may open, most recently viewed first.
   *
   * With the drive.file scope this returns files the app created or opened
   * before; files it never touched need the Drive UI or Picker.
   */
  public async listMarkdownFiles(): Promise<DriveFileMetadata[]> {
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const store = getMockStorage();
      return Object.values(store)
        .filter(
          (entry) =>
            entry.metadata.mimeType === "text/markdown" ||
            /\.(md|markdown)$/i.test(entry.metadata.name),
        )
        .sort((a, b) =>
          (b.metadata.modifiedTime ?? "").localeCompare(
            a.metadata.modifiedTime ?? "",
          ),
        )
        .map((entry) => entry.metadata);
    }

    const query = encodeURIComponent(
      "mimeType = 'text/markdown' or name contains '.md' or name contains '.markdown'",
    );
    const res = await fetch(
      `${DRIVE_API_BASE}/files?q=${query}&orderBy=viewedByMeTime desc&pageSize=50&fields=nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents,capabilities,headRevisionId)`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to list Markdown files: ${res.statusText}`);
    }

    const data = (await res.json()) as { files?: DriveFileMetadata[] };
    return data.files ?? [];
  }

  /**
   * Lists Markdown files inside a specific Drive folder, for example the
   * configured organization template folder.
   */
  public async listMarkdownFilesInFolder(
    folderId: string,
  ): Promise<DriveFileMetadata[]> {
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const store = getMockStorage();
      return Object.values(store)
        .filter(
          (entry) =>
            entry.metadata.parents?.includes(folderId) &&
            (entry.metadata.mimeType === "text/markdown" ||
              /\.(md|markdown)$/i.test(entry.metadata.name)),
        )
        .map((entry) => entry.metadata);
    }

    const query = encodeURIComponent(
      `'${folderId}' in parents and (mimeType = 'text/markdown' or name contains '.md' or name contains '.markdown')`,
    );
    const res = await fetch(
      `${DRIVE_API_BASE}/files?q=${query}&orderBy=name&pageSize=50&fields=files(id,name,mimeType,modifiedTime,webViewLink,parents,capabilities,headRevisionId)`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to list folder files: ${res.statusText}`);
    }

    const data = (await res.json()) as { files?: DriveFileMetadata[] };
    return data.files ?? [];
  }

  /**
   * Finds a file by exact name inside a Drive folder.
   *
   * Returns null when nothing matches, so callers can show a clear reason.
   */
  public async findFileInFolder(
    name: string,
    folderId: string,
  ): Promise<string | null> {
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const store = getMockStorage();
      const entry = Object.values(store).find(
        (candidate) =>
          candidate.metadata.parents?.includes(folderId) &&
          candidate.metadata.name.toLowerCase() === name.toLowerCase(),
      );
      return entry?.metadata.id ?? null;
    }

    // Escape backslashes first so they cannot dodge the quote escaping,
    // then escape single quotes for the Drive query syntax.
    const escapedName = name
      .replace(/\\/g, String.raw`\\`)
      .replace(/'/g, String.raw`\'`);
    const query = encodeURIComponent(
      `name = '${escapedName}' and '${folderId}' in parents`,
    );
    const res = await fetch(
      `${DRIVE_API_BASE}/files?q=${query}&fields=files(id,name)&pageSize=5`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to search the folder: ${res.statusText}`);
    }

    const data = (await res.json()) as { files?: { id: string }[] };
    return data.files?.[0]?.id ?? null;
  }

  /**
   * Fetches the current head revision ID for a file.
   */
  public async fetchHeadRevisionId(fileId: string): Promise<string | null> {
    assertValidDriveId(fileId, "file id");
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      return getMockStorage()[fileId]?.metadata.headRevisionId ?? null;
    }

    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=headRevisionId`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to load file revision metadata: ${res.statusText}`,
      );
    }

    const data = (await res.json()) as { headRevisionId?: string };
    return data.headRevisionId ?? null;
  }

  /**
   * Lists file revisions without their content, newest first.
   */
  public async listRevisions(fileId: string): Promise<DriveRevision[]> {
    assertValidDriveId(fileId, "file id");
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const entry = getMockStorage()[fileId];
      return (
        entry?.revisions
          ?.slice()
          .reverse()
          .map(({ revision }) => revision) ?? []
      );
    }

    const revisions: DriveRevision[] = [];
    let pageToken: string | undefined;
    do {
      // Files commonly carry more than 100 revisions, so walk every page.
      const query =
        "fields=nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))&pageSize=100" +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const res = await fetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/revisions?${query}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!res.ok) {
        throw new Error(`Failed to list file revisions: ${res.statusText}`);
      }

      const data = (await res.json()) as {
        revisions?: DriveRevision[];
        nextPageToken?: string;
      };
      revisions.push(...(data.revisions ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    // Drive returns revisions oldest-first; the app expects newest-first.
    return revisions.reverse();
  }

  /**
   * Fetches content for one file revision.
   */
  public async getRevisionContent(
    fileId: string,
    revisionId: string,
  ): Promise<string> {
    assertValidDriveId(fileId, "file id");
    assertValidDriveId(revisionId, "revision id");
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const revision = getMockStorage()[fileId]?.revisions?.find(
        ({ revision: storedRevision }) => storedRevision.id === revisionId,
      );
      if (!revision) {
        throw new Error("Revision not found");
      }
      return revision.content;
    }

    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?alt=media`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to load revision content: ${res.statusText}`);
    }

    return await res.text();
  }

  /**
   * Restores a revision by saving its content as a new revision.
   */
  public async restoreRevision(
    fileId: string,
    revisionId: string,
  ): Promise<DriveFileMetadata> {
    const content = await this.getRevisionContent(fileId, revisionId);
    return await this.updateFile(fileId, content);
  }

  /**
   * Uploads an image file to Google Drive.
   */
  public async uploadImageFile(
    file: File,
    folderId?: string,
  ): Promise<DriveFileMetadata> {
    if (folderId !== undefined) {
      assertValidDriveId(folderId, "folder id");
    }
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      throw new Error("Image upload requires signing in to Google Drive.");
    }

    const metadata: Record<string, unknown> = {
      name: file.name,
      mimeType: file.type,
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;
    const fileContent = await file.arrayBuffer();
    const multipartRequestBody = new Blob(
      [
        delimiter +
          "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
          JSON.stringify(metadata) +
          delimiter +
          `Content-Type: ${file.type}\r\n\r\n`,
        fileContent,
        closeDelimiter,
      ],
      { type: `multipart/related; boundary=${boundary}` },
    );

    const res = await fetch(
      `${UPLOAD_API_BASE}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartRequestBody,
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to upload image to Google Drive: ${res.statusText}`,
      );
    }

    return await res.json();
  }

  /**
   * Renames a file on Google Drive
   */
  public async renameFile(
    fileId: string,
    newName: string,
  ): Promise<DriveFileMetadata> {
    assertValidDriveId(fileId, "file id");
    const token = authService.getAccessToken();

    if (!token || token.startsWith("mock_google_token_")) {
      const store = getMockStorage();
      if (store[fileId]) {
        store[fileId].metadata.name = newName;
        saveMockStorage(store);
        return store[fileId].metadata;
      }
      return { id: fileId, name: newName, mimeType: "text/markdown" };
    }

    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,headRevisionId`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: newName }),
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to rename file: ${res.statusText}`);
    }

    return await res.json();
  }
}

export const driveService = new GoogleDriveService();
