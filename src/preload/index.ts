import { contextBridge, ipcRenderer } from "electron";
import type {
  FolderScanResult,
  HistoryListResponse,
  HistoryQuery,
  JobLogEntry,
  QueueControlAction,
  QueueRequest,
  SingleProcessRequest,
  SingleProcessResult,
  SingleProcessProgress,
  QueueUpdate
} from "@shared/ipc";

const api = {
  selectVideo: (): Promise<string | null> => ipcRenderer.invoke("dialog:select-video"),
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:select-folder"),
  scanFolder: (folderPath: string): Promise<FolderScanResult> => ipcRenderer.invoke("jobs:scan-folder", folderPath),
  queueJobs: (request: QueueRequest) => ipcRenderer.invoke("jobs:queue", request),
  processSingle: (request: SingleProcessRequest): Promise<SingleProcessResult> =>
    ipcRenderer.invoke("jobs:process-single", request),
  onSingleProgress: (callback: (progress: SingleProcessProgress) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: SingleProcessProgress) => callback(payload);
    ipcRenderer.on("jobs:single-progress", listener);
    return () => ipcRenderer.removeListener("jobs:single-progress", listener);
  },
  controlQueue: (action: QueueControlAction): Promise<void> => ipcRenderer.invoke("jobs:control", action),
  setConcurrency: (limit: number): Promise<void> => ipcRenderer.invoke("jobs:set-concurrency", limit),
  onQueueUpdate: (callback: (update: QueueUpdate) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: QueueUpdate) => callback(payload);
    ipcRenderer.on("jobs:update", listener);
    return () => ipcRenderer.removeListener("jobs:update", listener);
  },
  onJobLog: (callback: (entry: JobLogEntry) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: JobLogEntry) => callback(payload);
    ipcRenderer.on("jobs:log", listener);
    return () => ipcRenderer.removeListener("jobs:log", listener);
  },
  listHistory: (query?: HistoryQuery): Promise<HistoryListResponse> => ipcRenderer.invoke("history:list", query),
  deleteHistory: (jobId: string): Promise<void> => ipcRenderer.invoke("history:delete", jobId)
};

contextBridge.exposeInMainWorld("api", api);
