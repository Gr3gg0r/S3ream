/**
 * FFmpeg integration tests (opt-in via `pnpm run test:integration`).
 *
 * Exercises the real bundled FFmpeg/FFprobe binaries: metadata probing,
 * HLS conversion, and the temp-directory cleanup guarantees.
 */
import { chmodSync, promises as fs, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { convertToHls, probeVideoMetadata } from "../../src/main/services/videoPipeline";
import { generateTestVideo } from "./helpers";

const ffmpegPath = ffmpegInstaller.path;
const ffprobePath = ffprobeInstaller.path;

const countTempDirs = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("hulesa-hls-")).length;

beforeAll(async () => {
  // Mirror videoPipeline.prepareBinaries for installs that skipped scripts.
  if (process.platform !== "win32") {
    chmodSync(ffmpegPath, 0o755);
    chmodSync(ffprobePath, 0o755);
  }
});

describe("probeVideoMetadata (real ffprobe)", () => {
  it("reads duration, dimensions, and frame rate", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "hulesa-itest-"));
    try {
      const video = path.join(dir, "probe.mp4");
      await generateTestVideo(video);
      const metadata = await probeVideoMetadata(video);
      expect(metadata.width).toBe(320);
      expect(metadata.height).toBe(240);
      expect(metadata.durationMs).not.toBeNull();
      expect(Math.abs((metadata.durationMs ?? 0) - 2000)).toBeLessThan(500);
      expect(metadata.frameRate).toBeCloseTo(15, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("convertToHls (real ffmpeg)", () => {
  it("produces a master manifest, variant playlist, and segments", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "hulesa-itest-"));
    let outputDir: string | null = null;
    try {
      const video = path.join(dir, "convert.mp4");
      await generateTestVideo(video);
      const emit = vi.fn();
      const result = await convertToHls(video, ["240p"], emit);
      outputDir = result.outputDir;

      const master = await fs.readFile(result.manifestPath, "utf-8");
      expect(master).toContain("#EXTM3U");
      expect(master).toContain("240p/index.m3u8");

      const segmentFiles = result.files.filter((file) => file.endsWith(".ts"));
      expect(segmentFiles.length).toBeGreaterThan(0);
      expect(result.files.some((file) => file.endsWith("240p/index.m3u8"))).toBe(true);

      // Progress events must have flowed through the emitter.
      expect(emit).toHaveBeenCalled();
      const last = emit.mock.calls[emit.mock.calls.length - 1]?.[0] as { percent: number };
      expect(last.percent).toBeGreaterThan(0);
    } finally {
      if (outputDir) {
        await fs.rm(outputDir, { recursive: true, force: true });
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("cleans up its temp directory when encoding fails", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "hulesa-itest-"));
    try {
      const garbage = path.join(dir, "garbage.mp4");
      await fs.writeFile(garbage, "this is definitely not a video file");
      const before = countTempDirs();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(convertToHls(garbage, ["240p"], vi.fn())).rejects.toThrow();
      error.mockRestore();
      warn.mockRestore();
      expect(countTempDirs()).toBe(before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
