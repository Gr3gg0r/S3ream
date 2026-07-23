/**
 * End-to-end pipeline integration test (opt-in via
 * `pnpm run test:integration`): real FFmpeg conversion plus real upload to
 * a RustFS container, verified through the anonymous public URL.
 *
 *   docker compose up -d
 *   pnpm run test:integration
 */
import { chmodSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupBucket, generateTestVideo } from "./helpers";

const endpoint = process.env.S3_TEST_ENDPOINT_URL ?? "http://localhost:9000";
const bucket = `hulesa-itest-pipeline-${Date.now()}`;
const objectKey = "itest/clip";

const reachable = await fetch(endpoint)
  .then(() => true)
  .catch(() => false);

describe.skipIf(!reachable)("processVideoJob end to end", () => {
  beforeAll(() => {
    if (process.platform !== "win32") {
      chmodSync(ffmpegInstaller.path, 0o755);
    }
    vi.stubEnv("S3_ENDPOINT_URL", endpoint);
    vi.stubEnv("S3_ACCESS_KEY_ID", process.env.S3_TEST_ACCESS_KEY ?? "rustfsadmin");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", process.env.S3_TEST_SECRET_KEY ?? "rustfsadmin");
    vi.stubEnv("S3_REGION", "us-east-1");
    vi.stubEnv("S3_BUCKET_NAME", bucket);
    vi.stubEnv("S3_BUCKET_URL", `${endpoint}/${bucket}`);
    vi.stubEnv("S3_USE_PATH_STYLE_ENDPOINT", "true");
  });

  afterAll(async () => {
    const { getMinioClient } = await import("../../src/main/services/minioClient");
    await cleanupBucket(getMinioClient(), bucket);
    vi.unstubAllEnvs();
  });

  it("converts a video, uploads HLS assets, and serves the manifest", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "hulesa-itest-"));
    try {
      const video = path.join(dir, "clip.mp4");
      await generateTestVideo(video);

      const { processVideoJob } = await import("../../src/main/services/videoPipeline");
      const emit = vi.fn();
      const result = await processVideoJob(
        { filePath: video, objectKey, renditions: ["240p"] },
        emit,
      );

      expect(result.success).toBe(true);
      expect(result.manifestUrl).toBe(`${endpoint}/${bucket}/${objectKey}/master.m3u8`);

      const manifestUrl = result.manifestUrl;
      if (!manifestUrl) {
        throw new Error("Expected a manifest URL from the completed job");
      }
      const response = await fetch(manifestUrl);
      expect(response.status).toBe(200);
      const manifest = await response.text();
      expect(manifest).toContain("#EXTM3U");
      expect(manifest).toContain("240p/index.m3u8");

      // The variant playlist must be reachable too.
      const variantUrl = `${endpoint}/${bucket}/${objectKey}/240p/index.m3u8`;
      const variantResponse = await fetch(variantUrl);
      expect(variantResponse.status).toBe(200);
      expect(await variantResponse.text()).toContain("#EXTM3U");

      // Progress should have reached completion.
      const last = emit.mock.calls[emit.mock.calls.length - 1]?.[0] as {
        status: string;
        percent: number;
      };
      expect(last.status).toBe("completed");
      expect(last.percent).toBe(100);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
