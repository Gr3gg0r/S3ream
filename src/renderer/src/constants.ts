/**
 * Renderer-side presentation constants shared by the Simple journey and the
 * Advanced views. The encoding source of truth is VARIANT_PROFILES in
 * `src/main/services/videoPipeline.ts` — keep these ids in sync with it.
 */
export const resolutionOptions = [
  { id: "240p", label: "240p" },
  { id: "360p", label: "360p" },
  { id: "480p", label: "480p" },
  { id: "720p", label: "720p" },
  { id: "1080p", label: "1080p" },
  { id: "2k", label: "1440p" },
  { id: "4k", label: "2160p" },
] as const;

export const resolutionOrder: string[] = resolutionOptions.map((option) => option.id);

export const defaultRenditions = ["360p", "480p", "720p"];

export const formatBytes = (size: number) => {
  if (size === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[exponent]}`;
};

export const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const pathSeparator = () => (navigator.platform.startsWith("Win") ? "\\" : "/");

export const COPY_FEEDBACK_MS = 2000;
