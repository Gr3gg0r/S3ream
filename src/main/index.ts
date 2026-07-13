import "dotenv/config";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { JobManager, isVideoFile } from "./services/jobManager";
import { historyService } from "./services/historyService";
import { configureS3 } from "./services/minioClient";
import { settingsService } from "./services/settingsService";
import type {
  FolderScanResult,
  QueueControlAction,
  QueueRequest,
  SingleProcessRequest,
  S3SettingsInput,
} from "@shared/ipc";

let mainWindow: BrowserWindow | null = null;
const jobManager = new JobManager();

// Remove HLS temp directories left behind by a crash or force-quit.
const sweepStaleTempDirs = async () => {
  try {
    const entries = await fs.readdir(tmpdir(), { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("s3ream-hls-"))
        .map((entry) => fs.rm(path.join(tmpdir(), entry.name), { recursive: true, force: true })),
    );
  } catch (error) {
    console.warn("Failed to sweep stale temp directories", error);
  }
};

const createWindow = async () => {
  const preloadEntry =
    ["index.cjs", "index.js", "index.mjs"]
      .map((fileName) => path.join(__dirname, "../preload", fileName))
      .find((candidate) => existsSync(candidate)) ?? path.join(__dirname, "../preload/index.cjs");

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadEntry,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  jobManager.setWindow(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url);
      if (protocol === "http:" || protocol === "https:") {
        void shell.openExternal(url);
      }
    } catch {
      // Ignore malformed URLs; deny the window either way.
    }
    return { action: "deny" };
  });
};

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // A second instance would sweep the first one's live temp directories and
  // race its history/settings writes — quit and focus the running instance.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

void app.whenReady().then(() => {
  const interrupted = historyService.markStaleJobsInterrupted();
  if (interrupted > 0) {
    console.log(`Marked ${interrupted} interrupted job(s) from the previous session as failed.`);
  }
  void sweepStaleTempDirs();

  // Saved connection settings take precedence over .env when present.
  const savedSettings = settingsService.getS3Settings();
  if (savedSettings) {
    configureS3(savedSettings);
  }

  createWindow().catch((error) => {
    console.error("Failed to create window", error);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => console.error(error));
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  historyService.flush();
});

ipcMain.handle("dialog:select-video", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Select a video file",
    properties: ["openFile"],
    filters: [{ name: "Video Files", extensions: ["mp4", "mov", "mkv", "avi", "m4v", "webm"] }],
  });
  if (canceled || filePaths.length === 0) {
    return null;
  }
  return filePaths[0];
});

ipcMain.handle("dialog:select-folder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Select a folder",
    properties: ["openDirectory"],
  });
  if (canceled || filePaths.length === 0) {
    return null;
  }
  return filePaths[0];
});

ipcMain.handle(
  "jobs:scan-folder",
  async (_event, folderPath: string): Promise<FolderScanResult> => {
    const result: FolderScanResult = {
      folderPath,
      files: [],
      skipped: [],
    };

    try {
      const dirents = await fs.readdir(folderPath, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isFile()) {
          continue;
        }
        const fullPath = path.join(folderPath, dirent.name);
        if (isVideoFile(fullPath)) {
          const stats = await fs.stat(fullPath);
          result.files.push({
            filePath: fullPath,
            fileName: dirent.name,
            size: stats.size,
            extension: path.extname(dirent.name).toLowerCase(),
          });
        } else {
          result.skipped.push({
            filePath: fullPath,
            reason: "Unsupported file type",
          });
        }
      }
    } catch (error) {
      console.error("Failed to scan folder", error);
      throw error;
    }

    return result;
  },
);

ipcMain.handle("jobs:queue", async (_event, request: QueueRequest) => {
  const { jobIds, skipped } = await jobManager.enqueue(request);
  return { jobIds, skipped };
});

ipcMain.handle("jobs:process-single", async (event, request: SingleProcessRequest) => {
  return jobManager.processSingle(request, (progress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("jobs:single-progress", progress);
    }
  });
});

ipcMain.handle("jobs:control", async (_event, action: QueueControlAction) => {
  jobManager.control(action);
});

ipcMain.handle("jobs:set-concurrency", async (_event, limit: number) => {
  jobManager.setConcurrency(limit);
});

ipcMain.handle("history:list", async (_event, query) => {
  const result = historyService.listJobs(query);
  return result;
});

ipcMain.handle("history:delete", async (_event, jobId: string) => {
  historyService.deleteJob(jobId);
});

ipcMain.handle("settings:get", async () => settingsService.getView());

ipcMain.handle("settings:save", async (_event, input: S3SettingsInput) => {
  const resolved = settingsService.save(input);
  configureS3(resolved);
  return settingsService.getView();
});
