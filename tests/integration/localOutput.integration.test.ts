/**
 * Local-destination integration test (opt-in via
 * `pnpm run test:integration`): real FFmpeg conversion, with the HLS tree
 * copied to a local folder instead of uploaded to S3. No S3 endpoint is
 * required for this one — it must never touch the network.
 */
import { chmodSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateTestVideo } from "./helpers";

describe("processVideoJob with a local destination", () => {
  beforeAll(() => {
    if (process.platform !== "win32") {
      chmodSync(ffmpegInstaller.path, 0o755);
    }
  });

  it("converts a video and writes the HLS tree to a local folder", async () => {
    const workDir = await fs.mkdtemp(path.join(tmpdir(), "s3ream-itest-local-"));
    try {
      const video = path.join(workDir, "clip.mp4");
      await generateTestVideo(video);

      const outDir = path.join(workDir, "out");
      await fs.mkdir(outDir, { recursive: true });

      const { processVideoJob } = await import("../../src/main/services/videoPipeline");
      const emit = vi.fn();
      const result = await processVideoJob(
        {
          filePath: video,
          objectKey: "itest/clip",
          renditions: ["240p"],
          destination: { type: "local", directory: outDir },
        },
        emit,
      );

      expect(result.success).toBe(true);
      const manifestPath = path.join(outDir, "itest", "clip", "master.m3u8");
      expect(result.manifestUrl).toBe(manifestPath);
      expect(result.details).toContain(outDir);

      const manifest = await fs.readFile(manifestPath, "utf-8");
      expect(manifest).toContain("#EXTM3U");
      expect(manifest).toContain("240p/index.m3u8");

      const variant = await fs.readFile(
        path.join(outDir, "itest", "clip", "240p", "index.m3u8"),
        "utf-8",
      );
      expect(variant).toContain("#EXTM3U");
      expect(variant).toContain("#EXTINF");

      // The TS segments must have been copied alongside the playlists.
      const segmentDir = await fs.readdir(path.join(outDir, "itest", "clip", "240p"));
      expect(segmentDir.some((name) => name.endsWith(".ts"))).toBe(true);

      // Progress should have reached completion.
      const last = emit.mock.calls[emit.mock.calls.length - 1]?.[0] as {
        status: string;
        percent: number;
      };
      expect(last.status).toBe("completed");
      expect(last.percent).toBe(100);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});
