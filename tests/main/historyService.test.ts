import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryRecord, JobLogEntry } from "@shared/ipc";
import { HistoryService } from "../../src/main/services/historyService";

// The electron mock resolves app.getPath("userData") from this env var at
// construction time, so each test gets a pristine store.
const createService = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "s3ream-hist-"));
  vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
  return { service: new HistoryService(), dir, file: path.join(dir, "history.json") };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const makeRecord = (overrides: Partial<HistoryRecord> & { id: string }): HistoryRecord => ({
  filePath: `/videos/${overrides.id}.mp4`,
  fileName: `${overrides.id}.mp4`,
  fileHash: null,
  basePrefix: "uploads",
  renditions: ["720p"],
  queueMode: "batch",
  status: "completed",
  manifestUrl: null,
  warnings: [],
  error: null,
  queuedAt: 1,
  startedAt: null,
  completedAt: null,
  ...overrides,
});

const makeLog = (index: number): JobLogEntry => ({
  id: `log-${index}`,
  jobId: "job-1",
  timestamp: index,
  stage: "Converting",
  message: `entry ${index}`,
  status: "processing",
});

describe("HistoryService persistence", () => {
  it("creates the store file on first run", () => {
    const { file } = createService();
    expect(existsSync(file)).toBe(true);
  });

  it("recovers from a corrupt history file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(path.join(tmpdir(), "s3ream-hist-"));
    vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
    writeFileSync(path.join(dir, "history.json"), "not valid json{", "utf-8");
    const service = new HistoryService();
    expect(service.listJobs()).toEqual({ records: [], total: 0 });
    const rewritten = JSON.parse(readFileSync(path.join(dir, "history.json"), "utf-8"));
    expect(rewritten).toEqual({ jobs: [], logs: [] });
    warn.mockRestore();
  });

  it("moves a corrupt history file aside instead of destroying it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(path.join(tmpdir(), "s3ream-hist-"));
    vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
    const file = path.join(dir, "history.json");
    writeFileSync(file, "not valid json{", "utf-8");
    const service = new HistoryService();
    expect(service.listJobs()).toEqual({ records: [], total: 0 });

    const movedAside = readdirSync(dir).filter((name) => name.startsWith("history.json.corrupt-"));
    expect(movedAside).toHaveLength(1);
    expect(readFileSync(path.join(dir, movedAside[0] ?? ""), "utf-8")).toBe("not valid json{");
    // The fresh store is written atomically; no temp file is left behind.
    expect(existsSync(`${file}.tmp`)).toBe(false);
    warn.mockRestore();
  });
});

describe("HistoryService.upsertJob", () => {
  it("inserts new records and merges updates by id", () => {
    const { service } = createService();
    service.upsertJob(makeRecord({ id: "job-1", status: "processing", fileName: "clip.mp4" }));
    // The update only carries changed fields; the rest must survive the merge.
    service.upsertJob({
      id: "job-1",
      status: "completed",
      manifestUrl: "https://cdn.example.com/clip/master.m3u8",
      completedAt: 100,
    } as HistoryRecord);

    const { records, total } = service.listJobs();
    expect(total).toBe(1);
    expect(records[0]?.status).toBe("completed");
    expect(records[0]?.manifestUrl).toBe("https://cdn.example.com/clip/master.m3u8");
    // Fields omitted from the update keep their previous values.
    expect(records[0]?.fileName).toBe("clip.mp4");
  });

  it("caps the store at 2000 records, keeping the newest", () => {
    const { service } = createService();
    for (let i = 0; i < 2001; i += 1) {
      service.upsertJob(makeRecord({ id: `job-${i}`, completedAt: i + 1 }));
    }
    const { records, total } = service.listJobs({ limit: 5000 });
    expect(total).toBe(2000);
    expect(records).toHaveLength(2000);
    expect(records.some((record) => record.id === "job-0")).toBe(false);
    expect(records.some((record) => record.id === "job-2000")).toBe(true);
  });
});

describe("HistoryService.listJobs", () => {
  it("searches case-insensitively across file name, path, and prefix", () => {
    const { service } = createService();
    service.upsertJob(
      makeRecord({
        id: "a",
        fileName: "Summer Trip.MP4",
        filePath: "/videos/Summer Trip.MP4",
        basePrefix: "archive/2024",
        completedAt: 1,
      }),
    );
    service.upsertJob(
      makeRecord({ id: "b", fileName: "notes.mp4", basePrefix: "misc", completedAt: 2 }),
    );

    expect(service.listJobs({ search: "summer" }).total).toBe(1);
    expect(service.listJobs({ search: "TRIP.mp4" }).total).toBe(1);
    expect(service.listJobs({ search: "ARCHIVE" }).total).toBe(1);
    expect(service.listJobs({ search: "missing" }).total).toBe(0);
  });

  it("filters by status and paginates with an accurate total", () => {
    const { service } = createService();
    service.upsertJob(makeRecord({ id: "a", status: "completed", completedAt: 3 }));
    service.upsertJob(makeRecord({ id: "b", status: "completed", completedAt: 2 }));
    service.upsertJob(makeRecord({ id: "c", status: "failed", completedAt: 1 }));

    const completed = service.listJobs({ status: "completed" });
    expect(completed.total).toBe(2);

    const page1 = service.listJobs({ limit: 2, offset: 0 });
    expect(page1.records).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = service.listJobs({ limit: 2, offset: 2 });
    expect(page2.records).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it("sorts by completion time, newest first", () => {
    const { service } = createService();
    service.upsertJob(makeRecord({ id: "old", completedAt: 1 }));
    service.upsertJob(makeRecord({ id: "new", completedAt: 9 }));
    const { records } = service.listJobs();
    expect(records.map((record) => record.id)).toEqual(["new", "old"]);
  });

  it("keeps running jobs at the top of the list", () => {
    const { service } = createService();
    service.upsertJob(makeRecord({ id: "done", status: "completed", completedAt: 1 }));
    service.upsertJob(makeRecord({ id: "running", status: "processing", completedAt: null }));
    const { records } = service.listJobs();
    expect(records.map((record) => record.id)).toEqual(["running", "done"]);
  });
});

describe("HistoryService logs", () => {
  it("debounces log writes until flush", () => {
    const { service, file } = createService();
    service.logEntry(makeLog(1));
    expect(readFileSync(file, "utf-8")).not.toContain("entry 1");
    service.flush();
    expect(readFileSync(file, "utf-8")).toContain("entry 1");
  });

  it("caps logs at 5000 entries, keeping the newest", () => {
    const { service, file } = createService();
    for (let i = 0; i < 5005; i += 1) {
      service.logEntry(makeLog(i));
    }
    service.flush();
    const stored = JSON.parse(readFileSync(file, "utf-8")) as { logs: JobLogEntry[] };
    expect(stored.logs).toHaveLength(5000);
    expect(stored.logs[0]?.id).toBe("log-5");
    expect(stored.logs[4999]?.id).toBe("log-5004");
  });
});

describe("HistoryService.markStaleJobsInterrupted", () => {
  it("fails jobs left in active states and reports the count", () => {
    const { service } = createService();
    service.upsertJob(makeRecord({ id: "pending", status: "pending" }));
    service.upsertJob(makeRecord({ id: "processing", status: "processing" }));
    service.upsertJob(makeRecord({ id: "uploading", status: "uploading" }));
    service.upsertJob(makeRecord({ id: "done", status: "completed", completedAt: 42 }));

    const interrupted = service.markStaleJobsInterrupted();
    expect(interrupted).toBe(3);

    const byId = new Map(service.listJobs().records.map((record) => [record.id, record]));
    expect(byId.get("pending")?.status).toBe("failed");
    expect(byId.get("pending")?.error).toBe("Interrupted by app restart");
    expect(byId.get("processing")?.completedAt).not.toBeNull();
    expect(byId.get("done")?.status).toBe("completed");
    expect(byId.get("done")?.completedAt).toBe(42);
  });

  it("is a no-op when nothing is active", () => {
    const { service } = createService();
    service.upsertJob(makeRecord({ id: "done", status: "completed", completedAt: 42 }));
    expect(service.markStaleJobsInterrupted()).toBe(0);
  });
});

describe("HistoryService.findExisting", () => {
  it("finds completed jobs by file path and prefix", () => {
    const { service } = createService();
    service.upsertJob(
      makeRecord({
        id: "done",
        filePath: "/videos/clip.mp4",
        basePrefix: "uploads",
        status: "completed",
        manifestUrl: "https://cdn.example.com/uploads/clip/master.m3u8",
        completedAt: 100,
      }),
    );
    service.upsertJob(
      makeRecord({
        id: "failed",
        filePath: "/videos/other.mp4",
        basePrefix: "uploads",
        status: "failed",
      }),
    );

    expect(service.findExisting("/videos/clip.mp4", "uploads")?.manifestUrl).toBe(
      "https://cdn.example.com/uploads/clip/master.m3u8",
    );
    // Failed jobs and prefix mismatches must not dedupe.
    expect(service.findExisting("/videos/other.mp4", "uploads")).toBeNull();
    expect(service.findExisting("/videos/clip.mp4", "different")).toBeNull();
  });
});
