export const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"];

export type JobStatus =
  | "pending"
  | "queued"
  | "processing"
  | "uploading"
  | "completed"
  | "failed"
  | "skipped"
  | "canceled";

export interface QueueRequest {
  basePrefix: string;
  files: Array<{ filePath: string }>;
  renditions: string[];
  mode: "single" | "batch";
  concurrency?: number;
}

export interface QueueResponse {
  jobIds: string[];
  skipped: Array<{ filePath: string; reason: string }>;
}

export interface SingleProcessRequest {
  basePrefix: string;
  filePath: string;
  renditions: string[];
  destination?: Destination;
}

export type Destination = { type: "s3" } | { type: "local"; directory: string };

/**
 * Settings submitted from the renderer. Empty `accessKeyId` / `secretAccessKey`
 * means "keep the currently stored value" so the form can round-trip masked
 * secrets without ever seeing them.
 */
export interface S3SettingsInput {
  endpointUrl: string;
  region: string;
  bucketName: string;
  bucketUrl: string;
  viewEndpoint: string;
  pathStyle: boolean;
  uploadConcurrency: number;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Renderer-facing view of the saved settings. Secrets are never shipped to
 * the renderer — only whether they exist.
 */
export interface AppSettingsView {
  s3: {
    endpointUrl: string;
    region: string;
    bucketName: string;
    bucketUrl: string;
    viewEndpoint: string;
    pathStyle: boolean;
    uploadConcurrency: number;
    hasAccessKey: boolean;
    hasSecretKey: boolean;
  } | null;
  encryptionAvailable: boolean;
}

export interface VideoJobPayload {
  filePath: string;
  objectKey: string;
  renditions: string[];
  destination?: Destination;
}

export interface VideoJobProgress {
  status: JobStatus;
  stage: string;
  percent?: number;
  message?: string;
}

export interface VideoJobResult {
  success: boolean;
  manifestUrl: string | null;
  warnings?: string[];
  details?: string;
  error?: string;
}

export interface SingleProcessResult extends VideoJobResult {
  jobId: string;
  objectKey: string;
}

export interface SingleProcessProgress extends VideoJobProgress {
  jobId: string;
  filePath: string;
  fileName: string;
  timestamp: number;
}

export interface JobState {
  id: string;
  filePath: string;
  fileName: string;
  objectKey: string;
  status: JobStatus;
  stage: string;
  percent: number | null;
  message?: string;
  manifestUrl?: string;
  warnings?: string[];
  error?: string;
}

export interface QueueTotals {
  total: number;
  pending: number;
  processing: number;
  uploading: number;
  completed: number;
  failed: number;
  skipped: number;
  canceled: number;
}

export interface QueueUpdate {
  queueStatus: "idle" | "running" | "paused";
  activeJobId?: string;
  jobs: JobState[];
  totals: QueueTotals;
  overallPercent: number;
  warnings: string[];
}

export interface JobLogEntry {
  id: string;
  jobId: string;
  timestamp: number;
  stage: string;
  message?: string;
  percent?: number;
  status: JobStatus;
}

export interface FolderScanResult {
  folderPath: string;
  files: Array<{
    filePath: string;
    fileName: string;
    size: number;
    extension: string;
  }>;
  skipped: Array<{
    filePath: string;
    reason: string;
  }>;
}

export type QueueControlAction =
  "pause" | "resume" | "cancel-current" | "cancel-remaining" | "clear-completed";

export interface HistoryQuery {
  search?: string;
  status?: JobStatus | "all";
  limit?: number;
  offset?: number;
}

export interface HistoryRecord {
  id: string;
  filePath: string;
  fileName: string;
  fileHash: string | null;
  basePrefix: string | null;
  renditions: string[];
  queueMode: "single" | "batch";
  status: JobStatus;
  manifestUrl: string | null;
  warnings: string[];
  error: string | null;
  queuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface HistoryListResponse {
  records: HistoryRecord[];
  total: number;
}

export interface ExposedBridge {
  selectVideo(): Promise<string | null>;
  selectFolder(): Promise<string | null>;
  scanFolder(folderPath: string): Promise<FolderScanResult>;
  queueJobs(request: QueueRequest): Promise<QueueResponse>;
  processSingle(request: SingleProcessRequest): Promise<SingleProcessResult>;
  onSingleProgress(callback: (progress: SingleProcessProgress) => void): () => void;
  controlQueue(action: QueueControlAction): Promise<void>;
  setConcurrency(limit: number): Promise<void>;
  onQueueUpdate(callback: (update: QueueUpdate) => void): () => void;
  onJobLog(callback: (entry: JobLogEntry) => void): () => void;
  listHistory(query?: HistoryQuery): Promise<HistoryListResponse>;
  deleteHistory(jobId: string): Promise<void>;
  getPathForFile(file: File): string;
  getSettings(): Promise<AppSettingsView>;
  saveSettings(settings: S3SettingsInput): Promise<AppSettingsView>;
}

declare global {
  interface Window {
    api?: ExposedBridge;
  }
}
