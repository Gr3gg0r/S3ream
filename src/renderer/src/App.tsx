import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FolderScanResult,
  HistoryRecord,
  JobLogEntry,
  JobStatus,
  QueueUpdate,
  SingleProcessProgress,
  SingleProcessResult
} from "@shared/ipc";

const resolutionOptions = [
  { id: "240p", label: "240p" },
  { id: "360p", label: "360p" },
  { id: "480p", label: "480p" },
  { id: "720p", label: "720p" },
  { id: "1080p", label: "1080p" },
  { id: "2k", label: "1440p" },
  { id: "4k", label: "2160p" }
] as const;

const resolutionOrder = resolutionOptions.map(option => option.id);
const defaultRenditions = ["360p", "480p", "720p"];
const SINGLE_PENDING_JOB_ID = "__pending_single_job__";

type Mode = "single" | "batch" | "history";

interface SelectedFile {
  filePath: string;
  fileName: string;
  size: number;
  selected: boolean;
}

const applyThemePreference = (dark: boolean) => {
  document.documentElement.setAttribute("data-theme", dark ? "mkpbluedark" : "mkpblue");
};

const useSystemThemeSync = () => {
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    applyThemePreference(mediaQuery.matches);
    const listener = (event: MediaQueryListEvent) => applyThemePreference(event.matches);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);
};

const formatBytes = (size: number) => {
  if (size === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[exponent]}`;
};

const statusClassMap: Record<JobStatus, string> = {
  pending: "badge-outline",
  queued: "badge-outline",
  processing: "badge-info",
  uploading: "badge-info",
  paused: "badge-outline",
  completed: "badge-success",
  failed: "badge-error",
  skipped: "badge-warning",
  canceled: "badge-outline"
};

const statusLabel = (status: JobStatus) => {
  switch (status) {
    case "queued":
      return "Queued";
    case "processing":
      return "Converting";
    case "uploading":
      return "Uploading";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "canceled":
      return "Canceled";
    case "paused":
      return "Paused";
    default:
      return status;
  }
};

const percentDisplay = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)}%`;
};

const useCopyFeedback = () => {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (status === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setStatus("idle"), 2000);
    return () => window.clearTimeout(timeout);
  }, [status]);
  return [status, setStatus] as const;
};

function App() {
  const [mode, setMode] = useState<Mode>("single");
  const [basePrefix, setBasePrefix] = useState("");
  const [basePrefixError, setBasePrefixError] = useState<string | null>(null);
  const [selectedRenditions, setSelectedRenditions] = useState<string[]>(defaultRenditions);
  const [singleFile, setSingleFile] = useState<SelectedFile | null>(null);
  const [singleProcessing, setSingleProcessing] = useState(false);
  const [singleResult, setSingleResult] = useState<SingleProcessResult | null>(null);
  const [singleError, setSingleError] = useState<string | null>(null);
  const [singleProgressEvents, setSingleProgressEvents] = useState<SingleProcessProgress[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [folderFiles, setFolderFiles] = useState<SelectedFile[]>([]);
  const [skippedFiles, setSkippedFiles] = useState<Array<{ filePath: string; reason: string }>>([]);
  const [queueUpdate, setQueueUpdate] = useState<QueueUpdate | null>(null);
  const [jobLogs, setJobLogs] = useState<JobLogEntry[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useCopyFeedback();
  const [infoMessages, setInfoMessages] = useState<string[]>([]);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyStatusFilter, setHistoryStatusFilter] = useState<JobStatus | "all">("all");
  const [historySearchInput, setHistorySearchInput] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);
  const [copiedHistoryId, setCopiedHistoryId] = useState<string | null>(null);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(() => new Set());
  const [isBulkUrlModalOpen, setIsBulkUrlModalOpen] = useState(false);
  const [bulkUrlText, setBulkUrlText] = useState("");
  const headerHistoryCheckboxRef = useRef<HTMLInputElement>(null);
  const singleActiveJobIdRef = useRef<string | null>(null);

  useSystemThemeSync();

const pushMessage = useCallback((message: string) => {
  setInfoMessages(previous => {
    const trimmed = previous.slice(-3);
    return [...trimmed, message];
  });
}, []);

useEffect(() => {
  if (!window.api) return;
  window.api.setConcurrency(concurrency);
}, [concurrency]);

  useEffect(() => {
    if (!window.api) return undefined;
    const unbind = window.api.onSingleProgress(progress => {
      setSingleProgressEvents(previous => {
        const activeId = singleActiveJobIdRef.current;
        if (activeId && activeId !== SINGLE_PENDING_JOB_ID && activeId !== progress.jobId) {
          return previous;
        }

        let baseline = previous;
        if (!activeId || activeId === SINGLE_PENDING_JOB_ID) {
          singleActiveJobIdRef.current = progress.jobId;
          baseline = [];
        }

        const updated = [...baseline, progress];
        return updated.length > 50 ? updated.slice(updated.length - 50) : updated;
      });
    });
    return () => unbind?.();
  }, [SINGLE_PENDING_JOB_ID]);

  useEffect(() => {
    if (!window.api) {
      setInfoMessages(["Native bridge unavailable. Application features are limited."]);
      return;
    }
    const unbindQueue = window.api.onQueueUpdate(update => {
      setQueueUpdate(update);
      if (selectedJobId && !update.jobs.some(job => job.id === selectedJobId)) {
        setSelectedJobId(null);
      }
    });
    const unbindLog = window.api.onJobLog(entry => {
      setJobLogs(previous => {
        const merged = [...previous, entry];
        return merged.length > 800 ? merged.slice(merged.length - 800) : merged;
      });
    });
    return () => {
      unbindQueue?.();
      unbindLog?.();
    };
  }, [selectedJobId]);

  useEffect(() => {
    if (!queueUpdate) return;
    if (queueUpdate.warnings?.length) {
      queueUpdate.warnings.forEach(pushMessage);
    }
  }, [queueUpdate, pushMessage]);

  useEffect(() => {
    if (!copiedJobId) return;
    const timeout = window.setTimeout(() => setCopiedJobId(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [copiedJobId]);

  useEffect(() => {
    if (!copiedHistoryId) return;
    const timeout = window.setTimeout(() => setCopiedHistoryId(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [copiedHistoryId]);

  useEffect(() => {
    setSelectedHistoryIds(previous => {
      const next = new Set<string>();
      for (const record of historyRecords) {
        if (previous.has(record.id)) {
          next.add(record.id);
        }
      }
      if (next.size === previous.size) {
        let changed = false;
        previous.forEach(id => {
          if (!next.has(id)) {
            changed = true;
          }
        });
        if (!changed) {
          return previous;
        }
      }
      return next;
    });
  }, [historyRecords]);

  useEffect(() => {
    if (!headerHistoryCheckboxRef.current) return;
    const element = headerHistoryCheckboxRef.current;
    element.indeterminate =
      selectedHistoryIds.size > 0 &&
      historyRecords.some(record => !selectedHistoryIds.has(record.id));
  }, [historyRecords, selectedHistoryIds]);

  const toggleRendition = (id: string) => {
    setSelectedRenditions(previous => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      const sorted = Array.from(next).sort(
        (a, b) => resolutionOrder.indexOf(a) - resolutionOrder.indexOf(b)
      );
      return sorted.length > 0 ? sorted : [];
    });
  };

const selectedRenditionSet = useMemo(() => new Set(selectedRenditions), [selectedRenditions]);

  const loadHistory = useCallback(async () => {
    if (!window.api) return;
    setHistoryLoading(true);
    try {
      const response = await window.api.listHistory({
        status: historyStatusFilter,
        search: historySearch || undefined,
        limit: 100,
        offset: 0
      });
      setHistoryRecords(response.records);
      setHistoryTotal(response.total);
    } catch (error) {
      pushMessage(`Failed to load history: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyStatusFilter, historySearch, pushMessage]);

  useEffect(() => {
    if (!window.api) return;
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (mode === "history") {
      loadHistory();
    }
  }, [mode, loadHistory]);

  useEffect(() => {
    if (!queueUpdate) return;
    if (queueUpdate.jobs.some(job => job.status === "completed" || job.status === "failed")) {
      loadHistory();
    }
  }, [queueUpdate, loadHistory]);

  const handleChooseSingleFile = async () => {
    if (!window.api || singleProcessing) return;
    const selection = await window.api.selectVideo();
    if (!selection) return;
    const fileName = selection.split(pathSeparator()).pop() ?? selection;
    setSingleFile({
      filePath: selection,
      fileName,
      size: 0,
      selected: true
    });
    setSingleResult(null);
    setSingleError(null);
    setSingleProgressEvents([]);
    singleActiveJobIdRef.current = null;
  };

  const handleChooseFolder = async () => {
    if (!window.api) return;
    const folder = await window.api.selectFolder();
    if (!folder) return;
    try {
      const scan: FolderScanResult = await window.api.scanFolder(folder);
      const mapped: SelectedFile[] = scan.files.map(file => ({
        filePath: file.filePath,
        fileName: file.fileName,
        size: file.size,
        selected: true
      }));
      setFolderFiles(mapped);
      setFolderPath(folder);
      setSkippedFiles(scan.skipped);
      setInfoMessages(
        scan.skipped.length > 0
          ? [`Skipped ${scan.skipped.length} unsupported files.`]
          : []
      );
    } catch (error) {
      setInfoMessages([`Failed to scan folder: ${error instanceof Error ? error.message : String(error)}`]);
    }
  };

  const toggleFolderFile = (index: number) => {
    setFolderFiles(previous =>
      previous.map((entry, idx) => (idx === index ? { ...entry, selected: !entry.selected } : entry))
    );
  };

  const handleProcessSingle = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.api || !singleFile || singleProcessing) return;
    if (selectedRenditions.length === 0) {
      pushMessage("Select at least one rendition before converting.");
      return;
    }
    const trimmedPrefix = basePrefix.trim();
    if (trimmedPrefix.length === 0) {
      setBasePrefixError("Object path prefix is required.");
      pushMessage("Object path prefix is required.");
      return;
    }
    setBasePrefixError(null);

    setBasePrefixError(null);
    setSingleProcessing(true);
    setSingleError(null);
    setSingleResult(null);
    setSingleProgressEvents([]);
    singleActiveJobIdRef.current = SINGLE_PENDING_JOB_ID;
    try {
      const response = await window.api.processSingle({
        basePrefix: trimmedPrefix,
        filePath: singleFile.filePath,
        renditions: selectedRenditions
      });
      setSingleResult(response);
      if (response.success) {
        pushMessage("Conversion completed.");
      } else {
        const message = response.error ?? "Conversion failed.";
        setSingleError(message);
        pushMessage(message);
      }
      loadHistory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSingleError(message);
      pushMessage(`Failed to convert: ${message}`);
    } finally {
      setSingleProcessing(false);
      singleActiveJobIdRef.current = null;
    }
  };

  const handleQueueBatch = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.api) return;
    const selected = folderFiles.filter(file => file.selected);
    if (selected.length === 0) {
      pushMessage("Select at least one file to process.");
      return;
    }
    const trimmedPrefix = basePrefix.trim();
    if (trimmedPrefix.length === 0) {
      setBasePrefixError("Object path prefix is required.");
      pushMessage("Object path prefix is required.");
      return;
    }
    try {
      const { jobIds, skipped } = await window.api.queueJobs({
        basePrefix: trimmedPrefix,
        files: selected.map(file => ({ filePath: file.filePath })),
        renditions: selectedRenditions,
        mode: "batch",
        concurrency
      });
      if (skipped.length > 0) {
        skipped.forEach(entry => pushMessage(`Skipped ${path.basename(entry.filePath)} (${entry.reason}).`));
      }
      pushMessage(`Queued ${selected.length - skipped.length} files for processing.`);
      if (jobIds.length > 0) {
        setSelectedJobId(jobIds[0]);
      }
    } catch (error) {
      pushMessage(`Failed to queue batch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleQueueControl = async (action: "pause" | "resume" | "cancel-current" | "cancel-remaining" | "clear-completed") => {
    if (!window.api) return;
    try {
      await window.api.controlQueue(action);
    } catch (error) {
      pushMessage(`Queue control failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleCopyUrl = async (url: string | undefined, options?: { jobId?: string; historyId?: string }) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("copied");
      if (options?.jobId) {
        setCopiedJobId(options.jobId);
      }
      if (options?.historyId) {
        setCopiedHistoryId(options.historyId);
      }
    } catch {
      setCopyStatus("error");
      if (options?.jobId) {
        setCopiedJobId(options.jobId);
      }
      if (options?.historyId) {
        setCopiedHistoryId(options.historyId);
      }
    }
  };

  const handleHistorySearchSubmit = (event: FormEvent) => {
    event.preventDefault();
    setHistorySearch(historySearchInput.trim());
  };

  const handleHistoryRefresh = () => {
    loadHistory();
  };

  const toggleHistorySelection = (historyId: string) => {
    setSelectedHistoryIds(previous => {
      const next = new Set(previous);
      if (next.has(historyId)) {
        next.delete(historyId);
      } else {
        next.add(historyId);
      }
      return next;
    });
  };

  const toggleHistorySelectAll = () => {
    setSelectedHistoryIds(previous => {
      if (historyRecords.length === 0) {
        return previous.size === 0 ? previous : new Set<string>();
      }
      const shouldSelectAll = historyRecords.some(record => !previous.has(record.id));
      if (!shouldSelectAll) {
        return previous.size === 0 ? previous : new Set<string>();
      }
      const next = new Set<string>();
      historyRecords.forEach(record => next.add(record.id));
      return next;
    });
  };

  const handleGenerateBulkUrls = () => {
    const urls = historyRecords
      .filter(record => selectedHistoryIds.has(record.id))
      .map(record => record.manifestUrl)
      .filter((url): url is string => Boolean(url && url.trim().length > 0));
    if (urls.length === 0) {
      pushMessage("Select history entries with URLs before generating.");
      return;
    }
    setBulkUrlText(urls.join("\n"));
    setIsBulkUrlModalOpen(true);
  };

  const handleCopyBulkUrls = async () => {
    if (!bulkUrlText) {
      pushMessage("No URLs to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(bulkUrlText);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  };

  const handleHistoryDelete = async (record: HistoryRecord) => {
    if (!window.api) return;
    try {
      await window.api.deleteHistory(record.id);
      setSelectedHistoryIds(previous => {
        if (!previous.has(record.id)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(record.id);
        return next;
      });
      pushMessage(`Removed ${record.fileName} from history`);
      loadHistory();
    } catch (error) {
      pushMessage(`Failed to delete history: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const queueTotals = queueUpdate?.totals;
  const overallPercent = queueUpdate?.overallPercent ?? 0;
  const jobs = queueUpdate?.jobs ?? [];

  const filteredLogs = useMemo(() => {
    const list = selectedJobId ? jobLogs.filter(entry => entry.jobId === selectedJobId) : jobLogs;
    return [...list].slice(-200).reverse();
  }, [jobLogs, selectedJobId]);

  const activeJob = selectedJobId ? jobs.find(job => job.id === selectedJobId) : undefined;
  const selectedHistoryCount = selectedHistoryIds.size;
  const allHistorySelected =
    historyRecords.length > 0 && historyRecords.every(record => selectedHistoryIds.has(record.id));
  const bulkUrlCount = useMemo(
    () => (bulkUrlText.trim().length === 0 ? 0 : bulkUrlText.split("\n").filter(Boolean).length),
    [bulkUrlText]
  );
  const currentSingleProgress = singleProgressEvents.length
    ? singleProgressEvents[singleProgressEvents.length - 1]
    : null;
  const singleProgressTail = useMemo(() => singleProgressEvents.slice(-10).reverse(), [singleProgressEvents]);
  const singleProgressPercent = currentSingleProgress?.percent ?? (singleProcessing ? 0 : singleProgressEvents.length > 0 ? 100 : 0);
  const normalizedSingleProgress = Number.isFinite(singleProgressPercent)
    ? Math.min(Math.max(singleProgressPercent, 0), 100)
    : 0;

  return (
    <>
      <div className="min-h-screen bg-base-200 px-6 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-primary">MKP Upload Services</h1>
              <p className="text-sm opacity-80">
                Convert videos to multi-rendition HLS, upload to S3-compatible storage, and track batch progress with live logs.
              </p>
            </div>
            <div className="btn-group">
              <button
                type="button"
                className={`btn btn-sm ${mode === "single" ? "btn-primary" : "btn-outline"}`}
                onClick={() => setMode("single")}
              >
                Single file
              </button>
              <button
                type="button"
                className={`btn btn-sm ${mode === "batch" ? "btn-primary" : "btn-outline"}`}
                onClick={() => setMode("batch")}
              >
                Folder batch
              </button>
              <button
                type="button"
                className={`btn btn-sm ${mode === "history" ? "btn-primary" : "btn-outline"}`}
                onClick={() => setMode("history")}
              >
                History
              </button>
            </div>
          </header>

          {infoMessages.length > 0 && (
            <div className="alert alert-info flex-col items-start gap-1">
              {infoMessages.map(message => (
                <span key={message}>{message}</span>
              ))}
            </div>
          )}

          {mode === "single" && (
            <section className="card bg-base-100 shadow-lg">
              <div className="card-body gap-6">
                <form className="flex flex-col gap-6" onSubmit={handleProcessSingle}>
                  <div className="grid gap-4 md:grid-cols-2 md:gap-6">
                    <div className="form-control md:col-span-2">
                      <label className="label">
                        <span className="label-text font-medium">Video source</span>
                      </label>
                      <div className="join">
                        <input
                          type="text"
                          value={singleFile?.filePath ?? ""}
                          placeholder="Select a file..."
                          readOnly
                          className="input input-bordered join-item w-full"
                          disabled={singleProcessing}
                        />
                        <button
                          type="button"
                          className="btn btn-primary join-item"
                          onClick={handleChooseSingleFile}
                          disabled={singleProcessing}
                        >
                          Choose file
                        </button>
                      </div>
                      <label className="label">
                        <span className="label-text-alt opacity-60">
                          Supports MP4, MOV, MKV, AVI, M4V, and WEBM containers.
                        </span>
                      </label>
                    </div>

                    <div className="form-control">
                      <label className="label">
                        <span className="label-text font-medium">Object path prefix</span>
                      </label>
                      <input
                        type="text"
                        value={basePrefix}
                        onChange={event => {
                          const value = event.target.value;
                          setBasePrefix(value);
                          if (value.trim().length > 0) {
                            setBasePrefixError(null);
                          }
                        }}
                        placeholder="uploads/my-project"
                        className={`input input-bordered ${basePrefixError ? "input-error" : ""}`}
                        disabled={singleProcessing}
                      />
                      <label className="label">
                        <span className="label-text-alt opacity-60">
                          Each file is uploaded under <code>{basePrefix.trim() || "(prefix)"}/{`<filename>/`}</code>
                        </span>
                        {basePrefixError ? (
                          <span className="label-text-alt text-error">{basePrefixError}</span>
                        ) : null}
                      </label>
                    </div>
                  </div>

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text font-medium">Output renditions</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {resolutionOptions.map(option => {
                        const isSelected = selectedRenditionSet.has(option.id);
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className={`btn btn-sm ${isSelected ? "btn-primary" : "btn-outline"} uppercase`}
                            onClick={() => toggleRendition(option.id)}
                            disabled={singleProcessing}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <label className="label">
                      <span className="label-text-alt opacity-60">
                        Defaults to 360p, 480p, and 720p. Higher renditions are skipped if the source is too small.
                      </span>
                    </label>
                  </div>

                  <button
                    type="submit"
                    className={`btn btn-primary ${singleProcessing ? "loading" : ""}`}
                    disabled={
                      !singleFile ||
                      selectedRenditions.length === 0 ||
                      singleProcessing ||
                      basePrefix.trim().length === 0
                    }
                  >
                    {singleProcessing ? "Processing…" : "Convert & upload"}
                  </button>
                </form>
              </div>
            </section>
          )}

          {mode === "single" && (
            <section className="card bg-base-100 shadow-lg">
              <div className="card-body gap-4">
                <h2 className="card-title text-lg">Result</h2>
                {(singleProcessing || singleProgressEvents.length > 0) && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold uppercase tracking-wide text-primary">
                        {currentSingleProgress?.stage ?? "Preparing"}
                      </span>
                      <span className="badge badge-outline badge-sm">
                        {percentDisplay(normalizedSingleProgress)}
                      </span>
                    </div>
                    <progress
                      className="progress progress-primary w-full"
                      value={normalizedSingleProgress}
                      max={100}
                    />
                    <div className="max-h-36 overflow-y-auto rounded border border-base-200 bg-base-200/40 p-3">
                      {singleProgressEvents.length > 0 ? (
                        <ul className="space-y-1 text-xs font-mono">
                          {singleProgressTail.map(event => (
                            <li key={`${event.jobId}-${event.timestamp}`}>
                              <span className="font-semibold text-primary">{event.stage}</span>
                              {event.message ? <span className="opacity-80"> — {event.message}</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs opacity-60">Preparing job…</span>
                      )}
                    </div>
                    {singleProcessing && (
                      <p className="text-xs opacity-60">All fields are locked until the upload finishes.</p>
                    )}
                  </div>
                )}
                {!singleProcessing && (
                  <div className="space-y-3">
                    {singleError && (
                      <div className="alert alert-error flex-col items-start gap-1">
                        <span>{singleError}</span>
                      </div>
                    )}
                    {singleResult ? (
                      <div className="space-y-3">
                        <div>
                          <div className="font-medium text-primary">{singleFile?.fileName ?? "Conversion complete"}</div>
                          {singleResult.details && (
                            <p className="text-xs opacity-70">{singleResult.details}</p>
                          )}
                        </div>
                        {singleResult.manifestUrl ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="badge badge-outline whitespace-pre-wrap break-all">
                              {singleResult.manifestUrl}
                            </code>
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              onClick={() =>
                                handleCopyUrl(singleResult.manifestUrl ?? undefined, { jobId: singleResult.jobId })
                              }
                            >
                              Copy URL
                            </button>
                            {copiedJobId === singleResult.jobId && (
                              <span className="text-xs text-success">Copied!</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs opacity-70">Manifest URL not available.</span>
                        )}
                        {singleResult.warnings && singleResult.warnings.length > 0 && (
                          <div className="alert alert-warning flex-col items-start gap-1">
                            {singleResult.warnings.map(warning => (
                              <span key={warning}>{warning}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm opacity-70">
                        Select a file and start conversion to see the streaming URL here.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {mode === "batch" && (
            <section className="card bg-base-100 shadow-lg">
              <div className="card-body gap-6">
                <form className="flex flex-col gap-6" onSubmit={handleQueueBatch}>
                  <div className="form-control">
                    <label className="label">
                      <span className="label-text font-medium">Folder to ingest</span>
                    </label>
                    <div className="join">
                      <input
                        type="text"
                        value={folderPath}
                        placeholder="Select a folder..."
                        readOnly
                        className="input input-bordered join-item w-full"
                      />
                      <button type="button" className="btn btn-primary join-item" onClick={handleChooseFolder}>
                        Choose folder
                      </button>
                    </div>
                    <label className="label">
                      <span className="label-text-alt opacity-60">
                        Only supported video files are queued. Others appear in the skipped list.
                      </span>
                    </label>
                  </div>

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text font-medium">Object path prefix</span>
                    </label>
                    <input
                      type="text"
                      value={basePrefix}
                      onChange={event => {
                        const value = event.target.value;
                        setBasePrefix(value);
                        if (value.trim().length > 0) {
                          setBasePrefixError(null);
                        }
                      }}
                      placeholder="uploads/events"
                      className={`input input-bordered ${basePrefixError ? "input-error" : ""}`}
                      disabled={singleProcessing}
                    />
                    <label className="label">
                      <span className="label-text-alt opacity-60">
                        Uploaded manifests live under <code>{basePrefix.trim() || "(prefix)"}/{`<filename>/`}</code>
                      </span>
                      {basePrefixError ? (
                        <span className="label-text-alt text-error">{basePrefixError}</span>
                      ) : null}
                    </label>
                  </div>

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text font-medium">Output renditions</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {resolutionOptions.map(option => {
                        const isSelected = selectedRenditionSet.has(option.id);
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className={`btn btn-sm ${isSelected ? "btn-primary" : "btn-outline"} uppercase`}
                            onClick={() => toggleRendition(option.id)}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text font-medium">Concurrency</span>
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="number"
                        min={1}
                        max={16}
                        value={concurrency}
                        onChange={event => {
                          const next = Number(event.target.value);
                          if (Number.isNaN(next)) {
                            setConcurrency(1);
                          } else {
                            setConcurrency(Math.max(1, Math.min(16, Math.floor(next))));
                          }
                        }}
                        className="input input-bordered w-24"
                      />
                      <p className="text-xs opacity-70">
                        Default 2. Higher values use more CPU/disk; excessive concurrency may slow or crash the system.
                      </p>
                    </div>
                  </div>

                  {folderFiles.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-base-300">
                      <table className="table table-zebra">
                        <thead>
                          <tr>
                            <th />
                            <th>File</th>
                            <th>Size</th>
                            <th>Path</th>
                          </tr>
                        </thead>
                        <tbody>
                          {folderFiles.map((file, index) => (
                            <tr key={file.filePath}>
                              <td>
                                <input
                                  type="checkbox"
                                  className="checkbox checkbox-sm"
                                  checked={file.selected}
                                  onChange={() => toggleFolderFile(index)}
                                />
                              </td>
                              <td>{file.fileName}</td>
                              <td className="text-sm opacity-70">{formatBytes(file.size)}</td>
                              <td className="text-xs opacity-60 break-all">{file.filePath}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {skippedFiles.length > 0 && (
                    <div className="alert alert-warning flex-col items-start gap-1">
                      <span className="font-semibold">Skipped files</span>
                      <ul className="list-disc pl-5 text-sm">
                        {skippedFiles.slice(0, 5).map(file => (
                          <li key={file.filePath}>{file.filePath}</li>
                        ))}
                        {skippedFiles.length > 5 && (
                          <li>And {skippedFiles.length - 5} more unsupported files…</li>
                        )}
                      </ul>
                    </div>
                  )}

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={
                      folderFiles.every(file => !file.selected) ||
                      selectedRenditions.length === 0 ||
                      basePrefix.trim().length === 0
                    }
                  >
                    Queue selected files ({folderFiles.filter(file => file.selected).length})
                  </button>
                </form>
              </div>
            </section>
          )}

          {mode === "batch" && (
            <section className="card bg-base-100 shadow-lg">
              <div className="card-body gap-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="card-title text-lg">Queue progress</h2>
                  <p className="text-xs opacity-60">
                    {queueUpdate?.queueStatus === "running" && "Processing jobs…"}
                    {queueUpdate?.queueStatus === "paused" && "Queue paused"}
                    {queueUpdate?.queueStatus === "idle" && "Queue idle"}
                  </p>
                </div>
                <div className="btn-group btn-group-sm">
                  {queueUpdate?.queueStatus !== "paused" ? (
                    <button type="button" className="btn btn-outline" onClick={() => handleQueueControl("pause")}>
                      Pause
                    </button>
                  ) : (
                    <button type="button" className="btn btn-outline" onClick={() => handleQueueControl("resume")}>
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => handleQueueControl("cancel-remaining")}
                  >
                    Cancel remaining
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => handleQueueControl("clear-completed")}
                  >
                    Clear completed
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setIsLogOpen(true)}
                    disabled={jobLogs.length === 0}
                  >
                    View live log
                  </button>
                </div>
              </div>

              <progress className="progress progress-primary w-full" value={overallPercent} max={100} />

              {queueTotals && (
                <div className="stats stats-horizontal shadow">
                  <div className="stat">
                    <div className="stat-title">Total</div>
                    <div className="stat-value text-primary">{queueTotals.total}</div>
                    <div className="stat-desc">Jobs in queue</div>
                  </div>
                  <div className="stat">
                    <div className="stat-title">Completed</div>
                    <div className="stat-value text-success">{queueTotals.completed}</div>
                    <div className="stat-desc text-xs">
                      Failed {queueTotals.failed} / Skipped {queueTotals.skipped}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="stat-title">Active</div>
                    <div className="stat-value text-info">
                      {queueTotals.processing + queueTotals.uploading}
                    </div>
                    <div className="stat-desc text-xs">
                      Pending {queueTotals.pending} / Canceled {queueTotals.canceled}
                    </div>
                  </div>
                </div>
              )}
              </div>
            </section>
          )}

          {mode === "batch" && (
            <section className="card bg-base-100 shadow-lg">
              <div className="card-body gap-4">
              <h2 className="card-title text-lg">Jobs</h2>
              <div className="overflow-x-auto rounded-lg border border-base-300">
                <table className="table table-zebra">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Status</th>
                      <th>Progress</th>
                      <th>Object key</th>
                      <th>Message</th>
                      <th>Manifest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center text-sm opacity-70">
                          No jobs queued yet.
                        </td>
                      </tr>
                    ) : (
                      jobs.map(job => (
                        <tr
                          key={job.id}
                          className={selectedJobId === job.id ? "active" : ""}
                          onClick={() => setSelectedJobId(job.id)}
                        >
                          <td className="w-64">
                            <div className="font-medium truncate">{job.fileName}</div>
                            <div className="text-xs opacity-70 truncate">{job.filePath}</div>
                          </td>
                          <td className="w-28">
                            <span className={`badge badge-sm ${statusClassMap[job.status]}`}>
                              {statusLabel(job.status)}
                            </span>
                          </td>
                          <td className="w-20">{percentDisplay(job.percent)}</td>
                          <td className="w-64 text-xs opacity-70 break-all">{job.objectKey}</td>
                          <td className="text-xs opacity-70">{job.message}</td>
                          <td className="w-40">
                            {job.manifestUrl ? (
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  className="btn btn-xs btn-secondary"
                                  onClick={() => handleCopyUrl(job.manifestUrl, { jobId: job.id })}
                                >
                                  Copy URL
                                </button>
                                {copiedJobId === job.id && (
                                  <span className="text-xs text-success">Copied!</span>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs opacity-50">Pending</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {copyStatus !== "idle" && (
                <div className="text-xs text-info">
                  {copyStatus === "copied" ? "Copied to clipboard." : "Copy failed. Try again."}
                </div>
              )}
              </div>
            </section>
          )}

          {mode === "history" && (
            <section className="card bg-base-100 shadow-lg">
              <div className="card-body gap-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="card-title text-lg">History</h2>
                  <p className="text-xs opacity-60">
                    Stored results for processed files (showing {historyRecords.length} of {historyTotal}).
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <form className="join" onSubmit={handleHistorySearchSubmit}>
                    <input
                      type="text"
                      placeholder="Search history…"
                      className="input input-bordered input-sm join-item"
                      value={historySearchInput}
                      onChange={event => setHistorySearchInput(event.target.value)}
                    />
                    <button type="submit" className="btn btn-sm btn-primary join-item">
                      Search
                    </button>
                  </form>
                  <select
                    className="select select-bordered select-sm"
                    value={historyStatusFilter}
                    onChange={event => setHistoryStatusFilter(event.target.value as JobStatus | "all")}
                  >
                    <option value="all">All statuses</option>
                    <option value="completed">Completed</option>
                    <option value="failed">Failed</option>
                    <option value="skipped">Skipped</option>
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    disabled={selectedHistoryCount === 0}
                    onClick={handleGenerateBulkUrls}
                  >
                    Generate URLs
                  </button>
                  {selectedHistoryCount > 0 && (
                    <span className="text-xs opacity-60">{selectedHistoryCount} selected</span>
                  )}
                  <button type="button" className="btn btn-sm btn-outline" onClick={handleHistoryRefresh}>
                    {historyLoading ? "Loading…" : "Refresh"}
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-base-300">
                <table className="table table-zebra">
                  <thead>
                    <tr>
                      <th className="w-10">
                        <input
                          ref={headerHistoryCheckboxRef}
                          type="checkbox"
                          className="checkbox checkbox-sm"
                          checked={allHistorySelected}
                          onChange={toggleHistorySelectAll}
                          aria-label="Select all history entries"
                        />
                      </th>
                      <th>Completed</th>
                      <th>File</th>
                      <th>Status</th>
                      <th>Manifest</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRecords.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center text-sm opacity-70">
                          No history entries yet.
                        </td>
                      </tr>
                    ) : (
                      historyRecords.map(record => (
                        <tr key={record.id}>
                          <td className="align-middle">
                            <input
                              type="checkbox"
                              className="checkbox checkbox-sm"
                              checked={selectedHistoryIds.has(record.id)}
                              onChange={() => toggleHistorySelection(record.id)}
                              aria-label={`Select ${record.fileName}`}
                            />
                          </td>
                          <td className="text-xs">
                            {record.completedAt
                              ? new Date(record.completedAt).toLocaleString()
                              : "—"}
                          </td>
                          <td className="w-48">
                            <div className="font-medium truncate" title={record.fileName}>
                              {record.fileName}
                            </div>
                          </td>
                          <td className="w-24">
                            <span className={`badge badge-xs ${statusClassMap[record.status]}`}>
                              {statusLabel(record.status)}
                            </span>
                          </td>
                          <td className="align-middle">
                            <span
                              className="text-xs opacity-70 block"
                              style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}
                              title={record.manifestUrl ?? "No manifest URL"}
                            >
                              {record.manifestUrl ?? "—"}
                            </span>
                          </td>
                          <td className="w-52">
                            <div className="flex flex-wrap items-center gap-2">
                              {record.manifestUrl ? (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-xs"
                                  onClick={() =>
                                    handleCopyUrl(record.manifestUrl ?? undefined, { historyId: record.id })
                                  }
                                >
                                  Copy URL
                                </button>
                              ) : (
                                <span className="text-xs opacity-50 whitespace-nowrap">No URL</span>
                              )}
                              <button
                                type="button"
                                className="btn btn-outline btn-xs"
                                onClick={() => handleHistoryDelete(record)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {copyStatus !== "idle" && (
                <div className="text-xs text-info">
                  {copyStatus === "copied" ? "Copied to clipboard." : "Copy failed. Try again."}
                </div>
              )}
              </div>
            </section>
          )}

        </div>
      </div>

      {isBulkUrlModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-base-300/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setIsBulkUrlModalOpen(false)}
        >
          <div
            className="card w-full max-w-3xl bg-base-100 shadow-2xl"
            onClick={event => event.stopPropagation()}
          >
            <div className="card-body gap-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="card-title text-lg">Bulk URLs</h2>
                  <p className="text-xs opacity-60">
                    {bulkUrlCount} link{bulkUrlCount === 1 ? "" : "s"} ready to copy.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => setIsBulkUrlModalOpen(false)}
                >
                  Close
                </button>
              </div>
              <textarea
                className="textarea textarea-bordered h-64 w-full resize-none font-mono text-xs"
                value={bulkUrlText}
                readOnly
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs opacity-60">
                  Copy to paste the selected manifest URLs wherever you need them.
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleCopyBulkUrls}
                  disabled={bulkUrlCount === 0}
                >
                  Copy all
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isLogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-base-300/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setIsLogOpen(false)}
        >
          <div
            className="card w-full max-w-4xl bg-base-100 shadow-2xl"
            onClick={event => event.stopPropagation()}
          >
            <div className="card-body gap-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="card-title text-lg">Live job log</h2>
                  <p className="text-xs opacity-60">
                    Most recent events first. Showing {filteredLogs.length} entries.
                  </p>
                  {activeJob && (
                    <p className="text-xs opacity-80">
                      Focused job: <span className="font-medium">{activeJob.fileName}</span>
                    </p>
                  )}
                </div>
                <button type="button" className="btn btn-sm btn-outline" onClick={() => setIsLogOpen(false)}>
                  Close
                </button>
              </div>
              <div className="max-h-[70vh] overflow-y-auto rounded border border-base-300 bg-base-200/40">
                <table className="table table-pin-rows table-sm">
                  <thead className="bg-base-200">
                    <tr>
                      <th className="w-28">Time</th>
                      <th className="w-32">File</th>
                      <th className="w-24">Status</th>
                      <th>Stage / message</th>
                      <th className="w-12 text-right">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center text-sm opacity-70">
                          No log entries yet.
                        </td>
                      </tr>
                    ) : (
                      filteredLogs.map(entry => {
                        const job = jobs.find(j => j.id === entry.jobId);
                        return (
                          <tr key={entry.id}>
                            <td className="align-top text-xs font-mono">
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </td>
                            <td className="align-top text-xs">
                              {job?.fileName ?? entry.jobId.slice(0, 8)}
                            </td>
                            <td className="align-top">
                              <span className={`badge badge-outline badge-xs capitalize ${statusClassMap[entry.status]}`}>
                                {statusLabel(entry.status)}
                              </span>
                            </td>
                            <td className="align-top text-xs">
                              <div className="font-medium">{entry.stage}</div>
                              {entry.message && <div className="opacity-70">{entry.message}</div>}
                            </td>
                            <td className="align-top text-right text-xs">
                              {entry.percent !== undefined ? entry.percent.toFixed(1) : "—"}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const pathSeparator = () => (navigator.platform.startsWith("Win") ? "\\" : "/");

export default App;
