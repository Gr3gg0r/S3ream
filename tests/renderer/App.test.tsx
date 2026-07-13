// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExposedBridge,
  HistoryListResponse,
  QueueUpdate,
  SingleProcessProgress,
} from "@shared/ipc";
import App from "../../src/renderer/src/App";

const listHistoryMock = vi.fn<() => Promise<HistoryListResponse>>();

let bridgeApi: ExposedBridge;
// The real bridge broadcasts to every subscriber; mirrors that so App and
// JourneyWizard listeners can both be exercised (and unmount cleanly).
const bridgeCallbacks = {
  singleProgress: new Set<(progress: SingleProcessProgress) => void>(),
  queueUpdate: new Set<(update: QueueUpdate) => void>(),
};

const installBridge = () => {
  const api: ExposedBridge = {
    selectVideo: vi.fn(async () => null),
    selectFolder: vi.fn(async () => null),
    scanFolder: vi.fn(async () => ({ folderPath: "", files: [], skipped: [] })),
    queueJobs: vi.fn(async () => ({ jobIds: [], skipped: [] })),
    processSingle: vi.fn(async () => ({
      success: true,
      manifestUrl: null,
      jobId: "job",
      objectKey: "key",
    })),
    onSingleProgress: vi.fn((callback) => {
      bridgeCallbacks.singleProgress.add(callback);
      return () => {
        bridgeCallbacks.singleProgress.delete(callback);
      };
    }),
    controlQueue: vi.fn(async () => {}),
    setConcurrency: vi.fn(async () => {}),
    onQueueUpdate: vi.fn((callback) => {
      bridgeCallbacks.queueUpdate.add(callback);
      return () => {
        bridgeCallbacks.queueUpdate.delete(callback);
      };
    }),
    onJobLog: vi.fn(() => () => {}),
    listHistory: listHistoryMock,
    deleteHistory: vi.fn(async () => {}),
    getPathForFile: vi.fn((file: File) => `/videos/${file.name}`),
    getSettings: vi.fn(async () => ({ s3: null, encryptionAvailable: false })),
    saveSettings: vi.fn(async () => ({ s3: null, encryptionAvailable: false })),
  };
  window.api = api;
  bridgeApi = api;
  return api;
};

const installLocalStorage = () => {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
  });
};

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  installLocalStorage();
  listHistoryMock.mockReset();
  listHistoryMock.mockResolvedValue({ records: [], total: 0 });
  installBridge();
});

afterEach(() => {
  cleanup();
  delete window.api;
});

describe("App shell", () => {
  it("renders the header and view switcher", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "S3ream" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Simple" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Advanced" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "History" })).toBeInTheDocument();
  });

  it("renders the journey stepper with the three step labels on the default view", () => {
    render(<App />);
    expect(screen.getByText("1 Video")).toBeInTheDocument();
    expect(screen.getByText("2 Quality")).toBeInTheDocument();
    expect(screen.getByText("3 Destination")).toBeInTheDocument();
  });

  it("activating Advanced reveals Single file and Folder batch", () => {
    render(<App />);
    expect(screen.queryByRole("button", { name: "Single file" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: "Single file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder batch" })).toBeInTheDocument();
  });

  it("keeps Convert & upload disabled until a file and prefix are set", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: "Convert & upload" })).toBeDisabled();
  });

  it("switches to the folder batch view", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Folder batch" }));
    expect(screen.getByRole("button", { name: "Choose folder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Convert & upload" })).not.toBeInTheDocument();
  });
});

describe("Theme toggle", () => {
  it("clicking Dark applies the dark theme and persists the preference", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("s3reamdark");
    expect(window.localStorage.getItem("s3ream-theme")).toBe("dark");
  });
});

describe("Simple journey", () => {
  it("shows the drop zone and accepts a dropped video file", async () => {
    render(<App />);
    expect(screen.getByText("Drop a video file here")).toBeInTheDocument();

    const zone = screen.getByRole("button", {
      name: "Drop a video file here, or activate to browse",
    });
    const file = new File(["x"], "dropped.mp4", { type: "video/mp4" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    expect(await screen.findByText("dropped.mp4")).toBeInTheDocument();
  });
});

describe("History view", () => {
  it("shows the empty state when there are no records", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "History" }));
    expect(await screen.findByText("No history entries yet.")).toBeInTheDocument();
  });

  it("lists records and copies manifest URLs to the clipboard", async () => {
    listHistoryMock.mockResolvedValue({
      total: 1,
      records: [
        {
          id: "rec-1",
          filePath: "/videos/demo.mp4",
          fileName: "demo.mp4",
          fileHash: null,
          basePrefix: "uploads",
          renditions: ["720p"],
          queueMode: "batch",
          status: "completed",
          manifestUrl: "https://cdn.example.com/uploads/demo/master.m3u8",
          warnings: [],
          error: null,
          queuedAt: 1,
          startedAt: 1,
          completedAt: 2,
        },
      ],
    });

    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "History" }));

    expect(await screen.findByText("demo.mp4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://cdn.example.com/uploads/demo/master.m3u8",
    );
    const confirmations = await screen.findAllByText("Copied to clipboard.");
    expect(confirmations.length).toBeGreaterThan(0);
  });
});

describe("Single conversion progress", () => {
  it("ignores progress events when no local conversion is active", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    expect(screen.getByText(/Select a file and start conversion/)).toBeInTheDocument();

    act(() => {
      bridgeCallbacks.singleProgress.forEach((callback) =>
        callback({
          jobId: "external-job",
          filePath: "/videos/other.mp4",
          fileName: "other.mp4",
          status: "processing",
          stage: "Encoding",
          percent: 42,
          timestamp: Date.now(),
        }),
      );
    });

    // Events from jobs started elsewhere (e.g. the wizard) must not claim the panel.
    expect(screen.queryByText("Encoding")).not.toBeInTheDocument();
    expect(screen.getByText(/Select a file and start conversion/)).toBeInTheDocument();
  });
});

describe("Queue-driven history refresh", () => {
  const makeUpdate = (doneCount: number): QueueUpdate => ({
    queueStatus: "running",
    jobs: [],
    totals: {
      total: doneCount,
      pending: 0,
      processing: 0,
      uploading: 0,
      completed: doneCount,
      failed: 0,
      skipped: 0,
      canceled: 0,
    },
    overallPercent: 0,
    warnings: [],
  });

  it("reloads history only when finished-job totals change", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));

    act(() => {
      bridgeCallbacks.queueUpdate.forEach((callback) => callback(makeUpdate(0)));
    });
    expect(listHistoryMock).not.toHaveBeenCalled();

    act(() => {
      bridgeCallbacks.queueUpdate.forEach((callback) => callback(makeUpdate(1)));
    });
    await vi.waitFor(() => expect(listHistoryMock).toHaveBeenCalledTimes(1));

    // Same finished count — progress-only updates must not reload history.
    act(() => {
      bridgeCallbacks.queueUpdate.forEach((callback) => callback(makeUpdate(1)));
    });
    expect(listHistoryMock).toHaveBeenCalledTimes(1);

    act(() => {
      bridgeCallbacks.queueUpdate.forEach((callback) => callback(makeUpdate(2)));
    });
    await vi.waitFor(() => expect(listHistoryMock).toHaveBeenCalledTimes(2));
  });
});

describe("Journey wizard S3 validation", () => {
  const fillS3Form = async (secret: string) => {
    vi.mocked(bridgeApi.selectVideo).mockResolvedValue("/videos/clip.mp4");
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Drop a video file here, or activate to browse" }),
    );
    expect(await screen.findByText("clip.mp4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("radio", { name: /S3 storage/ }));
    fireEvent.change(screen.getByLabelText("Endpoint URL"), {
      target: { value: "http://localhost:9000" },
    });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "videos" } });
    fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "AKIA" } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: secret } });
  };

  it("requires a non-blank secret when none is saved", async () => {
    await fillS3Form("   ");
    expect(screen.getByRole("button", { name: "Convert & save" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: "Convert & save" })).toBeEnabled();
  });

  it("trims the secret before saving and completes the journey", async () => {
    await fillS3Form("  x  ");
    fireEvent.click(screen.getByRole("button", { name: "Convert & save" }));

    await vi.waitFor(() => expect(bridgeApi.saveSettings).toHaveBeenCalled());
    expect(bridgeApi.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ secretAccessKey: "x" }),
    );
    expect(await screen.findByText("Your stream is ready")).toBeInTheDocument();
  });
});

describe("S3 settings modal", () => {
  it("opens from the header in Advanced view and saves the form", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "S3 settings" }));

    const dialog = await screen.findByRole("dialog", { name: "S3 settings" });
    expect(within(dialog).getByText(/No saved settings yet/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Endpoint URL"), {
      target: { value: "http://localhost:9000" },
    });
    fireEvent.change(within(dialog).getByLabelText("Bucket"), { target: { value: "media" } });
    fireEvent.change(within(dialog).getByLabelText("Access key"), { target: { value: "AKIA" } });
    fireEvent.change(within(dialog).getByLabelText("Secret key"), {
      target: { value: "  secret  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));

    await vi.waitFor(() => expect(bridgeApi.saveSettings).toHaveBeenCalled());
    expect(bridgeApi.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointUrl: "http://localhost:9000",
        bucketName: "media",
        region: "us-east-1",
        secretAccessKey: "secret",
        publicRead: true,
      }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "S3 settings" })).not.toBeInTheDocument(),
    );
  });

  it("prefills saved settings when the modal opens", async () => {
    vi.mocked(bridgeApi.getSettings).mockResolvedValue({
      s3: {
        endpointUrl: "https://s3.example.com",
        region: "eu-west-1",
        bucketName: "saved-bucket",
        bucketUrl: "",
        viewEndpoint: "",
        pathStyle: false,
        uploadConcurrency: 6,
        publicRead: false,
        hasAccessKey: true,
        hasSecretKey: true,
      },
      encryptionAvailable: true,
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "S3 settings" }));

    const dialog = await screen.findByRole("dialog", { name: "S3 settings" });
    await vi.waitFor(() =>
      expect(within(dialog).getByLabelText("Endpoint URL")).toHaveValue("https://s3.example.com"),
    );
    expect(within(dialog).getByLabelText("Bucket")).toHaveValue("saved-bucket");
    expect(within(dialog).getByLabelText("Region")).toHaveValue("eu-west-1");
    expect(within(dialog).getByText(/Saved for bucket saved-bucket/)).toBeInTheDocument();
  });
});
