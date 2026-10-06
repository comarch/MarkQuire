import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerRequest = {
  method: string;
  url: string;
};

type WorkerEvent = {
  request: WorkerRequest;
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (promise: Promise<unknown>) => void;
};

type WorkerListener = (event: WorkerEvent) => void;

const workerSource = readFileSync(
  resolve(process.cwd(), "public/sw.js"),
  "utf8",
);

function loadFetchHandler(caches: object, fetcher: unknown): WorkerListener {
  const listeners = new Map<string, WorkerListener>();
  const self = {
    location: new URL("https://markquire.test"),
    clients: { claim: vi.fn() },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: WorkerListener) => {
      listeners.set(type, listener);
    },
  };

  runInNewContext(workerSource, { self, caches, fetch: fetcher, URL, Promise });
  const handler = listeners.get("fetch");
  if (!handler) throw new Error("Fetch listener was not registered");
  return handler;
}

describe("service worker cache writes", () => {
  it.each([
    ["/assets/app.js", "markquire-shell-v1"],
    ["/index.html", "markquire-runtime-v1"],
  ])("keeps the cache write alive for %s", async (path, cacheName) => {
    let finishCacheWrite = () => {};
    const cacheWrite = new Promise<void>((resolveWrite) => {
      finishCacheWrite = resolveWrite;
    });
    const cachePut = vi.fn(() => cacheWrite);
    const cache = { put: cachePut };
    const caches = {
      match: vi.fn(async () => undefined),
      open: vi.fn(async () => cache),
    };
    const fetcher = vi.fn(async () => new Response("network"));
    const handler = loadFetchHandler(caches, fetcher);
    const request = {
      method: "GET",
      url: `https://markquire.test${path}`,
    };
    const respondWith = vi.fn<(response: Promise<Response>) => void>();
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

    handler({ request, respondWith, waitUntil });

    const responsePromise = respondWith.mock.calls[0]?.[0];
    const cacheLifetimePromise = waitUntil.mock.calls[0]?.[0];
    if (!responsePromise || !cacheLifetimePromise) {
      throw new Error(
        "Fetch listener did not register response and cache promises",
      );
    }

    const response = await responsePromise;
    await expect(response.text()).resolves.toBe("network");
    await vi.waitFor(() => expect(caches.open).toHaveBeenCalledWith(cacheName));
    await vi.waitFor(() => expect(cachePut).toHaveBeenCalledOnce());

    const lifetimeFinished = vi.fn();
    void cacheLifetimePromise.then(lifetimeFinished);
    await Promise.resolve();
    expect(lifetimeFinished).not.toHaveBeenCalled();

    finishCacheWrite();
    await cacheLifetimePromise;
    expect(lifetimeFinished).toHaveBeenCalledOnce();
  });
});
