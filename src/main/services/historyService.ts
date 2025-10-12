import path from "node:path";
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HistoryListResponse, HistoryRecord, HistoryQuery, JobLogEntry, JobStatus } from "@shared/ipc";

interface HistoryStore {
  jobs: HistoryRecord[];
  logs: JobLogEntry[];
}

const createEmptyStore = (): HistoryStore => ({
  jobs: [],
  logs: []
});

const HISTORY_FILENAME = "history.json";

const sortJobs = (jobs: HistoryRecord[]) =>
  jobs.sort((a, b) => {
    const completedA = a.completedAt ?? 0;
    const completedB = b.completedAt ?? 0;
    if (completedA !== completedB) {
      return completedB - completedA;
    }
    return b.queuedAt - a.queuedAt;
  });

export class HistoryService {
  private store: HistoryStore = createEmptyStore();
  private filePath: string;

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
      this.save();
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<HistoryStore>;
      this.store = {
        jobs: Array.isArray(parsed.jobs) ? (parsed.jobs as HistoryRecord[]) : [],
        logs: Array.isArray(parsed.logs) ? (parsed.logs as JobLogEntry[]) : []
      };
      sortJobs(this.store.jobs);
    } catch (error) {
      console.warn("Failed to load history store, resetting.", error);
      this.store = createEmptyStore();
      this.save();
    }
  }

  private save() {
    const payload = JSON.stringify(this.store, null, 2);
    writeFileSync(this.filePath, payload, "utf-8");
  }

  upsertJob(record: HistoryRecord) {
    const existingIndex = this.store.jobs.findIndex(job => job.id === record.id);
    if (existingIndex >= 0) {
      this.store.jobs[existingIndex] = { ...this.store.jobs[existingIndex], ...record };
    } else {
      this.store.jobs.push(record);
    }
    sortJobs(this.store.jobs);
    this.save();
  }

  logEntry(entry: JobLogEntry) {
    this.store.logs.push(entry);
    if (this.store.logs.length > 5000) {
      this.store.logs = this.store.logs.slice(this.store.logs.length - 5000);
    }
    this.save();
  }

  listJobs(query: HistoryQuery = {}): HistoryListResponse {
    const { search, status, limit = 100, offset = 0 } = query;
    let records = [...this.store.jobs];

    if (status && status !== "all") {
      records = records.filter(record => record.status === status);
    }

    if (search) {
      const needle = search.toLowerCase();
      records = records.filter(record =>
        record.fileName.toLowerCase().includes(needle) ||
        record.filePath.toLowerCase().includes(needle) ||
        (record.basePrefix ?? "").toLowerCase().includes(needle)
      );
    }

    const total = records.length;
    const paged = records.slice(offset, offset + limit);

    return {
      records: paged,
      total
    };
  }

  getJobById(id: string): HistoryRecord | null {
    const job = this.store.jobs.find(record => record.id === id);
    return job ? { ...job } : null;
  }

  deleteJob(id: string) {
    this.store.jobs = this.store.jobs.filter(record => record.id !== id);
    this.store.logs = this.store.logs.filter(entry => entry.jobId !== id);
    this.save();
  }

  findExisting(filePath: string, basePrefix: string | undefined | null) {
    const normalizedPrefix = basePrefix ?? "";
    const job = this.store.jobs.find(
      record =>
        record.filePath === filePath &&
        (record.basePrefix ?? "") === normalizedPrefix &&
        record.status === "completed"
    );
    if (!job) return null;
    return {
      id: job.id,
      fileName: job.fileName,
      completedAt: job.completedAt ?? job.queuedAt,
      manifestUrl: job.manifestUrl ?? undefined
    };
  }
}

export const historyService = new HistoryService();

