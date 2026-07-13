import path from "node:path";
import { BrowserWindow, powerSaveBlocker } from "electron";
import { randomUUID } from "node:crypto";
import { JobCanceledError, processVideoJob } from "./videoPipeline";
import type {
  JobLogEntry,
  JobState,
  JobStatus,
  QueueRequest,
  QueueTotals,
  QueueUpdate,
  SingleProcessRequest,
  SingleProcessResult,
  SingleProcessProgress,
} from "@shared/ipc";
import { SUPPORTED_VIDEO_EXTENSIONS } from "@shared/ipc";
import { historyService } from "./historyService";

const SUPPORTED_EXTENSIONS = new Set(SUPPORTED_VIDEO_EXTENSIONS);

export const normalizePrefix = (prefix: string) =>
  prefix
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

export const slugify = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();

export const deriveObjectKey = (basePrefix: string, filePath: string, existing: Set<string>) => {
  const { name } = path.parse(filePath);
  const segment = slugify(name) || "video";
  const prefix = normalizePrefix(basePrefix);
  let candidate = prefix ? `${prefix}/${segment}` : segment;
  let counter = 1;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = prefix ? `${prefix}/${segment}-${counter}` : `${segment}-${counter}`;
  }
  existing.add(candidate);
  return candidate;
};

export interface InternalJob extends JobState {
  fileSize: number;
  queueIndex: number;
  renditions: string[];
  basePrefix: string;
  queueMode: "single" | "batch";
  queuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  skipReason?: string;
}

type QueueStatus = "idle" | "running" | "paused";

export class JobManager {
  private jobs: Map<string, InternalJob> = new Map();
  private order: string[] = [];
  private queueStatus: QueueStatus = "idle";
  private concurrency = 2;
  private activeCount = 0;
  private paused = false;
  private powerBlockerId: number | null = null;
  private powerBlockerDepth = 0;
  private batchBlockerHeld = false;
  private window: BrowserWindow | null = null;
  private pendingWarnings: string[] = [];
  private abortControllers: Map<string, AbortController> = new Map();
  private inFlightSingles = new Set<string>();

  setWindow(window: BrowserWindow | null) {
    this.window = window;
  }

  private addJob(job: InternalJob) {
    this.jobs.set(job.id, job);

    if (!this.order.includes(job.id)) {
      this.order.push(job.id);
    }

    // Keep queueIndex in sync with the insertion order so UI reflects real position.
    this.order.forEach((jobId, index) => {
      const trackedJob = this.jobs.get(jobId);
      if (trackedJob) {
        trackedJob.queueIndex = index;
      }
    });

    if (this.queueStatus === "idle" && !this.paused) {
      this.queueStatus = job.status === "skipped" ? "idle" : "running";
    }
  }

  async enqueue(request: QueueRequest) {
    const jobIds: string[] = [];
    const skipped: Array<{ filePath: string; reason: string }> = [];
    if (request.concurrency) {
      this.setConcurrency(request.concurrency);
    }
    const normalizedPrefix = request.basePrefix.trim();
    if (!normalizedPrefix) {
      throw new Error("Object path prefix is required.");
    }

    const existingKeys = new Set(
      Array.from(this.jobs.values())
        .map((job) => job.objectKey)
        .filter(Boolean),
    );

    for (const { filePath } of request.files) {
      const extension = path.extname(filePath).toLowerCase();
      const queuedAt = Date.now();

      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        const jobId = randomUUID();
        const job: InternalJob = {
          id: jobId,
          filePath,
          fileName: path.basename(filePath),
          objectKey: "",
          status: "skipped",
          stage: "Skipped",
          percent: null,
          message: "Unsupported file type",
          warnings: [`Skipped unsupported file: ${path.basename(filePath)}`],
          error: undefined,
          manifestUrl: undefined,
          fileSize: 0,
          queueIndex: this.order.length,
          renditions: request.renditions,
          basePrefix: normalizedPrefix,
          queueMode: request.mode,
          queuedAt,
          startedAt: null,
          completedAt: queuedAt,
          skipReason: "unsupported-file",
        };
        this.addJob(job);
        jobIds.push(jobId);
        this.pendingWarnings.push(`Skipped ${path.basename(filePath)} (unsupported file type).`);
        skipped.push({ filePath, reason: "unsupported file type" });
        historyService.upsertJob({
          id: jobId,
          filePath,
          fileName: job.fileName,
          fileHash: null,
          basePrefix: normalizedPrefix,
          renditions: request.renditions,
          queueMode: request.mode,
          status: "skipped",
          manifestUrl: null,
          warnings: job.warnings ?? [],
          error: job.message ?? null,
          queuedAt,
          startedAt: null,
          completedAt: queuedAt,
        });
        continue;
      }

      const duplicate = historyService.findExisting(filePath, normalizedPrefix);
      if (duplicate) {
        const jobId = randomUUID();
        const job: InternalJob = {
          id: jobId,
          filePath,
          fileName: path.basename(filePath),
          objectKey: duplicate.manifestUrl ?? "",
          status: "skipped",
          stage: "Skipped",
          percent: null,
          message: `Already processed on ${new Date(duplicate.completedAt).toLocaleString()}`,
          warnings: [`Previously processed: ${duplicate.manifestUrl ?? duplicate.fileName}`],
          error: undefined,
          manifestUrl: duplicate.manifestUrl ?? undefined,
          fileSize: 0,
          queueIndex: this.order.length,
          renditions: request.renditions,
          basePrefix: normalizedPrefix,
          queueMode: request.mode,
          queuedAt,
          startedAt: null,
          completedAt: queuedAt,
          skipReason: "duplicate",
        };
        this.addJob(job);
        jobIds.push(jobId);
        this.pendingWarnings.push(`Skipped ${path.basename(filePath)} (already processed).`);
        skipped.push({ filePath, reason: "duplicate" });
        historyService.upsertJob({
          id: jobId,
          filePath: job.filePath,
          fileName: job.fileName,
          fileHash: null,
          basePrefix: normalizedPrefix,
          renditions: job.renditions,
          queueMode: request.mode,
          status: "skipped",
          manifestUrl: job.manifestUrl ?? null,
          warnings: job.warnings ?? [],
          error: job.message ?? null,
          queuedAt,
          startedAt: null,
          completedAt: job.completedAt ?? queuedAt,
        });
        continue;
      }

      const objectKey = deriveObjectKey(normalizedPrefix, filePath, existingKeys);
      const jobId = randomUUID();
      const job: InternalJob = {
        id: jobId,
        filePath,
        fileName: path.basename(filePath),
        objectKey,
        status: "pending",
        stage: "Pending",
        percent: 0,
        message: undefined,
        warnings: [],
        error: undefined,
        manifestUrl: undefined,
        fileSize: 0,
        queueIndex: this.order.length,
        renditions: request.renditions,
        basePrefix: normalizedPrefix,
        queueMode: request.mode,
        queuedAt,
        startedAt: null,
        completedAt: null,
      };
      this.addJob(job);
      jobIds.push(jobId);
      historyService.upsertJob({
        id: jobId,
        filePath: job.filePath,
        fileName: job.fileName,
        fileHash: null,
        basePrefix: normalizedPrefix,
        renditions: job.renditions,
        queueMode: request.mode,
        status: job.status,
        manifestUrl: null,
        warnings: [],
        error: null,
        queuedAt,
        startedAt: null,
        completedAt: null,
      });
    }

    this.emitUpdate();
    void this.drainQueue();
    return { jobIds, skipped };
  }

  async processSingle(
    request: SingleProcessRequest,
    emitProgress?: (progress: SingleProcessProgress) => void,
  ): Promise<SingleProcessResult> {
    const { filePath, basePrefix, renditions } = request;
    if (!filePath) {
      throw new Error("Video file path is required.");
    }
    if (!isVideoFile(filePath)) {
      throw new Error("Unsupported file type");
    }
    const normalizedPrefix = basePrefix.trim();
    if (!normalizedPrefix) {
      throw new Error("Object path prefix is required.");
    }

    // Two overlapping single conversions of the same file and prefix would
    // derive the same object key and clobber each other's output.
    const dedupeKey = `${normalizedPrefix}\n${filePath}`;
    if (this.inFlightSingles.has(dedupeKey)) {
      throw new Error("This video is already being converted to the same destination.");
    }
    this.inFlightSingles.add(dedupeKey);

    const queuedAt = Date.now();
    const existingKeys = new Set(
      Array.from(this.jobs.values())
        .map((job) => job.objectKey)
        .filter(Boolean),
    );
    const objectKey = deriveObjectKey(normalizedPrefix, filePath, existingKeys);
    const jobId = randomUUID();
    const fileName = path.basename(filePath);

    historyService.upsertJob({
      id: jobId,
      filePath,
      fileName,
      fileHash: null,
      basePrefix: normalizedPrefix,
      renditions,
      queueMode: "single",
      status: "processing",
      manifestUrl: null,
      warnings: [],
      error: null,
      queuedAt,
      startedAt: queuedAt,
      completedAt: null,
    });

    let lastStatus: JobStatus = "processing";
    let lastPercent: number | undefined = 0;

    emitProgress?.({
      jobId,
      filePath,
      fileName,
      status: "processing",
      stage: "Preparing",
      percent: 0,
      message: "Preparing single-file conversion",
      timestamp: Date.now(),
    });

    this.acquirePowerSaveBlocker();
    try {
      const result = await processVideoJob(
        {
          filePath,
          objectKey,
          renditions,
          destination: request.destination,
        },
        (progress) => {
          lastStatus = progress.status as JobStatus;
          historyService.logEntry({
            id: randomUUID(),
            jobId,
            timestamp: Date.now(),
            stage: progress.stage,
            message: progress.message,
            percent: progress.percent ?? undefined,
            status: lastStatus,
          });
          if (progress.percent !== undefined && progress.percent !== null) {
            lastPercent = progress.percent;
          }
          emitProgress?.({
            jobId,
            filePath,
            fileName,
            status: progress.status,
            stage: progress.stage,
            percent: progress.percent ?? lastPercent,
            message: progress.message,
            timestamp: Date.now(),
          });
        },
      );

      historyService.upsertJob({
        id: jobId,
        filePath,
        fileName,
        fileHash: null,
        basePrefix: normalizedPrefix,
        renditions,
        queueMode: "single",
        status: result.success ? "completed" : "failed",
        manifestUrl: result.manifestUrl ?? null,
        warnings: result.warnings ?? [],
        error: result.error ?? null,
        queuedAt,
        startedAt: queuedAt,
        completedAt: Date.now(),
      });

      if (!result.success) {
        emitProgress?.({
          jobId,
          filePath,
          fileName,
          status: "failed",
          stage: "Failed",
          percent: lastPercent,
          message: result.error ?? "Processing failed",
          timestamp: Date.now(),
        });
        return {
          success: false,
          manifestUrl: result.manifestUrl ?? null,
          warnings: result.warnings ?? [],
          details: result.details,
          error: result.error ?? "Processing failed",
          jobId,
          objectKey,
        };
      }

      emitProgress?.({
        jobId,
        filePath,
        fileName,
        status: "completed",
        stage: "Completed",
        percent: 100,
        message: result.details ?? "Upload finished",
        timestamp: Date.now(),
      });

      return {
        success: true,
        manifestUrl: result.manifestUrl ?? null,
        warnings: result.warnings ?? [],
        details: result.details,
        error: undefined,
        jobId,
        objectKey,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      historyService.logEntry({
        id: randomUUID(),
        jobId,
        timestamp: Date.now(),
        stage: "Failed",
        message,
        percent: undefined,
        status: "failed",
      });
      historyService.upsertJob({
        id: jobId,
        filePath,
        fileName,
        fileHash: null,
        basePrefix: normalizedPrefix,
        renditions,
        queueMode: "single",
        status: "failed",
        manifestUrl: null,
        warnings: [],
        error: message,
        queuedAt,
        startedAt: queuedAt,
        completedAt: Date.now(),
      });
      emitProgress?.({
        jobId,
        filePath,
        fileName,
        status: "failed",
        stage: "Failed",
        percent: lastPercent,
        message,
        timestamp: Date.now(),
      });
      throw error;
    } finally {
      this.inFlightSingles.delete(dedupeKey);
      this.releasePowerSaveBlocker();
    }
  }

  control(action: "pause" | "resume" | "cancel-current" | "cancel-remaining" | "clear-completed") {
    switch (action) {
      case "pause":
        this.paused = true;
        this.queueStatus = "paused";
        break;
      case "resume":
        this.paused = false;
        this.queueStatus = "running";
        void this.drainQueue();
        break;
      case "cancel-remaining":
        this.cancelRemaining();
        break;
      case "cancel-current":
        this.cancelCurrent();
        break;
      case "clear-completed":
        this.clearCompleted();
        break;
      default:
        break;
    }
    this.emitUpdate();
  }

  setConcurrency(limit: number) {
    if (!Number.isFinite(limit)) {
      return;
    }
    const normalized = Math.max(1, Math.min(16, Math.floor(limit)));
    this.concurrency = normalized;
    if (!this.paused) {
      void this.drainQueue();
    }
    this.emitUpdate();
  }

  private cancelRemaining() {
    for (const jobId of this.order) {
      const job = this.jobs.get(jobId);
      if (!job) continue;
      if (job.status === "pending" || job.status === "queued") {
        job.status = "canceled";
        job.stage = "Canceled";
        job.percent = null;
        job.message = "Job canceled before start";
      }
    }
  }

  private cancelCurrent() {
    for (const job of this.jobs.values()) {
      if (job.status === "processing" || job.status === "uploading") {
        job.status = "canceled";
        job.stage = "Canceled";
        job.percent = null;
        job.message = "Canceling…";
        this.abortControllers.get(job.id)?.abort();
        this.emitLog(job, "Cancel requested by user");
        break;
      }
    }
  }

  private clearCompleted() {
    const remaining: string[] = [];
    for (const jobId of this.order) {
      const job = this.jobs.get(jobId);
      if (!job) continue;
      if (job.status === "completed" || job.status === "skipped") {
        this.jobs.delete(jobId);
      } else {
        remaining.push(jobId);
      }
    }
    this.order = remaining;
    if (this.jobs.size === 0) {
      this.queueStatus = "idle";
    }
  }

  private async drainQueue() {
    if (this.paused) {
      return;
    }
    while (this.activeCount < this.concurrency) {
      const nextJob = this.getNextJob();
      if (!nextJob) {
        if (this.activeCount === 0) {
          this.queueStatus = "idle";
          if (this.batchBlockerHeld) {
            this.batchBlockerHeld = false;
            this.releasePowerSaveBlocker();
          }
        }
        this.emitUpdate();
        break;
      }
      this.activeCount += 1;
      this.queueStatus = "running";
      if (!this.batchBlockerHeld) {
        this.batchBlockerHeld = true;
        this.acquirePowerSaveBlocker();
      }
      this.runJob(nextJob).catch((error) => {
        console.error("Job execution failed", error);
      });
    }
  }

  private getNextJob(): InternalJob | null {
    for (const jobId of this.order) {
      const job = this.jobs.get(jobId);
      if (!job) continue;
      if (job.status === "pending" || job.status === "queued") {
        job.status = "queued";
        job.stage = "Queued";
        job.percent = 0;
        return job;
      }
    }
    return null;
  }

  private async runJob(job: InternalJob) {
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);

    try {
      job.status = "processing";
      job.stage = "Converting";
      job.percent = 0;
      job.startedAt = Date.now();
      this.emitUpdate();
      this.emitLog(job, "Queued job start");
      historyService.upsertJob({
        id: job.id,
        filePath: job.filePath,
        fileName: job.fileName,
        fileHash: null,
        basePrefix: job.basePrefix,
        renditions: job.renditions,
        queueMode: job.queueMode,
        status: job.status,
        manifestUrl: job.manifestUrl ?? null,
        warnings: job.warnings ?? [],
        error: job.error ?? null,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt,
        completedAt: null,
      });

      const result = await processVideoJob(
        {
          filePath: job.filePath,
          objectKey: job.objectKey,
          renditions: job.renditions,
        },
        (progress) => {
          if (job.status === "canceled") {
            return;
          }
          job.status = progress.status as JobStatus;
          job.stage = progress.stage;
          job.percent = progress.percent ?? job.percent;
          job.message = progress.message;
          this.emitUpdate();
          this.emitLog(job, progress.message ?? progress.stage, progress.percent ?? undefined);
        },
        controller.signal,
      );

      // cancelCurrent() may have flipped the status while the pipeline was
      // running; the cast defeats control-flow narrowing, which cannot see
      // mutations made during the await.
      if ((job.status as JobStatus) !== "canceled") {
        job.manifestUrl = result.manifestUrl ?? job.manifestUrl;
        job.warnings = result.warnings ?? [];
        if (result.success) {
          job.status = "completed";
          job.stage = "Completed";
          job.percent = 100;
          job.message = result.details ?? "Completed";
        } else {
          job.status = "failed";
          job.stage = "Failed";
          job.message = result.error ?? "Processing failed";
          job.error = result.error ?? job.error ?? "Processing failed";
        }
      }
    } catch (error) {
      if (error instanceof JobCanceledError || job.status === "canceled") {
        job.status = "canceled";
        job.stage = "Canceled";
        job.percent = null;
        job.message = "Canceled by user";
        job.error = undefined;
        this.emitLog(job, "Job canceled by user");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        job.status = "failed";
        job.stage = "Failed";
        job.percent = null;
        job.message = message;
        job.error = message;
        this.emitLog(job, message);
      }
    } finally {
      this.abortControllers.delete(job.id);
      job.completedAt = Date.now();
      this.activeCount -= 1;
      this.emitUpdate();
      if (!this.paused) {
        void this.drainQueue();
      } else if (this.activeCount === 0 && this.batchBlockerHeld) {
        this.batchBlockerHeld = false;
        this.releasePowerSaveBlocker();
      }
      // Persist after the queue bookkeeping recovers: if this write throws
      // (disk full, unwritable userData) the queue must still advance.
      try {
        historyService.upsertJob({
          id: job.id,
          filePath: job.filePath,
          fileName: job.fileName,
          fileHash: null,
          basePrefix: job.basePrefix,
          renditions: job.renditions,
          queueMode: job.queueMode,
          status: job.status,
          manifestUrl: job.manifestUrl ?? null,
          warnings: job.warnings ?? [],
          error: job.error ?? null,
          queuedAt: job.queuedAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        });
      } catch (persistError) {
        console.error("Failed to persist job state", persistError);
      }
    }
  }

  private emitUpdate() {
    const update: QueueUpdate = {
      queueStatus: this.queueStatus,
      activeJobId: this.getActiveJobId(),
      jobs: this.getJobStates(),
      totals: this.computeTotals(),
      overallPercent: this.computeOverallPercent(),
      warnings: this.pendingWarnings,
    };
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("jobs:update", update);
    }
    this.pendingWarnings = [];
  }

  private emitLog(job: InternalJob, message: string, percent?: number) {
    const entry: JobLogEntry = {
      id: randomUUID(),
      jobId: job.id,
      timestamp: Date.now(),
      stage: job.stage,
      message,
      percent,
      status: job.status,
    };
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("jobs:log", entry);
    }
    historyService.logEntry(entry);
  }

  private getActiveJobId(): string | undefined {
    for (const job of this.jobs.values()) {
      if (job.status === "processing" || job.status === "uploading") {
        return job.id;
      }
    }
    return undefined;
  }

  private getJobStates(): JobState[] {
    return this.order
      .map((jobId) => this.jobs.get(jobId))
      .filter((job): job is InternalJob => Boolean(job))
      .map((job) => ({
        id: job.id,
        filePath: job.filePath,
        fileName: job.fileName,
        objectKey: job.objectKey,
        status: job.status,
        stage: job.stage,
        percent: job.percent,
        message: job.message,
        manifestUrl: job.manifestUrl,
        warnings: job.warnings,
        error: job.error,
      }));
  }

  private computeTotals(): QueueTotals {
    const totals: QueueTotals = {
      total: this.jobs.size,
      pending: 0,
      processing: 0,
      uploading: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      canceled: 0,
    };

    for (const job of this.jobs.values()) {
      switch (job.status) {
        case "pending":
        case "queued":
          totals.pending += 1;
          break;
        case "processing":
          totals.processing += 1;
          break;
        case "uploading":
          totals.uploading += 1;
          break;
        case "completed":
          totals.completed += 1;
          break;
        case "failed":
          totals.failed += 1;
          break;
        case "skipped":
          totals.skipped += 1;
          break;
        case "canceled":
          totals.canceled += 1;
          break;
        default:
          break;
      }
    }

    return totals;
  }

  private computeOverallPercent(): number {
    if (this.jobs.size === 0) {
      return 0;
    }
    let total = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "completed") {
        total += 100;
      } else if (typeof job.percent === "number") {
        total += Math.max(0, Math.min(job.percent, 100));
      }
    }
    return total / this.jobs.size;
  }

  // Refcounted so the batch queue and single-file conversions can hold the
  // blocker independently without switching each other's hold off.
  private acquirePowerSaveBlocker() {
    this.powerBlockerDepth += 1;
    if (this.powerBlockerId === null) {
      this.powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    }
  }

  private releasePowerSaveBlocker() {
    if (this.powerBlockerDepth > 0) {
      this.powerBlockerDepth -= 1;
    }
    if (this.powerBlockerDepth === 0 && this.powerBlockerId !== null) {
      if (powerSaveBlocker.isStarted(this.powerBlockerId)) {
        powerSaveBlocker.stop(this.powerBlockerId);
      }
      this.powerBlockerId = null;
    }
  }
}

export const isVideoFile = (filePath: string) =>
  SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
