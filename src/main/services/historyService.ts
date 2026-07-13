import path from "node:path";
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { HistoryListResponse, HistoryRecord, HistoryQuery, JobLogEntry } from "@shared/ipc";

interface HistoryStore {
  jobs: HistoryRecord[];
  logs: JobLogEntry[];
}

const createEmptyStore = (): HistoryStore => ({
  jobs: [],
  logs: [],
});

const HISTORY_FILENAME = "history.json";
const MAX_HISTORY_RECORDS = 2000;
const SAVE_DEBOUNCE_MS = 1000;

const sortJobs = (jobs: HistoryRecord[]) => {
  // Running/queued jobs have no completion time yet; sort them as "now" so
  // they stay on top of the finished history instead of falling to the end.
  const now = Date.now();
  return jobs.sort((a, b) => {
    const completedA = a.completedAt ?? now;
    const completedB = b.completedAt ?? now;
    if (completedA !== completedB) {
      return completedB - completedA;
    }
    return b.queuedAt - a.queuedAt;
  });
};

export class HistoryService {
  private store: HistoryStore = createEmptyStore();
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const userDataPath = app.getPath("userData");
    if (!existsSync(userDataPath)) {
      mkdirSync(userDataPath, { recursive: true });
    }
    this.filePath = path.join(userDataPath, HISTORY_FILENAME);
    this.load();
  }

  private load() {
    if (!existsSync(this.filePath)) {
      this.writeNow();
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<HistoryStore>;
      this.store = {
        jobs: Array.isArray(parsed.jobs) ? (parsed.jobs as HistoryRecord[]) : [],
        logs: Array.isArray(parsed.logs) ? (parsed.logs as JobLogEntry[]) : [],
      };
      sortJobs(this.store.jobs);
    } catch (error) {
      console.warn("Failed to load history store, resetting.", error);
      // Keep the unreadable file for manual recovery instead of destroying it.
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // Best effort — the fresh store is written either way.
      }
      this.store = createEmptyStore();
      this.writeNow();
    }
  }

  private writeNow() {
    const payload = JSON.stringify(this.store, null, 2);
    // Write to a temp file and rename over the target so a crash mid-write
    // can never truncate the store (rename is atomic on the same volume).
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, payload, "utf-8");
    renameSync(tempPath, this.filePath);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // Progress events can fire several times per second per active job; writing
  // the whole store synchronously on each one stalls the main thread. Batch
  // log writes on a short debounce — job state transitions still save at once.
  private scheduleSave() {
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  flush() {
    if (this.saveTimer) {
      this.writeNow();
    }
  }

  upsertJob(record: HistoryRecord) {
    const existingIndex = this.store.jobs.findIndex((job) => job.id === record.id);
    if (existingIndex >= 0) {
      this.store.jobs[existingIndex] = { ...this.store.jobs[existingIndex], ...record };
    } else {
      this.store.jobs.push(record);
    }
    sortJobs(this.store.jobs);
    if (this.store.jobs.length > MAX_HISTORY_RECORDS) {
      this.store.jobs = this.store.jobs.slice(0, MAX_HISTORY_RECORDS);
    }
    this.writeNow();
  }

  logEntry(entry: JobLogEntry) {
    this.store.logs.push(entry);
    if (this.store.logs.length > 5000) {
      this.store.logs = this.store.logs.slice(this.store.logs.length - 5000);
    }
    this.scheduleSave();
  }

  listJobs(query: HistoryQuery = {}): HistoryListResponse {
    const { search, status, limit = 100, offset = 0 } = query;
    let records = [...this.store.jobs];

    if (status && status !== "all") {
      records = records.filter((record) => record.status === status);
    }

    if (search) {
      const needle = search.toLowerCase();
      records = records.filter(
        (record) =>
          record.fileName.toLowerCase().includes(needle) ||
          record.filePath.toLowerCase().includes(needle) ||
          (record.basePrefix ?? "").toLowerCase().includes(needle),
      );
    }

    const total = records.length;
    const paged = records.slice(offset, offset + limit);

    return {
      records: paged,
      total,
    };
  }

  getJobById(id: string): HistoryRecord | null {
    const job = this.store.jobs.find((record) => record.id === id);
    return job ? { ...job } : null;
  }

  deleteJob(id: string) {
    this.store.jobs = this.store.jobs.filter((record) => record.id !== id);
    this.store.logs = this.store.logs.filter((entry) => entry.jobId !== id);
    this.writeNow();
  }

  // On startup, no job can still be running — anything left in an active
  // state died with the previous process. Mark it failed so the history
  // view doesn't show "processing" forever.
  markStaleJobsInterrupted(): number {
    const now = Date.now();
    let interrupted = 0;
    for (const record of this.store.jobs) {
      if (
        record.status === "pending" ||
        record.status === "queued" ||
        record.status === "processing" ||
        record.status === "uploading"
      ) {
        record.status = "failed";
        record.error = "Interrupted by app restart";
        record.completedAt = record.completedAt ?? now;
        interrupted += 1;
      }
    }
    if (interrupted > 0) {
      this.writeNow();
    }
    return interrupted;
  }

  findExisting(filePath: string, basePrefix: string | undefined | null) {
    const normalizedPrefix = basePrefix ?? "";
    const job = this.store.jobs.find(
      (record) =>
        record.filePath === filePath &&
        (record.basePrefix ?? "") === normalizedPrefix &&
        record.status === "completed",
    );
    if (!job) return null;
    return {
      id: job.id,
      fileName: job.fileName,
      completedAt: job.completedAt ?? job.queuedAt,
      manifestUrl: job.manifestUrl ?? undefined,
    };
  }
}

export const historyService = new HistoryService();
