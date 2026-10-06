import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const ACCESS_TOKEN_KEY = "gdrive_access_token";
const TOKEN_EXPIRY_KEY = "gdrive_token_expiry";

function setRealToken(): void {
  sessionStorage.setItem(ACCESS_TOKEN_KEY, "real_test_token");
  sessionStorage.setItem(
    TOKEN_EXPIRY_KEY,
    (Date.now() + 60 * 60 * 1000).toString(),
  );
}

async function createDriveService(): Promise<
  import("../services/googleDrive").GoogleDriveService
> {
  const { GoogleDriveService } = await import("../services/googleDrive");
  return new GoogleDriveService();
}

describe("GoogleDriveService", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("rejects image uploads in mock mode", async () => {
    const service = await createDriveService();
    const file = new File(["image"], "image.png", { type: "image/png" });

    await expect(service.uploadImageFile(file)).rejects.toThrow(
      "Image upload requires signing in to Google Drive.",
    );
  });

  it("uploads an image with multipart metadata and content", async () => {
    setRealToken();
    const service = await createDriveService();
    const metadata = {
      id: "image_123",
      name: "diagram.png",
      mimeType: "image/png",
      webViewLink: "https://drive.google.com/file/image_123",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(metadata), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["image bytes"], "diagram.png", {
      type: "image/png",
    });

    await expect(service.uploadImageFile(file, "folder_123")).resolves.toEqual(
      metadata,
    );

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected image upload request");
    const request = call[1] as RequestInit;
    expect(call[0]).toBe(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink",
    );
    expect(request.method).toBe("POST");
    expect(new Headers(request.headers).get("Authorization")).toBe(
      "Bearer real_test_token",
    );
    expect(new Headers(request.headers).get("Content-Type")).toContain(
      "multipart/related",
    );
    const body = await (request.body as Blob).text();
    expect(body).toContain('"name":"diagram.png"');
    expect(body).toContain('"mimeType":"image/png"');
    expect(body).toContain('"parents":["folder_123"]');
    expect(body).toContain("image bytes");
  });

  it("requests head revision fields when updating a real file", async () => {
    setRealToken();
    const service = await createDriveService();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "file_123",
          name: "notes.md",
          mimeType: "text/markdown",
          headRevisionId: "abc",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await service.updateFile("file_123", "content", "notes.md");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected update request");
    const request = call[1] as RequestInit;
    expect(String(call[0])).toContain("headRevisionId");
    expect(request.method).toBe("PATCH");
    expect(new Headers(request.headers).get("Authorization")).toBe(
      "Bearer real_test_token",
    );
  });

  it("fetches the real head revision ID", async () => {
    setRealToken();
    const service = await createDriveService();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ headRevisionId: "abc" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.fetchHeadRevisionId("file_123")).resolves.toBe("abc");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected head revision request");
    expect(call[0]).toBe(
      "https://www.googleapis.com/drive/v3/files/file_123?fields=headRevisionId",
    );
    expect(
      new Headers((call[1] as RequestInit).headers).get("Authorization"),
    ).toBe("Bearer real_test_token");
  });

  it("tracks mock revisions and restores their content", async () => {
    const service = await createDriveService();
    const created = await service.createFile("notes", "version 1");

    expect(created.headRevisionId).toBe("mock_rev_1");

    await service.updateFile(created.id, "version 2");
    await service.updateFile(created.id, "version 3");
    await service.updateFile(created.id, "version 4");

    const revisions = await service.listRevisions(created.id);
    expect(revisions.map((revision) => revision.id)).toEqual([
      "mock_rev_4",
      "mock_rev_3",
      "mock_rev_2",
      "mock_rev_1",
    ]);
    expect(await service.getRevisionContent(created.id, "mock_rev_1")).toBe(
      "version 1",
    );
    expect(await service.getRevisionContent(created.id, "mock_rev_2")).toBe(
      "version 2",
    );
    expect(await service.getRevisionContent(created.id, "mock_rev_3")).toBe(
      "version 3",
    );
    expect(await service.getRevisionContent(created.id, "mock_rev_4")).toBe(
      "version 4",
    );

    await service.restoreRevision(created.id, "mock_rev_1");
    expect((await service.getFile(created.id)).content).toBe("version 1");
    expect(await service.fetchHeadRevisionId(created.id)).toBe("mock_rev_5");
  });

  it("rejects malformed ids before building revision request URLs", async () => {
    const service = await createDriveService();
    await expect(service.listRevisions("file?x=1")).rejects.toThrow(
      "Invalid file id",
    );
    await expect(
      service.getRevisionContent("file_123", "../etc"),
    ).rejects.toThrow("Invalid revision id");
  });

  it("rejects malformed ids at every service entry point", async () => {
    const service = await createDriveService();
    await expect(service.getFile("bad/id")).rejects.toThrow("Invalid file id");
    await expect(service.getFile("https://attacker.invalid")).rejects.toThrow(
      "Invalid file id",
    );
    await expect(service.updateFile("bad id", "x")).rejects.toThrow(
      "Invalid file id",
    );
    await expect(
      service.createFile("name", "content", "folder?"),
    ).rejects.toThrow("Invalid folder id");
    await expect(service.fetchHeadRevisionId("..")).rejects.toThrow(
      "Invalid file id",
    );
  });

  it("keeps metadata and content requests on the Google Drive origin", async () => {
    setRealToken();
    const service = await createDriveService();
    const metadata = {
      id: "file_123",
      name: "notes.md",
      mimeType: "text/markdown",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(metadata), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("# Notes", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.getFile("file_123")).resolves.toEqual({
      metadata,
      content: "# Notes",
    });

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => url.origin)).toEqual([
      "https://www.googleapis.com",
      "https://www.googleapis.com",
    ]);
    expect(urls[0]?.searchParams.get("fields")).toBe(
      "id,name,mimeType,modifiedTime,webViewLink,parents,capabilities,headRevisionId",
    );
    expect(urls[1]?.searchParams.get("alt")).toBe("media");
  });

  it("rejects Drive request URLs with an unexpected origin", async () => {
    setRealToken();
    const service = await createDriveService();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    class UnexpectedOriginURL extends URL {
      override get origin() {
        return "https://attacker.invalid";
      }
    }
    vi.stubGlobal("URL", UnexpectedOriginURL);

    await expect(service.getFile("file_123")).rejects.toThrow(
      "Invalid Google Drive URL",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists real revisions newest first across pages", async () => {
    setRealToken();
    const service = await createDriveService();
    // Drive returns the oldest revisions first, so page one carries rev_1.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            revisions: [{ id: "rev_1", modifiedTime: "2026-01-01T00:00:00Z" }],
            nextPageToken: "page_2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            revisions: [{ id: "rev_2", modifiedTime: "2026-01-02T00:00:00Z" }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.listRevisions("file_123")).resolves.toEqual([
      { id: "rev_2", modifiedTime: "2026-01-02T00:00:00Z" },
      { id: "rev_1", modifiedTime: "2026-01-01T00:00:00Z" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0];
    const secondCall = fetchMock.mock.calls[1];
    if (!firstCall || !secondCall) {
      throw new Error("Expected revisions requests");
    }
    const fields =
      "fields=nextPageToken,revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))&pageSize=100";
    expect(firstCall[0]).toBe(
      `https://www.googleapis.com/drive/v3/files/file_123/revisions?${fields}`,
    );
    expect(secondCall[0]).toBe(
      `https://www.googleapis.com/drive/v3/files/file_123/revisions?${fields}&pageToken=page_2`,
    );
    expect(
      new Headers((firstCall[1] as RequestInit).headers).get("Authorization"),
    ).toBe("Bearer real_test_token");
  });

  it("gets real revision content", async () => {
    setRealToken();
    const service = await createDriveService();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("saved revision", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.getRevisionContent("file_123", "rev_1")).resolves.toBe(
      "saved revision",
    );

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected revision content request");
    expect(call[0]).toBe(
      "https://www.googleapis.com/drive/v3/files/file_123/revisions/rev_1?alt=media",
    );
    expect(
      new Headers((call[1] as RequestInit).headers).get("Authorization"),
    ).toBe("Bearer real_test_token");
  });

  it("lists mock markdown files from the mock store", async () => {
    const service = await createDriveService();
    await service.createFile("notes", "a");
    await service.createFile("report", "b");

    const files = await service.listMarkdownFiles();
    expect(files.map((file) => file.name)).toEqual(
      expect.arrayContaining(["notes.md", "report.md"]),
    );
    expect(files.every((file) => /(?:\.md|\.markdown)$/.test(file.name))).toBe(
      true,
    );
  });

  it("lists real markdown files most recently viewed first", async () => {
    setRealToken();
    const service = await createDriveService();
    const files = [{ id: "file_1", name: "notes.md" }];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ files }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.listMarkdownFiles()).resolves.toEqual(files);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected file list request");
    const requestUrl = String(call[0]);
    expect(requestUrl).toContain("https://www.googleapis.com/drive/v3/files?");
    expect(requestUrl).toContain("orderBy=viewedByMeTime desc");
    expect(requestUrl).toContain("text%2Fmarkdown");
    expect(
      new Headers((call[1] as RequestInit).headers).get("Authorization"),
    ).toBe("Bearer real_test_token");
  });

  it("finds a mock file by name inside a folder", async () => {
    const service = await createDriveService();
    const created = await service.createFile("notes", "content", "folder_1");

    expect(created.parents).toEqual(["folder_1"]);
    await expect(
      service.findFileInFolder("notes.md", "folder_1"),
    ).resolves.toBe(created.id);
    await expect(
      service.findFileInFolder("Notes.MD", "folder_1"),
    ).resolves.toBe(created.id);
    await expect(
      service.findFileInFolder("missing.md", "folder_1"),
    ).resolves.toBe(null);
  });

  it("finds a real file by name inside a folder", async () => {
    setRealToken();
    const service = await createDriveService();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ files: [{ id: "file_9", name: "notes.md" }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      service.findFileInFolder("notes.md", "folder_1"),
    ).resolves.toBe("file_9");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected folder search request");
    const requestUrl = String(call[0]);
    expect(requestUrl).toContain("https://www.googleapis.com/drive/v3/files?");
    // encodeURIComponent leaves apostrophes literal (they are unreserved),
    // so the Drive query keeps its single quotes after encoding.
    expect(requestUrl).toContain("name%20%3D%20'notes.md'");
    expect(requestUrl).toContain("'folder_1'%20in%20parents");
    expect(
      new Headers((call[1] as RequestInit).headers).get("Authorization"),
    ).toBe("Bearer real_test_token");
  });
});
