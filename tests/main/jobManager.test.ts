import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueUpdate, VideoJobResult } from "@shared/ipc";
import {
  deriveObjectKey,
  isVideoFile,
  JobManager,
  normalizePrefix,
  slugify,
} from "../../src/main/services/jobManager";
import { historyService } from "../../src/main/services/historyService";

const h = vi.hoisted(() => {
  class MockJobCanceledError extends Error {
    constructor() {
      super("Job canceled by user");
      this.name = "JobCanceledError";
    }
  }
  return { processVideoJobMock: vi.fn(), MockJobCanceledError };
});

vi.mock("../../src/main/services/videoPipeline", () => ({
  processVideoJob: h.processVideoJobMock,
  JobCanceledError: h.MockJobCanceledError,
}));

beforeEach(() => {
  h.processVideoJobMock.mockReset();
});

const createManager = () => {
  const manager = new JobManager();
  const send = vi.fn();
  const fakeWindow = {
    webContents: { send },
    isDestroyed: () => false,
  } as unknown as BrowserWindow;
  manager.setWindow(fakeWindow);

  const updates = (): QueueUpdate[] =>
    send.mock.calls
      .filter((call) => call[0] === "jobs:update")
      .map((call) => call[1] as QueueUpdate);
  const latestJob = (id: string) => {
    const all = updates();
    return all[all.length - 1]?.jobs.find((job) => job.id === id);
  };
  return { manager, updates, latestJob };
};

const successResult: VideoJobResult = {
  success: true,
  manifestUrl: "https://cdn.example.com/uploads/clip/master.m3u8",
  warnings: [],
  details: "Uploaded 3 files",
};

describe("normalizePrefix", () => {
  it("trims, normalizes separators, and collapses duplicates", () => {
    expect(normalizePrefix(" /a//b/c/ ")).toBe("a/b/c");
    expect(normalizePrefix("a\\b\\c")).toBe("a/b/c");
  });

  it("strips dot segments to prevent path traversal", () => {
    expect(normalizePrefix("a/./b/../c")).toBe("a/b/c");
    expect(normalizePrefix("..")).toBe("");
    expect(normalizePrefix("../../etc")).toBe("etc");
    expect(normalizePrefix(".")).toBe("");
  });
});

describe("slugify", () => {
  it("produces lowercase url-safe slugs", () => {
    expect(slugify("My Vidéo 2024!")).toBe("my-video-2024");
    expect(slugify("  Clip_Final (v2)  ")).toBe("clip_final-v2");
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("deriveObjectKey", () => {
  it("joins prefix and slugified file name", () => {
    expect(deriveObjectKey("uploads", "/videos/My Movie.mp4", new Set())).toBe("uploads/my-movie");
    expect(deriveObjectKey("", "/videos/My Movie.mp4", new Set())).toBe("my-movie");
  });

  it("deduplicates with a counter suffix", () => {
    const existing = new Set(["uploads/my-movie"]);
    expect(deriveObjectKey("uploads", "/videos/My Movie.mp4", existing)).toBe("uploads/my-movie-2");
    expect(deriveObjectKey("uploads", "/videos/My Movie.mp4", existing)).toBe("uploads/my-movie-3");
  });

  it("falls back to 'video' for un-slugifiable names", () => {
    expect(deriveObjectKey("p", "/videos/!!!.mp4", new Set())).toBe("p/video");
  });
});

describe("isVideoFile", () => {
  it("accepts supported containers case-insensitively", () => {
    expect(isVideoFile("/v/clip.MP4")).toBe(true);
    expect(isVideoFile("/v/clip.mkv")).toBe(true);
    expect(isVideoFile("/v/clip.webm")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isVideoFile("/v/notes.txt")).toBe(false);
    expect(isVideoFile("/v/archive.zip")).toBe(false);
    expect(isVideoFile("/v/noextension")).toBe(false);
  });
});

describe("JobManager.enqueue", () => {
  it("rejects an empty object path prefix", async () => {
    const { manager } = createManager();
    await expect(
      manager.enqueue({
        basePrefix: "   ",
        files: [{ filePath: "/videos/a.mp4" }],
        renditions: ["720p"],
        mode: "batch",
      }),
    ).rejects.toThrow(/Object path prefix is required/);
  });

  it("skips unsupported files without starting the pipeline", async () => {
    const { manager, latestJob } = createManager();
    const { jobIds, skipped } = await manager.enqueue({
      basePrefix: "uploads",
      files: [{ filePath: "/docs/skip-me-notes.txt" }],
      renditions: ["720p"],
      mode: "batch",
    });

    expect(skipped).toEqual([
      { filePath: "/docs/skip-me-notes.txt", reason: "unsupported file type" },
    ]);
    expect(latestJob(jobIds[0] ?? "")?.status).toBe("skipped");
    expect(h.processVideoJobMock).not.toHaveBeenCalled();
  });

  it("skips files already completed for the same path and prefix", async () => {
    const filePath = "/videos/duplicate-seed-clip.mp4";
    historyService.upsertJob({
      id: "history-seed-duplicate",
      filePath,
      fileName: "duplicate-seed-clip.mp4",
      fileHash: null,
      basePrefix: "dup-prefix",
      renditions: ["720p"],
      queueMode: "batch",
      status: "completed",
      manifestUrl: "https://cdn.example.com/dup-prefix/duplicate-seed-clip/master.m3u8",
      warnings: [],
      error: null,
      queuedAt: 1,
      startedAt: 1,
      completedAt: 2,
    });

    const { manager, latestJob } = createManager();
    const { jobIds, skipped } = await manager.enqueue({
      basePrefix: "dup-prefix",
      files: [{ filePath }],
      renditions: ["720p"],
      mode: "batch",
    });

    expect(skipped).toEqual([{ filePath, reason: "duplicate" }]);
    expect(latestJob(jobIds[0] ?? "")?.status).toBe("skipped");
    expect(h.processVideoJobMock).not.toHaveBeenCalled();
  });

  it("runs supported files through the pipeline to completion", async () => {
    h.processVideoJobMock.mockResolvedValue(successResult);
    const { manager, updates, latestJob } = createManager();
    const { jobIds } = await manager.enqueue({
      basePrefix: "uploads",
      files: [{ filePath: "/videos/success-run-clip.mp4" }],
      renditions: ["720p"],
      mode: "batch",
    });

    const jobId = jobIds[0] ?? "";
    await vi.waitFor(() => {
      expect(latestJob(jobId)?.status).toBe("completed");
    });
    expect(latestJob(jobId)?.manifestUrl).toBe(successResult.manifestUrl);
    expect(h.processVideoJobMock).toHaveBeenCalledTimes(1);

    const lastUpdate = updates()[updates().length - 1];
    expect(lastUpdate?.totals.completed).toBe(1);
    expect(lastUpdate?.queueStatus).toBe("idle");
  });

  it("marks jobs failed when the pipeline throws", async () => {
    h.processVideoJobMock.mockRejectedValue(new Error("ffmpeg exploded"));
    const { manager, latestJob } = createManager();
    const { jobIds } = await manager.enqueue({
      basePrefix: "uploads",
      files: [{ filePath: "/videos/failing-run-clip.mp4" }],
      renditions: ["720p"],
      mode: "batch",
    });

    const jobId = jobIds[0] ?? "";
    await vi.waitFor(() => {
      expect(latestJob(jobId)?.status).toBe("failed");
    });
    expect(latestJob(jobId)?.error).toBe("ffmpeg exploded");
  });
});

describe("JobManager concurrency", () => {
  const trackConcurrency = () => {
    const state = { active: 0, max: 0 };
    h.processVideoJobMock.mockImplementation(async () => {
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      state.active -= 1;
      return successResult;
    });
    return state;
  };

  const waitForAllCompleted = async (
    updates: () => QueueUpdate[],
    jobIds: string[],
  ): Promise<void> => {
    await vi.waitFor(() => {
      const all = updates();
      const last = all[all.length - 1];
      expect(
        jobIds.every((id) => last?.jobs.find((job) => job.id === id)?.status === "completed"),
      ).toBe(true);
    });
  };

  it("processes jobs sequentially when concurrency is 1", async () => {
    const state = trackConcurrency();
    const { manager, updates } = createManager();
    const { jobIds } = await manager.enqueue({
      basePrefix: "uploads",
      files: [
        { filePath: "/videos/seq-a.mp4" },
        { filePath: "/videos/seq-b.mp4" },
        { filePath: "/videos/seq-c.mp4" },
      ],
      renditions: ["720p"],
      mode: "batch",
      concurrency: 1,
    });

    await waitForAllCompleted(updates, jobIds);
    expect(state.max).toBe(1);
  });

  it("allows parallel jobs when concurrency is raised", async () => {
    const state = trackConcurrency();
    const { manager, updates } = createManager();
    const { jobIds } = await manager.enqueue({
      basePrefix: "uploads",
      files: [
        { filePath: "/videos/par-a.mp4" },
        { filePath: "/videos/par-b.mp4" },
        { filePath: "/videos/par-c.mp4" },
      ],
      renditions: ["720p"],
      mode: "batch",
      concurrency: 3,
    });

    await waitForAllCompleted(updates, jobIds);
    expect(state.max).toBe(3);
  });

  it("clamps concurrency to at least 1 and ignores NaN", async () => {
    const state = trackConcurrency();
    const { manager, updates } = createManager();
    manager.setConcurrency(0); // clamps to 1
    manager.setConcurrency(Number.NaN); // ignored, stays 1
    const { jobIds } = await manager.enqueue({
      basePrefix: "uploads",
      files: [{ filePath: "/videos/clamp-a.mp4" }, { filePath: "/videos/clamp-b.mp4" }],
      renditions: ["720p"],
      mode: "batch",
    });

    await waitForAllCompleted(updates, jobIds);
    expect(state.max).toBe(1);
  });
});

describe("JobManager.control", () => {
  it("cancels the running job via abort signal", async () => {
    h.processVideoJobMock.mockImplementation(
      (_payload: unknown, _emit: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new h.MockJobCanceledError()));
        }),
    );
    const { manager, latestJob } = createManager();
    const { jobIds } = await manager.enqueue({
      basePrefix: "uploads",
      files: [{ filePath: "/videos/cancel-me.mp4" }],
      renditions: ["720p"],
      mode: "batch",
      concurrency: 1,
    });

    const jobId = jobIds[0] ?? "";
    await vi.waitFor(() => {
      expect(latestJob(jobId)?.status).toBe("processing");
    });
    manager.control("cancel-current");
    await vi.waitFor(() => {
      expect(latestJob(jobId)?.status).toBe("canceled");
    });
  });

  it("cancel-remaining marks pending jobs canceled", async () => {
    h.processVideoJobMock.mockImplementation(
      () => new Promise<VideoJobResult>(() => {}), // never resolves
    );
    const { manager, latestJob, updates } = createManager();
    const { jobIds } = await manager.enqueue({
      basePrefix: "uploads",
      files: [{ filePath: "/videos/stuck-a.mp4" }, { filePath: "/videos/stuck-b.mp4" }],
      renditions: ["720p"],
      mode: "batch",
      concurrency: 1,
    });

    await vi.waitFor(() => {
      expect(latestJob(jobIds[0] ?? "")?.status).toBe("processing");
    });
    manager.control("cancel-remaining");
    const last = updates()[updates().length - 1];
    expect(last?.jobs.find((job) => job.id === jobIds[1])?.status).toBe("canceled");
  });

  it("clear-completed removes finished and skipped jobs but keeps failed ones", async () => {
    h.processVideoJobMock.mockRejectedValueOnce(new Error("boom"));
    const { manager, updates, latestJob } = createManager();
    const { jobIds } = await manager.enqueue({
      basePrefix: "uploads",
      files: [{ filePath: "/videos/clear-fail.mp4" }, { filePath: "/docs/clear-skip.txt" }],
      renditions: ["720p"],
      mode: "batch",
    });

    await vi.waitFor(() => {
      expect(latestJob(jobIds[0] ?? "")?.status).toBe("failed");
    });
    manager.control("clear-completed");

    const last = updates()[updates().length - 1];
    expect(last?.jobs.map((job) => job.id)).toEqual([jobIds[0]]);
  });
});

describe("JobManager.processSingle", () => {
  it("rejects a duplicate conversion of the same file and prefix", async () => {
    const resolvers: Array<(value: VideoJobResult) => void> = [];
    h.processVideoJobMock.mockImplementation(
      () =>
        new Promise<VideoJobResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { manager } = createManager();
    const request = {
      filePath: "/videos/single-dupe.mp4",
      basePrefix: "uploads",
      renditions: ["720p"],
    };

    const first = manager.processSingle(request);
    await expect(manager.processSingle(request)).rejects.toThrow(/already being converted/);

    resolvers[0]?.(successResult);
    await expect(first).resolves.toMatchObject({ success: true });

    // Once the first conversion finishes, the same file can be converted again.
    h.processVideoJobMock.mockResolvedValueOnce(successResult);
    await expect(manager.processSingle(request)).resolves.toMatchObject({ success: true });
  });

  it("holds the power-save blocker for the duration of a single conversion", async () => {
    const { powerSaveBlocker } = await import("electron");
    const start = vi.spyOn(powerSaveBlocker, "start");
    const stop = vi.spyOn(powerSaveBlocker, "stop");
    try {
      const resolvers: Array<(value: VideoJobResult) => void> = [];
      h.processVideoJobMock.mockImplementation(
        () =>
          new Promise<VideoJobResult>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      const { manager } = createManager();

      const pending = manager.processSingle({
        filePath: "/videos/single-blocker.mp4",
        basePrefix: "uploads",
        renditions: ["720p"],
      });
      await vi.waitFor(() => {
        expect(start).toHaveBeenCalledTimes(1);
      });
      expect(stop).not.toHaveBeenCalled();

      resolvers[0]?.(successResult);
      await pending;
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      start.mockRestore();
      stop.mockRestore();
    }
  });

  it("shares one power-save blocker across overlapping single conversions", async () => {
    const { powerSaveBlocker } = await import("electron");
    const start = vi.spyOn(powerSaveBlocker, "start");
    const stop = vi.spyOn(powerSaveBlocker, "stop");
    try {
      const resolvers: Array<(value: VideoJobResult) => void> = [];
      h.processVideoJobMock.mockImplementation(
        () =>
          new Promise<VideoJobResult>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      const { manager } = createManager();

      const first = manager.processSingle({
        filePath: "/videos/blocker-a.mp4",
        basePrefix: "uploads",
        renditions: ["720p"],
      });
      const second = manager.processSingle({
        filePath: "/videos/blocker-b.mp4",
        basePrefix: "uploads",
        renditions: ["720p"],
      });
      await vi.waitFor(() => {
        expect(resolvers).toHaveLength(2);
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();

      resolvers[0]?.(successResult);
      await first;
      expect(stop).not.toHaveBeenCalled();

      resolvers[1]?.(successResult);
      await second;
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      start.mockRestore();
      stop.mockRestore();
    }
  });
});
