import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettingsView,
  FolderScanResult,
  HistoryRecord,
  JobLogEntry,
  JobStatus,
  QueueUpdate,
  SingleProcessProgress,
  SingleProcessResult,
} from "@shared/ipc";
import { useTheme } from "@renderer/hooks/useTheme";
import { useDialogA11y } from "@renderer/hooks/useDialogA11y";
import { ThemeToggle } from "@renderer/components/ThemeToggle";
import { JourneyWizard } from "@renderer/components/JourneyWizard";
import { RenditionPicker } from "@renderer/components/RenditionPicker";
import { Clock, Settings, SlidersHorizontal, Sparkles } from "@renderer/components/icons";
import {
  COPY_FEEDBACK_MS,
  defaultRenditions,
  formatBytes,
  formatError,
  pathSeparator,
  resolutionOrder,
} from "@renderer/constants";

const SINGLE_PENDING_JOB_ID = "__pending_single_job__";
const formatDuration = (milliseconds: number) => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "00:00:00";
  }
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
};

type Mode = "single" | "batch";
type View = "simple" | "advanced" | "history";

const VIEW_STORAGE_KEY = "hulesa-view";

const readStoredView = (): View => {
  const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
  if (stored === "simple" || stored === "advanced" || stored === "history") {
    return stored;
  }
  return "simple";
};

interface SelectedFile {
  filePath: string;
  fileName: string;
  size: number;
  selected: boolean;
}

const statusClassMap: Record<JobStatus, string> = {
  pending: "linear-badge-neutral",
  queued: "linear-badge-neutral",
  processing: "linear-badge-info",
  uploading: "linear-badge-info",
  completed: "linear-badge-success",
  failed: "linear-badge-error",
  skipped: "linear-badge-warning",
  canceled: "linear-badge-neutral",
};

const statusLabel = (status: JobStatus) => {
  switch (status) {
    case "pending":
      return "Pending";
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
    const timeout = window.setTimeout(() => setStatus("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timeout);
  }, [status]);
  return [status, setStatus] as const;
};

function App() {
  const [mode, setMode] = useState<Mode>("single");
  const [view, setViewState] = useState<View>(readStoredView);
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
  const [infoMessages, setInfoMessages] = useState<Array<{ id: number; message: string }>>([]);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyStatusFilter, setHistoryStatusFilter] = useState<JobStatus | "all">("all");
  const [historySearchInput, setHistorySearchInput] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);
  const [copiedHistoryId, setCopiedHistoryId] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [singleElapsedMs, setSingleElapsedMs] = useState(0);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(() => new Set());
  const [isBulkUrlModalOpen, setIsBulkUrlModalOpen] = useState(false);
  const [bulkUrlText, setBulkUrlText] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<AppSettingsView | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [s3EndpointUrl, setS3EndpointUrl] = useState("");
  const [s3BucketName, setS3BucketName] = useState("");
  const [s3Region, setS3Region] = useState("");
  const [s3ViewEndpoint, setS3ViewEndpoint] = useState("");
  const [s3BucketUrl, setS3BucketUrl] = useState("");
  const [s3PathStyle, setS3PathStyle] = useState(true);
  const [s3PublicRead, setS3PublicRead] = useState(true);
  const [s3UploadConcurrency, setS3UploadConcurrency] = useState(4);
  const [s3AccessKeyId, setS3AccessKeyId] = useState("");
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const headerHistoryCheckboxRef = useRef<HTMLInputElement>(null);
  const singleActiveJobIdRef = useRef<string | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const elapsedStartRef = useRef<number | null>(null);
  const elapsedOffsetRef = useRef(0);
  const singleElapsedTimerRef = useRef<number | null>(null);
  const singleElapsedStartRef = useRef<number | null>(null);
  const bulkUrlDialogRef = useRef<HTMLDivElement>(null);
  const logDialogRef = useRef<HTMLDivElement>(null);
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const infoMessageIdRef = useRef(0);
  const historyReloadCountRef = useRef(0);
  const selectedJobIdRef = useRef<string | null>(null);

  const { preference, setPreference } = useTheme();

  const setView = useCallback((next: View) => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    setViewState(next);
  }, []);

  const closeBulkUrlModal = useCallback(() => setIsBulkUrlModalOpen(false), []);
  const closeLogModal = useCallback(() => setIsLogOpen(false), []);
  const closeSettings = useCallback(() => setIsSettingsOpen(false), []);
  useDialogA11y(isBulkUrlModalOpen, closeBulkUrlModal, bulkUrlDialogRef);
  useDialogA11y(isLogOpen, closeLogModal, logDialogRef);
  useDialogA11y(isSettingsOpen, closeSettings, settingsDialogRef);

  const pushMessage = useCallback((message: string) => {
    const id = ++infoMessageIdRef.current;
    setInfoMessages((previous) => [...previous.slice(-3), { id, message }]);
  }, []);

  useEffect(() => {
    if (!window.api) return;
    void window.api.setConcurrency(concurrency);
  }, [concurrency]);

  useEffect(() => {
    return () => {
      if (elapsedTimerRef.current !== null) {
        window.clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      if (singleElapsedTimerRef.current !== null) {
        window.clearInterval(singleElapsedTimerRef.current);
        singleElapsedTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const status = queueUpdate?.queueStatus;
    if (status === "running") {
      if (elapsedStartRef.current === null) {
        elapsedStartRef.current = Date.now();
      }
      const updateElapsed = () => {
        const start = elapsedStartRef.current;
        if (start === null) {
          setElapsedMs(elapsedOffsetRef.current);
        } else {
          setElapsedMs(elapsedOffsetRef.current + (Date.now() - start));
        }
      };
      updateElapsed();
      if (elapsedTimerRef.current === null) {
        elapsedTimerRef.current = window.setInterval(updateElapsed, 1000);
      }
    } else if (status === "paused") {
      if (elapsedTimerRef.current !== null) {
        window.clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      if (elapsedStartRef.current !== null) {
        elapsedOffsetRef.current += Date.now() - elapsedStartRef.current;
        elapsedStartRef.current = null;
      }
      setElapsedMs(elapsedOffsetRef.current);
    } else if (status === "idle") {
      if (elapsedTimerRef.current !== null) {
        window.clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      if (elapsedStartRef.current !== null) {
        elapsedOffsetRef.current += Date.now() - elapsedStartRef.current;
        elapsedStartRef.current = null;
      }
      const finalElapsed = elapsedOffsetRef.current;
      setElapsedMs(finalElapsed);
      elapsedOffsetRef.current = 0;
    } else {
      if (elapsedTimerRef.current !== null) {
        window.clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      elapsedStartRef.current = null;
      elapsedOffsetRef.current = 0;
      setElapsedMs(0);
    }
  }, [queueUpdate?.queueStatus]);

  useEffect(() => {
    if (singleProcessing) {
      if (singleElapsedTimerRef.current !== null) {
        window.clearInterval(singleElapsedTimerRef.current);
      }
      singleElapsedStartRef.current = Date.now();
      setSingleElapsedMs(0);
      singleElapsedTimerRef.current = window.setInterval(() => {
        if (singleElapsedStartRef.current !== null) {
          setSingleElapsedMs(Date.now() - singleElapsedStartRef.current);
        }
      }, 1000);
    } else {
      if (singleElapsedTimerRef.current !== null) {
        window.clearInterval(singleElapsedTimerRef.current);
        singleElapsedTimerRef.current = null;
      }
      if (singleElapsedStartRef.current !== null) {
        setSingleElapsedMs(Date.now() - singleElapsedStartRef.current);
        singleElapsedStartRef.current = null;
      }
    }
  }, [singleProcessing]);

  useEffect(() => {
    if (!window.api) return undefined;
    const unbind = window.api.onSingleProgress((progress) => {
      const activeId = singleActiveJobIdRef.current;
      // Ignore events from jobs started elsewhere (e.g. the Simple wizard).
      if (
        activeId === null ||
        (activeId !== SINGLE_PENDING_JOB_ID && activeId !== progress.jobId)
      ) {
        return;
      }
      if (activeId === SINGLE_PENDING_JOB_ID) {
        singleActiveJobIdRef.current = progress.jobId;
        setSingleProgressEvents([progress]);
        return;
      }
      setSingleProgressEvents((previous) => {
        const updated = [...previous, progress];
        return updated.length > 50 ? updated.slice(updated.length - 50) : updated;
      });
    });
    return () => unbind();
  }, []);

  useEffect(() => {
    selectedJobIdRef.current = selectedJobId;
  }, [selectedJobId]);

  useEffect(() => {
    if (!window.api) {
      pushMessage("Native bridge unavailable. Application features are limited.");
      return;
    }
    const unbindQueue = window.api.onQueueUpdate((update) => {
      setQueueUpdate(update);
      const selectedId = selectedJobIdRef.current;
      if (selectedId && !update.jobs.some((job) => job.id === selectedId)) {
        setSelectedJobId(null);
      }
    });
    const unbindLog = window.api.onJobLog((entry) => {
      setJobLogs((previous) => {
        const merged = [...previous, entry];
        return merged.length > 800 ? merged.slice(merged.length - 800) : merged;
      });
    });
    return () => {
      unbindQueue();
      unbindLog();
    };
  }, [pushMessage]);

  useEffect(() => {
    if (!queueUpdate) return;
    if (queueUpdate.warnings?.length) {
      queueUpdate.warnings.forEach(pushMessage);
    }
  }, [queueUpdate, pushMessage]);

  useEffect(() => {
    if (!copiedJobId) return;
    const timeout = window.setTimeout(() => setCopiedJobId(null), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timeout);
  }, [copiedJobId]);

  useEffect(() => {
    if (!copiedHistoryId) return;
    const timeout = window.setTimeout(() => setCopiedHistoryId(null), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timeout);
  }, [copiedHistoryId]);

  useEffect(() => {
    setSelectedHistoryIds((previous) => {
      const next = new Set<string>();
      for (const record of historyRecords) {
        if (previous.has(record.id)) {
          next.add(record.id);
        }
      }
      // next is built exclusively from ids in previous, so equal sizes
      // already mean identical sets.
      if (next.size === previous.size) {
        return previous;
      }
      return next;
    });
  }, [historyRecords]);

  useEffect(() => {
    if (!headerHistoryCheckboxRef.current) return;
    const element = headerHistoryCheckboxRef.current;
    element.indeterminate =
      selectedHistoryIds.size > 0 &&
      historyRecords.some((record) => !selectedHistoryIds.has(record.id));
  }, [historyRecords, selectedHistoryIds]);

  const toggleRendition = (id: string) => {
    setSelectedRenditions((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      const sorted = Array.from(next).sort(
        (a, b) => resolutionOrder.indexOf(a) - resolutionOrder.indexOf(b),
      );
      return sorted;
    });
  };

  const formattedElapsed = useMemo(() => formatDuration(elapsedMs), [elapsedMs]);
  const singleFormattedElapsed = useMemo(() => formatDuration(singleElapsedMs), [singleElapsedMs]);

  const loadHistory = useCallback(
    async (offset = 0) => {
      if (!window.api) return;
      setHistoryLoading(true);
      try {
        const response = await window.api.listHistory({
          status: historyStatusFilter,
          search: historySearch || undefined,
          limit: 100,
          offset,
        });
        setHistoryRecords((previous) =>
          offset === 0 ? response.records : [...previous, ...response.records],
        );
        setHistoryTotal(response.total);
      } catch (error) {
        pushMessage(`Failed to load history: ${formatError(error)}`);
      } finally {
        setHistoryLoading(false);
      }
    },
    [historyStatusFilter, historySearch, pushMessage],
  );

  useEffect(() => {
    if (view === "history") {
      void loadHistory();
    }
  }, [view, loadHistory]);

  useEffect(() => {
    if (!queueUpdate) return;
    const doneCount =
      queueUpdate.totals.completed + queueUpdate.totals.failed + queueUpdate.totals.skipped;
    if (doneCount === historyReloadCountRef.current) {
      return;
    }
    historyReloadCountRef.current = doneCount;
    void loadHistory();
  }, [queueUpdate, loadHistory]);

  const handleChooseSingleFile = async () => {
    if (!window.api || singleProcessing) return;
    let selection: string | null;
    try {
      selection = await window.api.selectVideo();
    } catch (error) {
      pushMessage(`Failed to open file dialog: ${formatError(error)}`);
      return;
    }
    if (!selection) return;
    const fileName = selection.split(pathSeparator()).pop() ?? selection;
    setSingleFile({
      filePath: selection,
      fileName,
      size: 0,
      selected: true,
    });
    setSingleResult(null);
    setSingleError(null);
    setSingleProgressEvents([]);
    singleActiveJobIdRef.current = null;
  };

  const handleChooseFolder = async () => {
    if (!window.api) return;
    try {
      const folder = await window.api.selectFolder();
      if (!folder) return;
      const scan: FolderScanResult = await window.api.scanFolder(folder);
      const mapped: SelectedFile[] = scan.files.map((file) => ({
        filePath: file.filePath,
        fileName: file.fileName,
        size: file.size,
        selected: true,
      }));
      setFolderFiles(mapped);
      setFolderPath(folder);
      setSkippedFiles(scan.skipped);
      if (scan.skipped.length > 0) {
        pushMessage(`Skipped ${scan.skipped.length} unsupported files.`);
      }
    } catch (error) {
      pushMessage(`Failed to scan folder: ${formatError(error)}`);
    }
  };

  const toggleFolderFile = (index: number) => {
    setFolderFiles((previous) =>
      previous.map((entry, idx) =>
        idx === index ? { ...entry, selected: !entry.selected } : entry,
      ),
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
    setSingleProcessing(true);
    setSingleError(null);
    setSingleResult(null);
    setSingleProgressEvents([]);
    setSingleElapsedMs(0);
    singleActiveJobIdRef.current = SINGLE_PENDING_JOB_ID;
    try {
      const response = await window.api.processSingle({
        basePrefix: trimmedPrefix,
        filePath: singleFile.filePath,
        renditions: selectedRenditions,
      });
      setSingleResult(response);
      if (response.success) {
        pushMessage("Conversion completed.");
      } else {
        const message = response.error ?? "Conversion failed.";
        setSingleError(message);
        pushMessage(message);
      }
      void loadHistory();
    } catch (error) {
      const message = formatError(error);
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
    const selected = folderFiles.filter((file) => file.selected);
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
        files: selected.map((file) => ({ filePath: file.filePath })),
        renditions: selectedRenditions,
        mode: "batch",
        concurrency,
      });
      pushMessage(`Queued ${selected.length - skipped.length} files for processing.`);
      if (jobIds.length > 0) {
        setSelectedJobId(jobIds[0]);
      }
    } catch (error) {
      pushMessage(`Failed to queue batch: ${formatError(error)}`);
    }
  };

  const handleQueueControl = async (
    action: "pause" | "resume" | "cancel-current" | "cancel-remaining" | "clear-completed",
  ) => {
    if (!window.api) return;
    try {
      await window.api.controlQueue(action);
    } catch (error) {
      pushMessage(`Queue control failed: ${formatError(error)}`);
    }
  };

  const fillSettingsForm = useCallback((view: AppSettingsView) => {
    const s3 = view.s3;
    setS3EndpointUrl(s3?.endpointUrl ?? "");
    setS3BucketName(s3?.bucketName ?? "");
    setS3Region(s3?.region ?? "");
    setS3ViewEndpoint(s3?.viewEndpoint ?? "");
    setS3BucketUrl(s3?.bucketUrl ?? "");
    setS3PathStyle(s3?.pathStyle ?? true);
    setS3PublicRead(s3?.publicRead ?? true);
    setS3UploadConcurrency(s3?.uploadConcurrency ?? 4);
  }, []);

  const openSettings = useCallback(() => {
    setS3AccessKeyId("");
    setS3SecretAccessKey("");
    setSelectedProfileId("");
    setProfileName("");
    setIsSettingsOpen(true);
    if (!window.api) return;
    // Always refetch: the Simple journey may have saved settings this session.
    void window.api
      .getSettings()
      .then((view) => {
        setSettingsView(view);
        fillSettingsForm(view);
      })
      .catch(() => {
        // Settings are optional; the form stays blank.
      });
  }, [fillSettingsForm]);

  const handleSaveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.api || settingsSaving) return;
    setSettingsSaving(true);
    try {
      const view = await window.api.saveSettings({
        endpointUrl: s3EndpointUrl.trim(),
        region: s3Region.trim() || "us-east-1",
        bucketName: s3BucketName.trim(),
        bucketUrl: s3BucketUrl.trim(),
        viewEndpoint: s3ViewEndpoint.trim(),
        pathStyle: s3PathStyle,
        uploadConcurrency: s3UploadConcurrency,
        publicRead: s3PublicRead,
        accessKeyId: s3AccessKeyId.trim(),
        secretAccessKey: s3SecretAccessKey.trim(),
      });
      setSettingsView(view);
      setIsSettingsOpen(false);
      pushMessage("S3 settings saved.");
    } catch (error) {
      pushMessage(`Failed to save settings: ${formatError(error)}`);
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleApplyProfile = async () => {
    if (!window.api || !selectedProfileId || profileBusy) return;
    setProfileBusy(true);
    try {
      const view = await window.api.applyProfile(selectedProfileId);
      setSettingsView(view);
      fillSettingsForm(view);
      setS3AccessKeyId("");
      setS3SecretAccessKey("");
      const name = view.profiles.find((profile) => profile.id === selectedProfileId)?.name;
      pushMessage(name ? `Loaded "${name}".` : "Connection loaded.");
    } catch (error) {
      pushMessage(`Failed to load connection: ${formatError(error)}`);
    } finally {
      setProfileBusy(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (!window.api || !selectedProfileId || profileBusy) return;
    setProfileBusy(true);
    try {
      const view = await window.api.deleteProfile(selectedProfileId);
      setSettingsView(view);
      setSelectedProfileId("");
      pushMessage("Connection deleted.");
    } catch (error) {
      pushMessage(`Failed to delete connection: ${formatError(error)}`);
    } finally {
      setProfileBusy(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!window.api || profileBusy) return;
    const name = profileName.trim();
    if (!name) {
      pushMessage("Enter a name for the connection first.");
      return;
    }
    setProfileBusy(true);
    try {
      // Overwrite when the name matches an existing connection; otherwise create.
      const existing = settingsView?.profiles.find(
        (profile) => profile.name.toLowerCase() === name.toLowerCase(),
      );
      const view = await window.api.saveProfile({
        id: existing?.id,
        name,
        settings: {
          endpointUrl: s3EndpointUrl.trim(),
          region: s3Region.trim() || "us-east-1",
          bucketName: s3BucketName.trim(),
          bucketUrl: s3BucketUrl.trim(),
          viewEndpoint: s3ViewEndpoint.trim(),
          pathStyle: s3PathStyle,
          uploadConcurrency: s3UploadConcurrency,
          publicRead: s3PublicRead,
          accessKeyId: s3AccessKeyId.trim(),
          secretAccessKey: s3SecretAccessKey.trim(),
        },
      });
      setSettingsView(view);
      setProfileName("");
      pushMessage(existing ? `Connection "${name}" updated.` : `Connection "${name}" saved.`);
    } catch (error) {
      pushMessage(`Failed to save connection: ${formatError(error)}`);
    } finally {
      setProfileBusy(false);
    }
  };

  const handleCopyUrl = async (
    url: string | null | undefined,
    options?: { jobId?: string; historyId?: string },
  ) => {
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
    }
  };

  const handleHistorySearchSubmit = (event: FormEvent) => {
    event.preventDefault();
    setHistorySearch(historySearchInput.trim());
  };

  const toggleHistorySelection = (historyId: string) => {
    setSelectedHistoryIds((previous) => {
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
    setSelectedHistoryIds((previous) => {
      if (historyRecords.length === 0) {
        return previous.size === 0 ? previous : new Set<string>();
      }
      const shouldSelectAll = historyRecords.some((record) => !previous.has(record.id));
      if (!shouldSelectAll) {
        return previous.size === 0 ? previous : new Set<string>();
      }
      const next = new Set<string>();
      historyRecords.forEach((record) => next.add(record.id));
      return next;
    });
  };

  const handleGenerateBulkUrls = () => {
    const urls = historyRecords
      .filter((record) => selectedHistoryIds.has(record.id))
      .map((record) => record.manifestUrl)
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
      setSelectedHistoryIds((previous) => {
        if (!previous.has(record.id)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(record.id);
        return next;
      });
      pushMessage(`Removed ${record.fileName} from history`);
      void loadHistory();
    } catch (error) {
      pushMessage(`Failed to delete history: ${formatError(error)}`);
    }
  };

  const queueTotals = queueUpdate?.totals;
  const overallPercent = queueUpdate?.overallPercent ?? 0;
  const jobs = queueUpdate?.jobs ?? [];

  const filteredLogs = useMemo(() => {
    const list = selectedJobId ? jobLogs.filter((entry) => entry.jobId === selectedJobId) : jobLogs;
    return [...list].slice(-200).reverse();
  }, [jobLogs, selectedJobId]);

  const activeJob = selectedJobId ? jobs.find((job) => job.id === selectedJobId) : undefined;
  const selectedHistoryCount = selectedHistoryIds.size;
  const allHistorySelected =
    historyRecords.length > 0 &&
    historyRecords.every((record) => selectedHistoryIds.has(record.id));
  const bulkUrlCount = useMemo(
    () => (bulkUrlText.trim().length === 0 ? 0 : bulkUrlText.split("\n").filter(Boolean).length),
    [bulkUrlText],
  );
  const currentSingleProgress = singleProgressEvents.length
    ? singleProgressEvents[singleProgressEvents.length - 1]
    : null;
  const singleProgressTail = useMemo(
    () => singleProgressEvents.slice(-10).reverse(),
    [singleProgressEvents],
  );
  const singleProgressPercent =
    currentSingleProgress?.percent ??
    (singleProcessing ? 0 : singleProgressEvents.length > 0 ? 100 : 0);
  const normalizedSingleProgress = Number.isFinite(singleProgressPercent)
    ? Math.min(Math.max(singleProgressPercent, 0), 100)
    : 0;

  return (
    <>
      <div className="glass-canvas min-h-screen px-6 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">hulesa</h1>
              <p className="text-[13px] text-base-content/55">
                Convert videos to multi-rendition HLS, upload to S3-compatible storage, and track
                batch progress with live logs.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="linear-btn linear-btn-secondary linear-btn-sm inline-flex items-center gap-1.5"
                onClick={openSettings}
                aria-label="S3 settings"
              >
                <Settings size={14} />
                <span className="hidden sm:inline">S3 settings</span>
              </button>
              <ThemeToggle preference={preference} setPreference={setPreference} />
              <div className="linear-segmented" role="radiogroup" aria-label="View">
                <button
                  type="button"
                  role="radio"
                  aria-checked={view === "simple"}
                  data-active={view === "simple"}
                  className="inline-flex items-center gap-1.5"
                  onClick={() => setView("simple")}
                >
                  <Sparkles size={14} />
                  Simple
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={view === "advanced"}
                  data-active={view === "advanced"}
                  className="inline-flex items-center gap-1.5"
                  onClick={() => setView("advanced")}
                >
                  <SlidersHorizontal size={14} />
                  Advanced
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={view === "history"}
                  data-active={view === "history"}
                  className="inline-flex items-center gap-1.5"
                  onClick={() => setView("history")}
                >
                  <Clock size={14} />
                  History
                </button>
              </div>
            </div>
          </header>

          {infoMessages.length > 0 && (
            <div className="linear-alert flex flex-col items-start gap-1">
              {infoMessages.map((item) => (
                <span key={item.id}>{item.message}</span>
              ))}
            </div>
          )}

          {view === "simple" && <JourneyWizard />}

          {view === "advanced" && (
            <div className="linear-segmented self-start" role="group" aria-label="Advanced mode">
              <button
                type="button"
                data-active={mode === "single"}
                onClick={() => setMode("single")}
              >
                Single file
              </button>
              <button type="button" data-active={mode === "batch"} onClick={() => setMode("batch")}>
                Folder batch
              </button>
            </div>
          )}

          {view === "advanced" && mode === "single" && (
            <section className="linear-card">
              <div className="card-body gap-6">
                <form className="flex flex-col gap-6" onSubmit={handleProcessSingle}>
                  <div className="grid gap-4 md:grid-cols-2 md:gap-6">
                    <div className="flex flex-col gap-1.5 md:col-span-2">
                      <label htmlFor="single-video-source" className="linear-label">
                        Video source
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="single-video-source"
                          type="text"
                          value={singleFile?.filePath ?? ""}
                          placeholder="Select a file..."
                          readOnly
                          className="linear-input"
                          disabled={singleProcessing}
                        />
                        <button
                          type="button"
                          className="linear-btn linear-btn-primary shrink-0"
                          onClick={handleChooseSingleFile}
                          disabled={singleProcessing}
                        >
                          Choose file
                        </button>
                      </div>
                      <span className="linear-hint">
                        Supports MP4, MOV, MKV, AVI, M4V, and WEBM containers.
                      </span>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="single-base-prefix" className="linear-label">
                        Object path prefix
                      </label>
                      <input
                        id="single-base-prefix"
                        type="text"
                        value={basePrefix}
                        onChange={(event) => {
                          const value = event.target.value;
                          setBasePrefix(value);
                          if (value.trim().length > 0) {
                            setBasePrefixError(null);
                          }
                        }}
                        placeholder="uploads/my-project"
                        className={`linear-input ${basePrefixError ? "linear-input-error" : ""}`}
                        disabled={singleProcessing}
                      />
                      <div className="flex items-center justify-between gap-2">
                        <span className="linear-hint">
                          Each file is uploaded under{" "}
                          <code>
                            {basePrefix.trim() || "(prefix)"}/{`<filename>/`}
                          </code>
                        </span>
                        {basePrefixError ? (
                          <span className="linear-hint shrink-0 text-error">{basePrefixError}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="linear-label">Output renditions</span>
                    <RenditionPicker
                      selectedRenditions={selectedRenditions}
                      onToggle={toggleRendition}
                      disabled={singleProcessing}
                    />
                    <span className="linear-hint">
                      Defaults to 360p, 480p, and 720p. Higher renditions are skipped if the source
                      is too small.
                    </span>
                  </div>

                  <button
                    type="submit"
                    className="linear-btn linear-btn-primary h-9 w-full"
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

          {view === "advanced" && mode === "single" && (
            <section className="linear-card">
              <div className="card-body gap-4">
                <h2 className="text-base font-semibold tracking-tight">Result</h2>
                {(singleProcessing || singleProgressEvents.length > 0) && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between" aria-live="polite">
                      <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                        {currentSingleProgress?.stage ?? "Preparing"}
                      </span>
                      <span className="linear-badge linear-badge-neutral">
                        {percentDisplay(normalizedSingleProgress)}
                      </span>
                    </div>
                    <div className="linear-progress">
                      <span style={{ width: `${normalizedSingleProgress}%` }} />
                    </div>
                    <div className="linear-mono flex justify-end text-base-content/60">
                      {singleFormattedElapsed}
                    </div>
                    <div className="max-h-36 overflow-y-auto linear-well p-3">
                      {singleProgressEvents.length > 0 ? (
                        <ul className="linear-mono space-y-1">
                          {singleProgressTail.map((event) => (
                            <li key={`${event.jobId}-${event.timestamp}`}>
                              <span className="font-semibold text-primary">{event.stage}</span>
                              {event.message ? (
                                <span className="text-base-content/70"> — {event.message}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="linear-hint">Preparing job…</span>
                      )}
                    </div>
                    {singleProcessing && (
                      <p className="linear-hint">
                        All fields are locked until the upload finishes.
                      </p>
                    )}
                  </div>
                )}
                {!singleProcessing && (
                  <div className="space-y-3">
                    {singleError && (
                      <div className="linear-alert linear-alert-error flex flex-col items-start gap-1">
                        <span>{singleError}</span>
                      </div>
                    )}
                    {singleResult ? (
                      <div className="space-y-3">
                        <div>
                          <div className="text-[13px] font-medium text-primary">
                            {singleFile?.fileName ?? "Conversion complete"}
                          </div>
                          {singleResult.details && (
                            <p className="linear-hint">{singleResult.details}</p>
                          )}
                        </div>
                        {singleResult.manifestUrl ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="linear-mono linear-well whitespace-pre-wrap break-all px-2 py-1">
                              {singleResult.manifestUrl}
                            </code>
                            <button
                              type="button"
                              className="linear-btn linear-btn-secondary linear-btn-xs"
                              onClick={() =>
                                handleCopyUrl(singleResult.manifestUrl, {
                                  jobId: singleResult.jobId,
                                })
                              }
                            >
                              Copy URL
                            </button>
                            {copiedJobId === singleResult.jobId && (
                              <span className="text-xs text-success">Copied!</span>
                            )}
                          </div>
                        ) : (
                          <span className="linear-hint">Manifest URL not available.</span>
                        )}
                        {singleResult.warnings && singleResult.warnings.length > 0 && (
                          <div className="linear-alert linear-alert-warning flex flex-col items-start gap-1">
                            {singleResult.warnings.map((warning) => (
                              <span key={warning}>{warning}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[13px] text-base-content/50">
                        Select a file and start conversion to see the streaming URL here.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {view === "advanced" && mode === "batch" && (
            <section className="linear-card">
              <div className="card-body gap-6">
                <form className="flex flex-col gap-6" onSubmit={handleQueueBatch}>
                  <div className="flex flex-col gap-1.5">
                    <span className="linear-label">Folder to ingest</span>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={folderPath}
                        placeholder="Select a folder..."
                        readOnly
                        className="linear-input"
                      />
                      <button
                        type="button"
                        className="linear-btn linear-btn-primary shrink-0"
                        onClick={handleChooseFolder}
                      >
                        Choose folder
                      </button>
                    </div>
                    <span className="linear-hint">
                      Only supported video files are queued. Others appear in the skipped list.
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="batch-base-prefix" className="linear-label">
                      Object path prefix
                    </label>
                    <input
                      id="batch-base-prefix"
                      type="text"
                      value={basePrefix}
                      onChange={(event) => {
                        const value = event.target.value;
                        setBasePrefix(value);
                        if (value.trim().length > 0) {
                          setBasePrefixError(null);
                        }
                      }}
                      placeholder="uploads/events"
                      className={`linear-input ${basePrefixError ? "linear-input-error" : ""}`}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="linear-hint">
                        Uploaded manifests live under{" "}
                        <code>
                          {basePrefix.trim() || "(prefix)"}/{`<filename>/`}
                        </code>
                      </span>
                      {basePrefixError ? (
                        <span className="linear-hint shrink-0 text-error">{basePrefixError}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="linear-label">Output renditions</span>
                    <RenditionPicker
                      selectedRenditions={selectedRenditions}
                      onToggle={toggleRendition}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="batch-concurrency" className="linear-label">
                      Concurrency
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        id="batch-concurrency"
                        type="number"
                        min={1}
                        max={16}
                        value={concurrency}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isNaN(next)) {
                            setConcurrency(1);
                          } else {
                            setConcurrency(Math.max(1, Math.min(16, Math.floor(next))));
                          }
                        }}
                        className="linear-input w-24"
                      />
                      <p className="linear-hint">
                        Default 2. Higher values use more CPU/disk; excessive concurrency may slow
                        or crash the system.
                      </p>
                    </div>
                  </div>

                  {folderFiles.length > 0 && (
                    <div className="linear-card overflow-x-auto">
                      <table className="linear-table">
                        <thead>
                          <tr>
                            <th scope="col" />
                            <th scope="col">File</th>
                            <th scope="col">Size</th>
                            <th scope="col">Path</th>
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
                                  aria-label={`Select ${file.fileName}`}
                                />
                              </td>
                              <td>{file.fileName}</td>
                              <td className="text-base-content/60">{formatBytes(file.size)}</td>
                              <td className="linear-mono break-all text-base-content/60">
                                {file.filePath}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {skippedFiles.length > 0 && (
                    <div className="linear-alert linear-alert-warning flex flex-col items-start gap-1">
                      <span className="font-semibold">Skipped files</span>
                      <ul className="list-disc pl-5">
                        {skippedFiles.slice(0, 5).map((file) => (
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
                    className="linear-btn linear-btn-primary h-9 w-full"
                    disabled={
                      folderFiles.every((file) => !file.selected) ||
                      selectedRenditions.length === 0 ||
                      basePrefix.trim().length === 0
                    }
                  >
                    Queue selected files ({folderFiles.filter((file) => file.selected).length})
                  </button>
                </form>
              </div>
            </section>
          )}

          {view === "advanced" && mode === "batch" && (
            <section className="linear-card">
              <div className="card-body gap-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div aria-live="polite">
                    <h2 className="text-base font-semibold tracking-tight">Queue progress</h2>
                    <p className="linear-hint">
                      {queueUpdate?.queueStatus === "running" && "Processing jobs…"}
                      {queueUpdate?.queueStatus === "paused" && "Queue paused"}
                      {queueUpdate?.queueStatus === "idle" && "Queue idle"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {queueUpdate?.queueStatus === "running" && (
                      <button
                        type="button"
                        className="linear-btn linear-btn-secondary linear-btn-sm"
                        onClick={() => handleQueueControl("pause")}
                      >
                        Pause
                      </button>
                    )}
                    {queueUpdate?.queueStatus === "paused" && (
                      <button
                        type="button"
                        className="linear-btn linear-btn-secondary linear-btn-sm"
                        onClick={() => handleQueueControl("resume")}
                      >
                        Resume
                      </button>
                    )}
                    <button
                      type="button"
                      className="linear-btn linear-btn-secondary linear-btn-sm"
                      onClick={() => handleQueueControl("cancel-remaining")}
                    >
                      Cancel remaining
                    </button>
                    <button
                      type="button"
                      className="linear-btn linear-btn-secondary linear-btn-sm"
                      onClick={() => handleQueueControl("clear-completed")}
                    >
                      Clear completed
                    </button>
                    <button
                      type="button"
                      className="linear-btn linear-btn-ghost linear-btn-sm"
                      onClick={() => setIsLogOpen(true)}
                      disabled={jobLogs.length === 0}
                    >
                      View live log
                    </button>
                  </div>
                </div>

                <div className="linear-progress">
                  <span style={{ width: `${overallPercent}%` }} />
                </div>
                <div className="linear-mono flex justify-end text-base-content/60">
                  {formattedElapsed}
                </div>

                {queueTotals && (
                  <div className="grid grid-cols-3 divide-x divide-base-300 rounded-md border border-base-300">
                    <div className="flex flex-col gap-0.5 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/50">
                        Total
                      </div>
                      <div className="text-xl font-semibold text-primary">{queueTotals.total}</div>
                      <div className="linear-hint">Jobs in queue</div>
                    </div>
                    <div className="flex flex-col gap-0.5 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/50">
                        Completed
                      </div>
                      <div className="text-xl font-semibold text-success">
                        {queueTotals.completed}
                      </div>
                      <div className="linear-hint">
                        Failed {queueTotals.failed} / Skipped {queueTotals.skipped}
                      </div>
                    </div>
                    <div className="flex flex-col gap-0.5 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-base-content/50">
                        Active
                      </div>
                      <div className="text-xl font-semibold text-info">
                        {queueTotals.processing + queueTotals.uploading}
                      </div>
                      <div className="linear-hint">
                        Pending {queueTotals.pending} / Canceled {queueTotals.canceled}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {view === "advanced" && mode === "batch" && (
            <section className="linear-card">
              <div className="card-body gap-4">
                <h2 className="text-base font-semibold tracking-tight">Jobs</h2>
                <div className="linear-card overflow-x-auto">
                  <table className="linear-table">
                    <thead>
                      <tr>
                        <th scope="col">File</th>
                        <th scope="col">Status</th>
                        <th scope="col">Progress</th>
                        <th scope="col">Object key</th>
                        <th scope="col">Message</th>
                        <th scope="col">Manifest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="py-8 text-center text-[13px] text-base-content/50"
                          >
                            No jobs queued yet.
                          </td>
                        </tr>
                      ) : (
                        jobs.map((job) => (
                          <tr
                            key={job.id}
                            className={selectedJobId === job.id ? "bg-primary/10" : ""}
                            tabIndex={0}
                            onClick={() => setSelectedJobId(job.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSelectedJobId(job.id);
                              }
                            }}
                          >
                            <td className="w-64">
                              <div className="truncate font-medium">{job.fileName}</div>
                              <div className="linear-hint truncate">{job.filePath}</div>
                            </td>
                            <td className="w-28">
                              <span className={`linear-badge ${statusClassMap[job.status]}`}>
                                {statusLabel(job.status)}
                              </span>
                            </td>
                            <td className="w-20">{percentDisplay(job.percent)}</td>
                            <td className="w-64 break-all text-xs text-base-content/60">
                              {job.objectKey}
                            </td>
                            <td className="text-xs text-base-content/60">{job.message}</td>
                            <td className="w-40">
                              {job.manifestUrl ? (
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="linear-btn linear-btn-secondary linear-btn-xs"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleCopyUrl(job.manifestUrl, { jobId: job.id });
                                    }}
                                  >
                                    Copy URL
                                  </button>
                                  {copiedJobId === job.id && (
                                    <span className="text-xs text-success">Copied!</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs text-base-content/40">Pending</span>
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

          {view === "history" && (
            <section className="linear-card">
              <div className="card-body gap-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold tracking-tight">History</h2>
                    <p className="linear-hint">
                      Stored results for processed files (showing {historyRecords.length} of{" "}
                      {historyTotal}).
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <form className="flex gap-2" onSubmit={handleHistorySearchSubmit}>
                      <label htmlFor="history-search" className="sr-only">
                        Search history
                      </label>
                      <input
                        id="history-search"
                        type="text"
                        placeholder="Search history…"
                        className="linear-input h-7"
                        value={historySearchInput}
                        onChange={(event) => setHistorySearchInput(event.target.value)}
                      />
                      <button type="submit" className="linear-btn linear-btn-primary linear-btn-sm">
                        Search
                      </button>
                    </form>
                    <label htmlFor="history-status" className="sr-only">
                      Filter by status
                    </label>
                    <select
                      id="history-status"
                      className="linear-select h-7 w-auto"
                      value={historyStatusFilter}
                      onChange={(event) =>
                        setHistoryStatusFilter(event.target.value as JobStatus | "all")
                      }
                    >
                      <option value="all">All statuses</option>
                      <option value="completed">Completed</option>
                      <option value="failed">Failed</option>
                      <option value="skipped">Skipped</option>
                    </select>
                    <button
                      type="button"
                      className="linear-btn linear-btn-secondary linear-btn-sm"
                      disabled={selectedHistoryCount === 0}
                      onClick={handleGenerateBulkUrls}
                    >
                      Generate URLs
                    </button>
                    {selectedHistoryCount > 0 && (
                      <span className="linear-hint">{selectedHistoryCount} selected</span>
                    )}
                    <button
                      type="button"
                      className="linear-btn linear-btn-secondary linear-btn-sm"
                      onClick={() => void loadHistory()}
                    >
                      {historyLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>
                </div>

                <div className="linear-card overflow-x-auto">
                  <table className="linear-table">
                    <thead>
                      <tr>
                        <th scope="col" className="w-10">
                          <input
                            ref={headerHistoryCheckboxRef}
                            type="checkbox"
                            className="checkbox checkbox-sm"
                            checked={allHistorySelected}
                            onChange={toggleHistorySelectAll}
                            aria-label="Select all history entries"
                          />
                        </th>
                        <th scope="col">Completed</th>
                        <th scope="col">File</th>
                        <th scope="col">Status</th>
                        <th scope="col">Manifest</th>
                        <th scope="col">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRecords.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
                            className="py-8 text-center text-[13px] text-base-content/50"
                          >
                            No history entries yet.
                          </td>
                        </tr>
                      ) : (
                        historyRecords.map((record) => (
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
                            <td className="text-xs text-base-content/60">
                              {record.completedAt
                                ? new Date(record.completedAt).toLocaleString()
                                : "—"}
                            </td>
                            <td className="w-48">
                              <div className="truncate font-medium" title={record.fileName}>
                                {record.fileName}
                              </div>
                            </td>
                            <td className="w-24">
                              <span className={`linear-badge ${statusClassMap[record.status]}`}>
                                {statusLabel(record.status)}
                              </span>
                            </td>
                            <td className="align-middle">
                              <span
                                className="linear-mono block text-base-content/60"
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
                                    className="linear-btn linear-btn-secondary linear-btn-xs"
                                    onClick={() =>
                                      handleCopyUrl(record.manifestUrl, {
                                        historyId: record.id,
                                      })
                                    }
                                  >
                                    Copy URL
                                  </button>
                                ) : (
                                  <span className="whitespace-nowrap text-xs text-base-content/40">
                                    No URL
                                  </span>
                                )}
                                <button
                                  type="button"
                                  className="linear-btn linear-btn-ghost linear-btn-xs hover:text-error"
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
                {historyRecords.length < historyTotal && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      className="linear-btn linear-btn-secondary linear-btn-sm"
                      disabled={historyLoading}
                      onClick={() => void loadHistory(historyRecords.length)}
                    >
                      {historyLoading ? "Loading…" : "Load more"}
                    </button>
                  </div>
                )}
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
          ref={bulkUrlDialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-base-300/60 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Bulk URLs"
          tabIndex={-1}
          onClick={closeBulkUrlModal}
        >
          <div
            className="linear-card w-full max-w-3xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="card-body gap-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold tracking-tight">Bulk URLs</h2>
                  <p className="linear-hint">
                    {bulkUrlCount} link{bulkUrlCount === 1 ? "" : "s"} ready to copy.
                  </p>
                </div>
                <button
                  type="button"
                  className="linear-btn linear-btn-secondary linear-btn-sm"
                  onClick={() => setIsBulkUrlModalOpen(false)}
                >
                  Close
                </button>
              </div>
              <textarea
                className="linear-mono linear-well h-64 w-full resize-none p-3 focus:outline-none"
                value={bulkUrlText}
                readOnly
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="linear-hint">
                  Copy to paste the selected manifest URLs wherever you need them.
                </span>
                <button
                  type="button"
                  className="linear-btn linear-btn-primary linear-btn-sm"
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

      {isSettingsOpen && (
        <div
          ref={settingsDialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-base-300/60 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-label="S3 settings"
          tabIndex={-1}
          onClick={closeSettings}
        >
          <div
            className="linear-card max-h-[90vh] w-full max-w-2xl overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="card-body gap-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold tracking-tight">S3 settings</h2>
                  <p className="linear-hint">
                    {settingsView?.s3
                      ? `Saved for bucket ${settingsView.s3.bucketName || "(unnamed)"}.`
                      : "No saved settings yet — the app falls back to environment variables."}
                  </p>
                </div>
                <button
                  type="button"
                  className="linear-btn linear-btn-secondary linear-btn-sm"
                  onClick={closeSettings}
                >
                  Close
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="s3-saved-connection" className="linear-label">
                  Saved connections
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    id="s3-saved-connection"
                    className="linear-select min-w-0 flex-1"
                    value={selectedProfileId}
                    onChange={(event) => setSelectedProfileId(event.target.value)}
                    disabled={!settingsView?.profiles.length}
                  >
                    <option value="">
                      {settingsView?.profiles.length
                        ? "Choose a connection…"
                        : "No saved connections"}
                    </option>
                    {settingsView?.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="linear-btn linear-btn-secondary linear-btn-sm"
                    onClick={handleApplyProfile}
                    disabled={!selectedProfileId || profileBusy}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    className="linear-btn linear-btn-secondary linear-btn-sm"
                    onClick={handleDeleteProfile}
                    disabled={!selectedProfileId || profileBusy}
                  >
                    Delete
                  </button>
                </div>
                <span className="linear-hint">
                  Loading a connection makes it the active S3 destination — credentials included.
                </span>
              </div>
              <form className="flex flex-col gap-4" onSubmit={handleSaveSettings}>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="s3-endpoint-url" className="linear-label">
                    Endpoint URL
                  </label>
                  <input
                    id="s3-endpoint-url"
                    type="text"
                    value={s3EndpointUrl}
                    onChange={(event) => setS3EndpointUrl(event.target.value)}
                    placeholder="https://s3.example.com"
                    className="linear-input"
                    autoComplete="off"
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="s3-bucket-name" className="linear-label">
                      Bucket
                    </label>
                    <input
                      id="s3-bucket-name"
                      type="text"
                      value={s3BucketName}
                      onChange={(event) => setS3BucketName(event.target.value)}
                      placeholder="my-bucket"
                      className="linear-input"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="s3-region" className="linear-label">
                      Region
                    </label>
                    <input
                      id="s3-region"
                      type="text"
                      value={s3Region}
                      onChange={(event) => setS3Region(event.target.value)}
                      placeholder="us-east-1"
                      className="linear-input"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="s3-access-key" className="linear-label">
                      Access key
                    </label>
                    <input
                      id="s3-access-key"
                      type="text"
                      value={s3AccessKeyId}
                      onChange={(event) => setS3AccessKeyId(event.target.value)}
                      placeholder={
                        settingsView?.s3?.hasAccessKey
                          ? "•••••••• saved — enter to replace"
                          : undefined
                      }
                      className="linear-input"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="s3-secret-key" className="linear-label">
                      Secret key
                    </label>
                    <input
                      id="s3-secret-key"
                      type="password"
                      value={s3SecretAccessKey}
                      onChange={(event) => setS3SecretAccessKey(event.target.value)}
                      placeholder={
                        settingsView?.s3?.hasSecretKey
                          ? "•••••••• saved — enter to replace"
                          : undefined
                      }
                      className="linear-input"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="s3-view-endpoint" className="linear-label">
                      Public/View base URL (optional)
                    </label>
                    <input
                      id="s3-view-endpoint"
                      type="text"
                      value={s3ViewEndpoint}
                      onChange={(event) => setS3ViewEndpoint(event.target.value)}
                      placeholder="https://cdn.example.com"
                      className="linear-input"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="s3-upload-concurrency" className="linear-label">
                      Upload concurrency
                    </label>
                    <input
                      id="s3-upload-concurrency"
                      type="number"
                      min={1}
                      max={16}
                      value={s3UploadConcurrency}
                      onChange={(event) => setS3UploadConcurrency(Number(event.target.value))}
                      className="linear-input"
                      autoComplete="off"
                    />
                    <span className="linear-hint">Parallel upload workers (1–16).</span>
                  </div>
                </div>
                <label htmlFor="s3-path-style" className="flex items-center gap-2 text-[13px]">
                  <input
                    id="s3-path-style"
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={s3PathStyle}
                    onChange={(event) => setS3PathStyle(event.target.checked)}
                  />
                  Use path-style endpoint (self-hosted stores)
                </label>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="s3-public-read" className="flex items-center gap-2 text-[13px]">
                    <input
                      id="s3-public-read"
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={s3PublicRead}
                      onChange={(event) => setS3PublicRead(event.target.checked)}
                    />
                    Make the bucket publicly readable
                  </label>
                  <span className="linear-hint">
                    {s3PublicRead
                      ? "hulesa applies a public-read policy to the whole bucket so streams play without signed URLs. Don't point it at a bucket that holds private files."
                      : "Objects stay private — you'll need signed URLs or your own bucket policy to play the streams."}
                  </span>
                </div>
                <span className="linear-hint">
                  {settingsView?.encryptionAvailable
                    ? "Stored locally on this machine, encrypted by your OS."
                    : "Stored locally on this machine (OS encryption unavailable)."}
                </span>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="s3-profile-name" className="linear-label">
                    Save as connection
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="s3-profile-name"
                      type="text"
                      value={profileName}
                      onChange={(event) => setProfileName(event.target.value)}
                      placeholder='e.g. "Work R2" or "Local RustFS"'
                      className="linear-input min-w-0 flex-1"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="linear-btn linear-btn-secondary linear-btn-sm"
                      onClick={handleSaveProfile}
                      disabled={profileBusy || !profileName.trim()}
                    >
                      Save as connection
                    </button>
                  </div>
                  <span className="linear-hint">
                    Stores the fields above — credentials included — as a named, reusable
                    connection. Saving with an existing name overwrites it.
                  </span>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="linear-btn linear-btn-secondary linear-btn-sm"
                    onClick={closeSettings}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="linear-btn linear-btn-primary linear-btn-sm"
                    disabled={settingsSaving}
                  >
                    {settingsSaving ? "Saving…" : "Save settings"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {isLogOpen && (
        <div
          ref={logDialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-base-300/60 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Live job log"
          tabIndex={-1}
          onClick={closeLogModal}
        >
          <div
            className="linear-card w-full max-w-4xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="card-body gap-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold tracking-tight">Live job log</h2>
                  <p className="linear-hint">
                    Most recent events first. Showing {filteredLogs.length} entries.
                  </p>
                  {activeJob && (
                    <p className="text-[13px] text-base-content/70">
                      Focused job: <span className="font-medium">{activeJob.fileName}</span>
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className="linear-btn linear-btn-secondary linear-btn-sm"
                  onClick={() => setIsLogOpen(false)}
                >
                  Close
                </button>
              </div>
              <div className="max-h-[70vh] overflow-y-auto linear-well rounded-[10px]">
                <table className="linear-table table-pin-rows">
                  <thead className="linear-thead">
                    <tr>
                      <th scope="col" className="w-28">
                        Time
                      </th>
                      <th scope="col" className="w-32">
                        File
                      </th>
                      <th scope="col" className="w-24">
                        Status
                      </th>
                      <th scope="col">Stage / message</th>
                      <th scope="col" className="w-12 text-right">
                        %
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="py-8 text-center text-[13px] text-base-content/50"
                        >
                          No log entries yet.
                        </td>
                      </tr>
                    ) : (
                      filteredLogs.map((entry) => {
                        const job = jobs.find((j) => j.id === entry.jobId);
                        return (
                          <tr key={entry.id}>
                            <td className="linear-mono align-top">
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </td>
                            <td className="align-top text-xs">
                              {job?.fileName ?? entry.jobId.slice(0, 8)}
                            </td>
                            <td className="align-top">
                              <span
                                className={`linear-badge capitalize ${statusClassMap[entry.status]}`}
                              >
                                {statusLabel(entry.status)}
                              </span>
                            </td>
                            <td className="align-top text-xs">
                              <div className="font-medium">{entry.stage}</div>
                              {entry.message && (
                                <div className="text-base-content/60">{entry.message}</div>
                              )}
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

export default App;
