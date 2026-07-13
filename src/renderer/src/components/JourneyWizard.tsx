import { useEffect, useRef, useState } from "react";
import type { AppSettingsView, SingleProcessResult } from "@shared/ipc";
import { DropZone } from "@renderer/components/DropZone";
import { RenditionPicker } from "@renderer/components/RenditionPicker";
import { Check, ChevronLeft, Cloud, FolderOpen } from "@renderer/components/icons";
import {
  COPY_FEEDBACK_MS,
  defaultRenditions,
  formatBytes,
  formatError,
  pathSeparator,
  resolutionOrder,
} from "@renderer/constants";

const wizardSteps = [
  { id: 1, label: "Video" },
  { id: 2, label: "Quality" },
  { id: 3, label: "Destination" },
] as const;

type WizardStep = 1 | 2 | 3;
type Phase = "editing" | "processing" | "done" | "error";
type DestinationType = "local" | "s3";

interface WizardFile {
  filePath: string;
  fileName: string;
  size: number;
}

export const JourneyWizard = () => {
  const [step, setStep] = useState<WizardStep>(1);
  const [phase, setPhase] = useState<Phase>("editing");
  const [file, setFile] = useState<WizardFile | null>(null);
  const [renditions, setRenditions] = useState<string[]>(defaultRenditions);
  const [destinationType, setDestinationType] = useState<DestinationType | null>(null);
  const [localDirectory, setLocalDirectory] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [bucketName, setBucketName] = useState("");
  const [region, setRegion] = useState("");
  const [viewEndpoint, setViewEndpoint] = useState("");
  const [bucketUrl, setBucketUrl] = useState("");
  const [pathStyle, setPathStyle] = useState(true);
  const [uploadConcurrency, setUploadConcurrency] = useState(4);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [settings, setSettings] = useState<AppSettingsView | null>(null);
  const [progress, setProgress] = useState<{ stage: string; percent: number | null } | null>(null);
  const [result, setResult] = useState<SingleProcessResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const processingRef = useRef(false);
  const settingsTouchedRef = useRef(false);

  useEffect(() => {
    if (!window.api) return;
    let cancelled = false;
    void window.api
      .getSettings()
      .then((view) => {
        if (cancelled) return;
        setSettings(view);
        if (view.s3 && !settingsTouchedRef.current) {
          setEndpointUrl(view.s3.endpointUrl);
          setRegion(view.s3.region);
          setBucketName(view.s3.bucketName);
          setViewEndpoint(view.s3.viewEndpoint);
          setBucketUrl(view.s3.bucketUrl);
          setPathStyle(view.s3.pathStyle);
          setUploadConcurrency(view.s3.uploadConcurrency);
        }
      })
      .catch(() => {
        // Settings are optional; the form stays blank.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!window.api) return;
    const unbind = window.api.onSingleProgress((event) => {
      if (!processingRef.current) return;
      setProgress({ stage: event.stage, percent: event.percent ?? null });
    });
    return () => unbind();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const handleFileSelected = (filePath: string, size?: number) => {
    const fileName = filePath.split(pathSeparator()).pop() ?? filePath;
    setFile({ filePath, fileName, size: size ?? 0 });
    setResult(null);
    setErrorMessage(null);
  };

  const toggleRendition = (id: string) => {
    setRenditions((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return Array.from(next).sort(
        (a, b) => resolutionOrder.indexOf(a) - resolutionOrder.indexOf(b),
      );
    });
  };

  const handleChooseDirectory = async () => {
    if (!window.api) return;
    const folder = await window.api.selectFolder();
    if (folder) {
      setLocalDirectory(folder);
    }
  };

  const hasSavedAccessKey = Boolean(settings?.s3?.hasAccessKey);
  const hasSavedSecretKey = Boolean(settings?.s3?.hasSecretKey);
  const isS3Valid =
    endpointUrl.trim().length > 0 &&
    bucketName.trim().length > 0 &&
    (accessKeyId.trim().length > 0 || hasSavedAccessKey) &&
    (secretAccessKey.trim().length > 0 || hasSavedSecretKey);
  const isLocalValid = localDirectory.trim().length > 0;
  const canConvert =
    Boolean(file) &&
    renditions.length > 0 &&
    destinationType !== null &&
    (destinationType === "local" ? isLocalValid : isS3Valid);

  const handleConvert = async () => {
    if (!window.api || !file || !destinationType || !canConvert || processingRef.current) return;
    setPhase("processing");
    setErrorMessage(null);
    setResult(null);
    setCopied(false);
    setProgress({ stage: "Preparing", percent: 0 });
    processingRef.current = true;
    try {
      if (destinationType === "s3") {
        const view = await window.api.saveSettings({
          endpointUrl: endpointUrl.trim(),
          region: region.trim() || "us-east-1",
          bucketName: bucketName.trim(),
          bucketUrl,
          viewEndpoint: viewEndpoint.trim(),
          pathStyle,
          uploadConcurrency,
          accessKeyId: accessKeyId.trim(),
          secretAccessKey: secretAccessKey.trim(),
        });
        setSettings(view);
        setAccessKeyId("");
        setSecretAccessKey("");
      }
      const response = await window.api.processSingle({
        filePath: file.filePath,
        basePrefix: "videos",
        renditions,
        destination:
          destinationType === "s3" ? { type: "s3" } : { type: "local", directory: localDirectory },
      });
      if (response.success) {
        setResult(response);
        setPhase("done");
      } else {
        setErrorMessage(response.error ?? "Conversion failed.");
        setPhase("error");
      }
    } catch (error) {
      setErrorMessage(formatError(error));
      setPhase("error");
    } finally {
      processingRef.current = false;
    }
  };

  const handleCopy = async () => {
    if (!result?.manifestUrl) return;
    try {
      await navigator.clipboard.writeText(result.manifestUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleConvertAnother = () => {
    setStep(1);
    setPhase("editing");
    setFile(null);
    setDestinationType(null);
    setLocalDirectory("");
    setResult(null);
    setErrorMessage(null);
    setProgress(null);
    setCopied(false);
  };

  const destinationCardClass = (active: boolean) =>
    `flex items-center gap-3 rounded-[12px] border p-4 text-left transition ${
      active ? "border-primary bg-primary/5" : "border-base-300 hover:bg-base-200"
    }`;

  const progressPercent = progress?.percent ?? 0;
  const normalizedPercent = Number.isFinite(progressPercent)
    ? Math.min(Math.max(progressPercent, 0), 100)
    : 0;

  return (
    <section className="linear-card">
      <div className="card-body gap-6">
        {phase === "editing" && (
          <ol className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {wizardSteps.map((item) => {
              const isActive = step === item.id;
              const isComplete = step > item.id;
              return (
                <li
                  key={item.id}
                  aria-current={isActive ? "step" : undefined}
                  className={`flex items-center gap-1.5 text-[13px] ${
                    isActive
                      ? "font-semibold text-base-content"
                      : isComplete
                        ? "text-base-content/70"
                        : "text-base-content/50"
                  }`}
                >
                  {isComplete && <Check size={14} />}
                  <span>{`${item.id} ${item.label}`}</span>
                </li>
              );
            })}
          </ol>
        )}

        {phase === "editing" && step === 1 && (
          <div className="flex flex-col gap-4">
            {file ? (
              <div className="flex items-center justify-between gap-3 rounded-[12px] border border-base-300 p-3">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium">{file.fileName}</span>
                  {file.size > 0 ? (
                    <span className="linear-hint">{formatBytes(file.size)}</span>
                  ) : (
                    <span className="linear-hint truncate">{file.filePath}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="linear-btn linear-btn-secondary linear-btn-sm shrink-0"
                  onClick={() => setFile(null)}
                >
                  Change
                </button>
              </div>
            ) : (
              <DropZone onFileSelected={handleFileSelected} />
            )}
            <div className="flex justify-end">
              <button
                type="button"
                className="linear-btn linear-btn-primary"
                disabled={!file}
                onClick={() => setStep(2)}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {phase === "editing" && step === 2 && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="linear-label">Output renditions</span>
              <RenditionPicker selectedRenditions={renditions} onToggle={toggleRendition} />
              <span className="linear-hint">
                Higher renditions are skipped automatically if the source is too small.
              </span>
            </div>
            <div className="flex justify-between">
              <button
                type="button"
                className="linear-btn linear-btn-secondary"
                onClick={() => setStep(1)}
              >
                <ChevronLeft size={14} />
                Back
              </button>
              <button
                type="button"
                className="linear-btn linear-btn-primary"
                disabled={renditions.length === 0}
                onClick={() => setStep(3)}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {phase === "editing" && step === 3 && (
          <div className="flex flex-col gap-4">
            <div role="radiogroup" aria-label="Destination" className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                role="radio"
                aria-checked={destinationType === "local"}
                className={destinationCardClass(destinationType === "local")}
                onClick={() => setDestinationType("local")}
              >
                <FolderOpen size={20} />
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium">Local folder</span>
                  <span className="linear-hint">Save the HLS files on this machine</span>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={destinationType === "s3"}
                className={destinationCardClass(destinationType === "s3")}
                onClick={() => setDestinationType("s3")}
              >
                <Cloud size={20} />
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium">S3 storage</span>
                  <span className="linear-hint">Upload to an S3-compatible bucket</span>
                </span>
              </button>
            </div>

            {destinationType === "local" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={localDirectory}
                    placeholder="Choose a destination folder..."
                    readOnly
                    className="linear-input"
                    aria-label="Destination folder"
                  />
                  <button
                    type="button"
                    className="linear-btn linear-btn-primary shrink-0"
                    onClick={handleChooseDirectory}
                  >
                    Choose folder
                  </button>
                </div>
                <span className="linear-hint">
                  The HLS output is written under this folder, one subfolder per video.
                </span>
              </div>
            )}

            {destinationType === "s3" && (
              <div
                className="flex flex-col gap-3"
                onChange={() => {
                  settingsTouchedRef.current = true;
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="jw-endpoint-url" className="linear-label">
                    Endpoint URL
                  </label>
                  <input
                    id="jw-endpoint-url"
                    type="text"
                    value={endpointUrl}
                    onChange={(event) => setEndpointUrl(event.target.value)}
                    placeholder="https://s3.example.com"
                    className="linear-input"
                    autoComplete="off"
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="jw-bucket-name" className="linear-label">
                      Bucket
                    </label>
                    <input
                      id="jw-bucket-name"
                      type="text"
                      value={bucketName}
                      onChange={(event) => setBucketName(event.target.value)}
                      placeholder="my-bucket"
                      className="linear-input"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="jw-region" className="linear-label">
                      Region
                    </label>
                    <input
                      id="jw-region"
                      type="text"
                      value={region}
                      onChange={(event) => setRegion(event.target.value)}
                      placeholder="us-east-1"
                      className="linear-input"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="jw-access-key" className="linear-label">
                      Access key
                    </label>
                    <input
                      id="jw-access-key"
                      type="text"
                      value={accessKeyId}
                      onChange={(event) => setAccessKeyId(event.target.value)}
                      placeholder={
                        hasSavedAccessKey ? "•••••••• saved — enter to replace" : undefined
                      }
                      className="linear-input"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="jw-secret-key" className="linear-label">
                      Secret key
                    </label>
                    <input
                      id="jw-secret-key"
                      type="password"
                      value={secretAccessKey}
                      onChange={(event) => setSecretAccessKey(event.target.value)}
                      placeholder={
                        hasSavedSecretKey ? "•••••••• saved — enter to replace" : undefined
                      }
                      className="linear-input"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="jw-view-endpoint" className="linear-label">
                      Public/View base URL (optional)
                    </label>
                    <input
                      id="jw-view-endpoint"
                      type="text"
                      value={viewEndpoint}
                      onChange={(event) => setViewEndpoint(event.target.value)}
                      placeholder="https://cdn.example.com"
                      className="linear-input"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="jw-upload-concurrency" className="linear-label">
                      Upload concurrency
                    </label>
                    <input
                      id="jw-upload-concurrency"
                      type="number"
                      min={1}
                      max={16}
                      value={uploadConcurrency}
                      onChange={(event) => setUploadConcurrency(Number(event.target.value))}
                      className="linear-input"
                      autoComplete="off"
                    />
                    <span className="linear-hint">Parallel upload workers (1–16).</span>
                  </div>
                </div>
                <label htmlFor="jw-path-style" className="flex items-center gap-2 text-[13px]">
                  <input
                    id="jw-path-style"
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={pathStyle}
                    onChange={(event) => setPathStyle(event.target.checked)}
                  />
                  Use path-style endpoint (self-hosted stores)
                </label>
                <span className="linear-hint">
                  {settings?.encryptionAvailable
                    ? "Stored locally on this machine, encrypted by your OS."
                    : "Stored locally on this machine (OS encryption unavailable)."}
                </span>
              </div>
            )}

            <div className="flex justify-between">
              <button
                type="button"
                className="linear-btn linear-btn-secondary"
                onClick={() => setStep(2)}
              >
                <ChevronLeft size={14} />
                Back
              </button>
              <button
                type="button"
                className="linear-btn linear-btn-primary"
                disabled={!canConvert}
                onClick={handleConvert}
              >
                {destinationType === "s3" ? "Convert & save" : "Convert"}
              </button>
            </div>
          </div>
        )}

        {phase === "processing" && (
          <div className="flex flex-col gap-3" aria-live="polite">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                {progress?.stage ?? "Preparing"}
              </span>
              <span className="linear-badge linear-badge-neutral">
                {progress?.percent != null ? `${progress.percent.toFixed(1)}%` : "—"}
              </span>
            </div>
            <div className="linear-progress">
              <span style={{ width: `${normalizedPercent}%` }} />
            </div>
            <span className="linear-hint">
              Converting {file?.fileName ?? "your video"}… you can keep using your machine, just
              keep the app open.
            </span>
          </div>
        )}

        {phase === "done" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Check size={18} />
              <h2 className="text-base font-semibold tracking-tight">Your stream is ready</h2>
            </div>
            {result?.manifestUrl ? (
              <code className="linear-mono linear-well block whitespace-pre-wrap break-all px-2 py-1">
                {result.manifestUrl}
              </code>
            ) : (
              <span className="linear-hint">Manifest URL not available.</span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="linear-btn linear-btn-secondary"
                onClick={handleCopy}
                disabled={!result?.manifestUrl}
              >
                Copy
              </button>
              {copied && <span className="text-xs text-success">Copied!</span>}
              <button
                type="button"
                className="linear-btn linear-btn-primary"
                onClick={handleConvertAnother}
              >
                Convert another
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-4">
            <div className="linear-alert linear-alert-error flex flex-col items-start gap-1">
              <span>{errorMessage ?? "Conversion failed."}</span>
            </div>
            <div>
              <button
                type="button"
                className="linear-btn linear-btn-primary"
                onClick={() => {
                  setStep(3);
                  setPhase("editing");
                }}
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
