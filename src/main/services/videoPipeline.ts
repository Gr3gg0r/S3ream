import { createReadStream, constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import type { Client } from "minio";
import {
  buildPublicUrl,
  ensureBucket,
  getActiveBucketName,
  getMinioClient,
  sanitizeObjectKey,
} from "./minioClient";
import type { VideoJobPayload, VideoJobProgress, VideoJobResult } from "@shared/ipc";

type ProgressEmitter = (progress: VideoJobProgress) => void;

export class JobCanceledError extends Error {
  constructor() {
    super("Job canceled by user");
    this.name = "JobCanceledError";
  }
}

interface ConversionResult {
  outputDir: string;
  manifestPath: string;
  files: string[];
  warnings: string[];
}

interface VideoMetadata {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
}

interface VariantProfile {
  id: string;
  label: string;
  height: number;
  videoBitrate: number;
  maxBitrate: number;
  bufferSize: number;
  audioBitrate: number;
  x264Profile: "baseline" | "main" | "high";
  x264Level: string;
}

interface VariantManifestInfo {
  profile: VariantProfile;
  playlistRelativePath: string;
  width: number | null;
}

const ffmpegPath = ffmpegInstaller.path;
const ffprobePath = ffprobeInstaller.path;

const PROCESSING_PERCENT_SHARE = 85;
const DEFAULT_UPLOAD_CONCURRENCY = 4;
const MAX_UPLOAD_CONCURRENCY = 16;

export const getUploadConcurrency = (): number => {
  const raw = process.env.S3_UPLOAD_CONCURRENCY;
  if (!raw) {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }
  return Math.min(MAX_UPLOAD_CONCURRENCY, Math.max(1, parsed));
};

const VARIANT_PROFILES: VariantProfile[] = [
  {
    id: "240p",
    label: "240p",
    height: 240,
    videoBitrate: 500_000,
    maxBitrate: 600_000,
    bufferSize: 1_200_000,
    audioBitrate: 96_000,
    x264Profile: "baseline",
    x264Level: "3.0",
  },
  {
    id: "360p",
    label: "360p",
    height: 360,
    videoBitrate: 800_000,
    maxBitrate: 1_000_000,
    bufferSize: 2_000_000,
    audioBitrate: 96_000,
    x264Profile: "baseline",
    x264Level: "3.0",
  },
  {
    id: "480p",
    label: "480p",
    height: 480,
    videoBitrate: 1_400_000,
    maxBitrate: 1_600_000,
    bufferSize: 3_000_000,
    audioBitrate: 128_000,
    x264Profile: "main",
    x264Level: "3.1",
  },
  {
    id: "720p",
    label: "720p",
    height: 720,
    videoBitrate: 2_800_000,
    maxBitrate: 3_200_000,
    bufferSize: 6_000_000,
    audioBitrate: 128_000,
    x264Profile: "high",
    x264Level: "4.0",
  },
  {
    id: "1080p",
    label: "1080p",
    height: 1080,
    videoBitrate: 5_000_000,
    maxBitrate: 5_500_000,
    bufferSize: 10_000_000,
    audioBitrate: 192_000,
    x264Profile: "high",
    x264Level: "4.2",
  },
  {
    id: "2k",
    label: "2K (1440p)",
    height: 1440,
    videoBitrate: 8_500_000,
    maxBitrate: 9_500_000,
    bufferSize: 16_000_000,
    audioBitrate: 192_000,
    x264Profile: "high",
    x264Level: "5.0",
  },
  {
    id: "4k",
    label: "4K (2160p)",
    height: 2160,
    videoBitrate: 14_000_000,
    maxBitrate: 16_000_000,
    bufferSize: 28_000_000,
    audioBitrate: 256_000,
    x264Profile: "high",
    x264Level: "5.2",
  },
];

export const formatBitrate = (bitsPerSecond: number) =>
  `${Math.max(1, Math.round(bitsPerSecond / 1_000))}k`;

export const evenDimension = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export const computeScaledWidth = (
  sourceWidth: number | null,
  sourceHeight: number | null,
  targetHeight: number,
) => {
  if (!sourceWidth || !sourceHeight || sourceHeight === 0) {
    return null;
  }
  const aspectRatio = sourceWidth / sourceHeight;
  return evenDimension(targetHeight * aspectRatio);
};

export const parseFrameRate = (value: string | undefined): number | null => {
  if (!value || value === "0/0") {
    return null;
  }
  if (value.includes("/")) {
    const [numerator, denominator] = value.split("/").map((part) => Number.parseFloat(part));
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return null;
    }
    return numerator / denominator;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isWindows = process.platform === "win32";

const ensureExecutable = async (binaryPath: string) => {
  try {
    await fs.access(binaryPath, fsConstants.F_OK);
  } catch (error) {
    throw new Error(`Binary not found at ${binaryPath}`, { cause: error });
  }

  if (isWindows) {
    return;
  }

  try {
    await fs.chmod(binaryPath, 0o755);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to set execute permission on ${binaryPath}. ${message}`, {
      cause: error,
    });
  }
};

let binariesPrepared = false;

const prepareBinaries = async () => {
  if (binariesPrepared) {
    return;
  }
  await Promise.all([ensureExecutable(ffmpegPath), ensureExecutable(ffprobePath)]);
  binariesPrepared = true;
};

const isAccessDeniedError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: string };
  return candidate.code === "EACCES";
};

export const probeVideoMetadata = async (
  inputFile: string,
  signal?: AbortSignal,
): Promise<VideoMetadata> => {
  try {
    const { stdout } = await execa(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate:format=duration",
        "-of",
        "json",
        inputFile,
      ],
      { cancelSignal: signal },
    );

    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string }>;
      format?: { duration?: string };
    };

    const stream = parsed.streams?.[0];
    const durationSeconds = parsed.format?.duration
      ? Number.parseFloat(parsed.format.duration)
      : null;

    return {
      durationMs:
        durationSeconds && Number.isFinite(durationSeconds) ? durationSeconds * 1000 : null,
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      frameRate: parseFrameRate(stream?.avg_frame_rate),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new JobCanceledError();
    }
    if (isAccessDeniedError(error)) {
      const hint = isWindows
        ? "Run the application as Administrator once to allow FFprobe to execute."
        : `Ensure the FFprobe binary at ${ffprobePath} has execute permission (chmod +x).`;
      throw new Error(`FFprobe could not start because permission was denied. ${hint}`, {
        cause: error,
      });
    }
    console.warn("Failed to read metadata with ffprobe:", error);
    return { durationMs: null, width: null, height: null, frameRate: null };
  }
};

export const determineVariantProfiles = (
  metadata: VideoMetadata,
  requestedIds?: string[],
): { variants: VariantProfile[]; warnings: string[] } => {
  const warnings: string[] = [];
  const requestedMap = new Map<string, string>();
  if (requestedIds) {
    requestedIds.forEach((id) => requestedMap.set(id.toLowerCase(), id));
  }
  const requestedSet = requestedMap.size > 0 ? new Set(requestedMap.keys()) : null;

  const knownIds = new Set(VARIANT_PROFILES.map((profile) => profile.id.toLowerCase()));
  if (requestedSet) {
    const unknown = Array.from(requestedSet).filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      const pretty = unknown.map((id) => requestedMap.get(id) ?? id);
      warnings.push(`Ignoring unknown renditions: ${pretty.join(", ")}`);
      unknown.forEach((id) => requestedSet.delete(id));
    }
  }

  const sourceHeight = metadata.height ?? null;
  const selected = VARIANT_PROFILES.filter((profile) => {
    if (requestedSet && !requestedSet.has(profile.id.toLowerCase())) {
      return false;
    }
    if (sourceHeight && profile.height > sourceHeight) {
      warnings.push(
        `Skipped ${profile.label} because the source height is only ${sourceHeight}px.`,
      );
      return false;
    }
    return true;
  }).sort((a, b) => a.height - b.height);

  if (selected.length === 0) {
    if (requestedSet && requestedSet.size > 0) {
      throw new Error(
        "None of the selected renditions are supported by this video. Choose lower resolutions and try again.",
      );
    }
    if (!sourceHeight) {
      warnings.push("Video resolution could not be detected; defaulting to 720p output.");
      return {
        variants: [
          VARIANT_PROFILES.find((profile) => profile.id === "720p") ?? VARIANT_PROFILES[2],
        ],
        warnings,
      };
    }

    const fallback = [...VARIANT_PROFILES]
      .sort((a, b) => a.height - b.height)
      .find((profile) => profile.height <= sourceHeight);

    if (fallback) {
      warnings.push(
        `Using ${fallback.label} as a fallback because no preset matched the source resolution (${sourceHeight}px).`,
      );
      return { variants: [fallback], warnings };
    }

    warnings.push("No suitable renditions found; defaulting to 360p output.");
    return {
      variants: [VARIANT_PROFILES.find((profile) => profile.id === "360p") ?? VARIANT_PROFILES[0]],
      warnings,
    };
  }

  return { variants: selected, warnings };
};

export const collectFilesRecursively = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile()) {
      files.push(entryPath);
    } else if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(entryPath)));
    }
  }

  return files;
};

export const buildProcessingPercent = (
  variantIndex: number,
  totalVariants: number,
  percentWithinVariant: number,
) => {
  if (totalVariants === 0) {
    return Math.min(PROCESSING_PERCENT_SHARE, percentWithinVariant);
  }
  const safePercent = Math.min(Math.max(percentWithinVariant, 0), 100);
  const variantSpan = PROCESSING_PERCENT_SHARE / totalVariants;
  return variantIndex * variantSpan + (safePercent / 100) * variantSpan;
};

const encodeVariant = async (
  inputFile: string,
  outputDir: string,
  profile: VariantProfile,
  metadata: VideoMetadata,
  variantIndex: number,
  totalVariants: number,
  emit: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VariantManifestInfo> => {
  const variantDir = path.join(outputDir, profile.id);
  await fs.mkdir(variantDir, { recursive: true });
  const playlistPath = path.join(variantDir, "index.m3u8");
  const segmentPattern = path.join(variantDir, "segment-%05d.ts");

  const durationMs = metadata.durationMs;
  const totalDurationUs = durationMs ? durationMs * 1000 : null;
  let progressBuffer = "";
  let lastPercent = 0;
  let currentSpeed: string | null = null;
  let hasReportedPercent = false;

  const sendProgress = (percent: number | null, extraMessage?: string) => {
    if (percent !== null) {
      lastPercent = percent;
      hasReportedPercent = true;
    }
    const effectivePercent = percent ?? lastPercent;
    const overallPercent = buildProcessingPercent(variantIndex, totalVariants, effectivePercent);
    const details = [profile.label];
    if (hasReportedPercent) {
      details.push(`${effectivePercent.toFixed(1)}%`);
    } else {
      details.push("--%");
    }
    if (currentSpeed) {
      details.push(currentSpeed);
    }
    if (extraMessage) {
      details.push(extraMessage);
    }
    emit({
      status: "processing",
      stage: `Encoding ${profile.label}`,
      percent: overallPercent,
      message: details.join(" • "),
    });
  };

  sendProgress(null, "starting");

  await new Promise<void>((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      inputFile,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      `scale=-2:${profile.height}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-profile:v",
      profile.x264Profile,
      "-level:v",
      profile.x264Level,
      "-b:v",
      formatBitrate(profile.videoBitrate),
      "-maxrate",
      formatBitrate(profile.maxBitrate),
      "-bufsize",
      formatBitrate(profile.bufferSize),
      "-g",
      "48",
      "-keyint_min",
      "48",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-b:a",
      formatBitrate(profile.audioBitrate),
      "-start_number",
      "0",
      "-hls_time",
      "6",
      "-hls_list_size",
      "0",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      segmentPattern,
      "-progress",
      "pipe:1",
      "-f",
      "hls",
      playlistPath,
    ];

    const ff = execa(ffmpegPath, args, {
      stdout: "pipe",
      stderr: "pipe",
      cancelSignal: signal,
    });

    ff.stdout?.on("data", (chunk) => {
      progressBuffer += chunk.toString();
      let newlineIndex = progressBuffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = progressBuffer.slice(0, newlineIndex).trim();
        progressBuffer = progressBuffer.slice(newlineIndex + 1);

        if (line.startsWith("out_time_ms=") && totalDurationUs) {
          const outTimeUs = Number.parseInt(line.split("=")[1] ?? "0", 10);
          if (Number.isFinite(outTimeUs) && totalDurationUs > 0) {
            const percent = Math.min((outTimeUs / totalDurationUs) * 100, 100);
            sendProgress(percent);
          }
        } else if (!durationMs && line.startsWith("out_time=")) {
          const timecode = line.split("=")[1]?.trim();
          if (timecode) {
            sendProgress(null, `time ${timecode}`);
          }
        } else if (line.startsWith("speed=")) {
          const [, speedValue] = line.split("=");
          currentSpeed = speedValue ? speedValue.trim() : null;
          sendProgress(null);
        } else if (line.startsWith("progress=") && line.endsWith("end")) {
          sendProgress(100, "finalizing");
        }

        newlineIndex = progressBuffer.indexOf("\n");
      }
    });

    ff.stderr?.on("data", (chunk) => {
      const message = chunk.toString();
      if (message.toLowerCase().includes("error")) {
        console.error(`ffmpeg error (${profile.label}):`, message);
      }
    });

    ff.then(() => {
      sendProgress(100, "completed");
      resolve();
    }).catch((error) => {
      if (signal?.aborted) {
        reject(new JobCanceledError());
        return;
      }
      reject(
        new Error(
          `FFmpeg failed for ${profile.label}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  });

  const width = computeScaledWidth(metadata.width, metadata.height, profile.height);
  return {
    profile,
    playlistRelativePath: path.relative(outputDir, playlistPath).replace(/\\/g, "/"),
    width,
  };
};

export const createMasterManifest = async (
  outputDir: string,
  variantInfos: VariantManifestInfo[],
  metadata: VideoMetadata,
) => {
  const manifestPath = path.join(outputDir, "master.m3u8");
  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];

  for (const info of variantInfos) {
    const videoBandwidth = Math.round(info.profile.videoBitrate);
    const audioBandwidth = Math.round(info.profile.audioBitrate);
    const totalBandwidth = Math.max(1, videoBandwidth + audioBandwidth);
    const averageBandwidth = Math.round(totalBandwidth * 0.9);
    const attributes: string[] = [`BANDWIDTH=${totalBandwidth}`];

    if (averageBandwidth > 0) {
      attributes.push(`AVERAGE-BANDWIDTH=${averageBandwidth}`);
    }
    if (info.width) {
      attributes.push(`RESOLUTION=${info.width}x${info.profile.height}`);
    }
    if (metadata.frameRate) {
      const formattedFrameRate = Number(metadata.frameRate.toFixed(3));
      attributes.push(`FRAME-RATE=${formattedFrameRate}`);
    }

    attributes.push('CODECS="avc1.640028,mp4a.40.2"');

    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
    lines.push(info.playlistRelativePath);
  }

  await fs.writeFile(manifestPath, `${lines.join("\n")}\n`, "utf-8");
  return manifestPath;
};

// Exported for integration tests; production callers go through processVideoJob.
export const convertToHls = async (
  inputFile: string,
  requestedRenditions: string[] | undefined,
  emit: ProgressEmitter,
  signal?: AbortSignal,
): Promise<ConversionResult> => {
  await prepareBinaries();
  const outputDir = await fs.mkdtemp(path.join(tmpdir(), "s3ream-hls-"));
  try {
    const metadata = await probeVideoMetadata(inputFile, signal);
    const { variants, warnings } = determineVariantProfiles(metadata, requestedRenditions);
    const conversionWarnings = new Set<string>(warnings);

    if (metadata.durationMs === null) {
      conversionWarnings.add(
        "Video duration could not be determined; progress estimates may be approximate.",
      );
    }

    emit({
      status: "processing",
      stage: "Converting to HLS",
      percent: 0,
      message: `Preparing ${variants.length} rendition${variants.length === 1 ? "" : "s"}`,
    });

    conversionWarnings.forEach((warning) =>
      emit({
        status: "processing",
        stage: "Converting to HLS",
        percent: 0,
        message: warning,
      }),
    );

    const variantInfos: VariantManifestInfo[] = [];

    for (let index = 0; index < variants.length; index += 1) {
      if (signal?.aborted) {
        throw new JobCanceledError();
      }
      const profile = variants[index];
      const info = await encodeVariant(
        inputFile,
        outputDir,
        profile,
        metadata,
        index,
        variants.length,
        emit,
        signal,
      );
      variantInfos.push(info);
    }

    emit({
      status: "processing",
      stage: "Converting to HLS",
      percent: PROCESSING_PERCENT_SHARE,
      message: "Packaging HLS manifests",
    });

    const manifestPath = await createMasterManifest(outputDir, variantInfos, metadata);
    const files = await collectFilesRecursively(outputDir);

    return { outputDir, manifestPath, files, warnings: Array.from(conversionWarnings) };
  } catch (error) {
    // Encoding failed (or was canceled) before the caller took ownership of
    // the temp directory — clean it up here so failed jobs don't leak files.
    await fs.rm(outputDir, { recursive: true, force: true });
    throw error;
  }
};

const uploadArtifacts = async (
  client: Client,
  bucket: string,
  baseKey: string,
  baseDir: string,
  manifestPath: string,
  files: string[],
  onProgress: (index: number, total: number, objectKey: string) => void,
  signal?: AbortSignal,
) => {
  const total = files.length;
  const normalized = sanitizeObjectKey(baseKey).replace(/\/$/, "");

  const entries = files.map((filePath) => {
    const relative = path.relative(baseDir, filePath).replace(/\\/g, "/");
    const objectKey = normalized ? `${normalized}/${relative}` : relative;
    return { filePath, objectKey };
  });

  if (entries.length > 0) {
    const maxWorkers = Math.min(getUploadConcurrency(), entries.length);
    let cursor = 0;
    let completed = 0;
    let aborted = false;
    const activeStreams = new Set<ReturnType<typeof createReadStream>>();
    // Destroying the source stream fails the in-flight putObject immediately,
    // so cancel-current does not wait for slow uploads to finish.
    const abortInFlight = () => {
      aborted = true;
      for (const stream of activeStreams) {
        stream.destroy();
      }
    };
    signal?.addEventListener("abort", abortInFlight, { once: true });

    const worker = async () => {
      while (!aborted && !signal?.aborted && cursor < entries.length) {
        const nextIndex = cursor;
        cursor += 1;
        const { filePath, objectKey } = entries[nextIndex];
        const stream = createReadStream(filePath);
        activeStreams.add(stream);
        try {
          await client.putObject(bucket, objectKey, stream);
        } catch (error) {
          // Stop sibling workers from pulling more entries once one fails.
          aborted = true;
          throw error;
        } finally {
          activeStreams.delete(stream);
          stream.destroy();
        }
        completed += 1;
        onProgress(completed, total, objectKey);
      }
    };

    try {
      await Promise.all(Array.from({ length: maxWorkers }, () => worker()));
    } catch (error) {
      if (signal?.aborted) {
        throw new JobCanceledError();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortInFlight);
    }
    if (signal?.aborted) {
      throw new JobCanceledError();
    }
  }

  const manifestRelative = path.relative(baseDir, manifestPath).replace(/\\/g, "/");
  const manifestObjectKey = normalized ? `${normalized}/${manifestRelative}` : manifestRelative;

  return manifestObjectKey;
};

const copyArtifactsToFolder = async (
  baseDir: string,
  manifestPath: string,
  files: string[],
  baseKey: string,
  destinationDir: string,
  onProgress: (index: number, total: number, objectKey: string) => void,
  signal?: AbortSignal,
) => {
  const total = files.length;
  // baseKey comes from deriveObjectKey — already slugified and stripped of
  // dot segments, so it is safe to join into a filesystem path.
  const normalized = sanitizeObjectKey(baseKey).replace(/\/$/, "");

  let completed = 0;
  for (const filePath of files) {
    if (signal?.aborted) {
      throw new JobCanceledError();
    }
    const relative = path.relative(baseDir, filePath).replace(/\\/g, "/");
    const objectKey = normalized ? `${normalized}/${relative}` : relative;
    const target = path.join(destinationDir, normalized, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(filePath, target);
    completed += 1;
    onProgress(completed, total, objectKey);
  }

  const manifestRelative = path.relative(baseDir, manifestPath).replace(/\\/g, "/");
  return normalized ? `${normalized}/${manifestRelative}` : manifestRelative;
};

export const processVideoJob = async (
  payload: VideoJobPayload,
  emit: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoJobResult> => {
  const { filePath, objectKey } = payload;
  const destination = payload.destination ?? { type: "s3" as const };
  const isLocal = destination.type === "local";
  const bucket = isLocal ? "" : getActiveBucketName();

  if (!filePath) {
    throw new Error("Video file path is required.");
  }
  if (!objectKey) {
    throw new Error("S3 object key is required.");
  }

  let s3Client: Client | null = null;
  if (!isLocal) {
    await ensureBucket(bucket);
    s3Client = getMinioClient();
  }

  let conversion: ConversionResult | null = null;
  try {
    conversion = await convertToHls(filePath, payload.renditions, emit, signal);

    if (signal?.aborted) {
      throw new JobCanceledError();
    }

    emit({
      status: "uploading",
      stage: isLocal ? "Copying to folder" : "Uploading to S3",
      percent: PROCESSING_PERCENT_SHARE + 5,
      message: isLocal ? "Starting copy" : "Starting upload",
    });

    const reportProgress = (index: number, total: number, currentObject: string) => {
      const transferPercent =
        PROCESSING_PERCENT_SHARE +
        5 +
        (index / Math.max(total, 1)) * (100 - (PROCESSING_PERCENT_SHARE + 5));
      emit({
        status: "uploading",
        stage: isLocal ? "Copying to folder" : "Uploading to S3",
        percent: Math.min(transferPercent, 100),
        message: `(${index}/${total}) ${currentObject}`,
      });
    };

    const manifestObjectKey = isLocal
      ? await copyArtifactsToFolder(
          conversion.outputDir,
          conversion.manifestPath,
          conversion.files,
          objectKey,
          destination.directory,
          reportProgress,
          signal,
        )
      : await uploadArtifacts(
          s3Client as Client,
          bucket,
          objectKey,
          conversion.outputDir,
          conversion.manifestPath,
          conversion.files,
          reportProgress,
          signal,
        );

    emit({
      status: "completed",
      stage: "Completed",
      percent: 100,
      message: isLocal ? "Files saved" : "Upload finished",
    });

    const manifestUrl = isLocal
      ? path.join(destination.directory, manifestObjectKey)
      : (buildPublicUrl(manifestObjectKey) ?? manifestObjectKey);

    return {
      success: true,
      manifestUrl,
      details: isLocal
        ? `Saved ${conversion.files.length} files to ${destination.directory}`
        : `Uploaded ${conversion.files.length} files`,
      warnings: conversion.warnings,
    };
  } finally {
    if (conversion) {
      await fs.rm(conversion.outputDir, { recursive: true, force: true });
    }
  }
};
