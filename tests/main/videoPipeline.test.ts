import { chmodSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildProcessingPercent,
  collectFilesRecursively,
  computeScaledWidth,
  createMasterManifest,
  determineVariantProfiles,
  evenDimension,
  formatBitrate,
  getUploadConcurrency,
  parseFrameRate,
  probeVideoMetadata,
} from "../../src/main/services/videoPipeline";
import { configureS3 } from "../../src/main/services/minioClient";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatBitrate", () => {
  it("formats bits per second as kbps", () => {
    expect(formatBitrate(500_000)).toBe("500k");
    expect(formatBitrate(1_400_000)).toBe("1400k");
  });

  it("never goes below 1k", () => {
    expect(formatBitrate(0)).toBe("1k");
    expect(formatBitrate(1)).toBe("1k");
  });
});

describe("evenDimension", () => {
  it("rounds to the nearest even number", () => {
    expect(evenDimension(3)).toBe(4);
    expect(evenDimension(1279)).toBe(1280);
  });

  it("clamps to a minimum of 2", () => {
    expect(evenDimension(0)).toBe(2);
    expect(evenDimension(-10)).toBe(2);
  });
});

describe("computeScaledWidth", () => {
  it("returns null for unknown source dimensions", () => {
    expect(computeScaledWidth(null, 1080, 720)).toBeNull();
    expect(computeScaledWidth(1920, null, 720)).toBeNull();
    expect(computeScaledWidth(1920, 0, 720)).toBeNull();
  });

  it("preserves aspect ratio with even output", () => {
    expect(computeScaledWidth(1920, 1080, 720)).toBe(1280);
    expect(computeScaledWidth(1080, 1920, 720)).toBe(406);
  });
});

describe("parseFrameRate", () => {
  it("parses fractional rates", () => {
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("60/1")).toBe(60);
  });

  it("parses plain numbers", () => {
    expect(parseFrameRate("25")).toBe(25);
  });

  it("rejects degenerate values", () => {
    expect(parseFrameRate(undefined)).toBeNull();
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate("10/0")).toBeNull();
    expect(parseFrameRate("abc")).toBeNull();
    expect(parseFrameRate("")).toBeNull();
  });
});

describe("getUploadConcurrency", () => {
  const savedSettings = {
    endpointUrl: "http://localhost:9000",
    region: "us-east-1",
    bucketName: "videos",
    bucketUrl: "",
    viewEndpoint: "",
    pathStyle: true,
    uploadConcurrency: 6,
    publicRead: true,
    accessKeyId: "key",
    secretAccessKey: "secret",
  };

  afterEach(() => {
    configureS3(null);
  });

  it("defaults to 4 when unset", () => {
    vi.stubEnv("S3_UPLOAD_CONCURRENCY", "");
    expect(getUploadConcurrency()).toBe(4);
  });

  it("parses valid values", () => {
    vi.stubEnv("S3_UPLOAD_CONCURRENCY", "10");
    expect(getUploadConcurrency()).toBe(10);
  });

  it("clamps to the 1..16 range", () => {
    vi.stubEnv("S3_UPLOAD_CONCURRENCY", "999");
    expect(getUploadConcurrency()).toBe(16);
    vi.stubEnv("S3_UPLOAD_CONCURRENCY", "0");
    expect(getUploadConcurrency()).toBe(1);
  });

  it("falls back on garbage input", () => {
    vi.stubEnv("S3_UPLOAD_CONCURRENCY", "abc");
    expect(getUploadConcurrency()).toBe(4);
  });

  it("prefers the saved settings value over the environment", () => {
    vi.stubEnv("S3_UPLOAD_CONCURRENCY", "10");
    configureS3(savedSettings);
    expect(getUploadConcurrency()).toBe(6);
  });

  it("clamps the saved settings value", () => {
    configureS3({ ...savedSettings, uploadConcurrency: 99 });
    expect(getUploadConcurrency()).toBe(16);
  });
});

describe("buildProcessingPercent", () => {
  it("splits the 85% processing share across variants", () => {
    expect(buildProcessingPercent(0, 2, 50)).toBeCloseTo(21.25, 2);
    expect(buildProcessingPercent(1, 2, 100)).toBeCloseTo(85, 2);
  });

  it("clamps out-of-range percentages", () => {
    expect(buildProcessingPercent(1, 2, 150)).toBeCloseTo(85, 2);
    expect(buildProcessingPercent(0, 2, -50)).toBe(0);
  });

  it("handles a zero-variant edge case", () => {
    expect(buildProcessingPercent(0, 0, 120)).toBe(85);
  });
});

describe("determineVariantProfiles", () => {
  const metadata1080p = { durationMs: 60_000, width: 1920, height: 1080, frameRate: 30 };

  it("selects all profiles up to the source height, ascending", () => {
    const { variants } = determineVariantProfiles(metadata1080p);
    expect(variants.map((v) => v.id)).toEqual(["240p", "360p", "480p", "720p", "1080p"]);
  });

  it("warns about skipped taller renditions", () => {
    const { warnings } = determineVariantProfiles(metadata1080p);
    expect(warnings.some((w) => w.includes("Skipped 2K (1440p)"))).toBe(true);
    expect(warnings.some((w) => w.includes("Skipped 4K (2160p)"))).toBe(true);
  });

  it("honors explicit rendition requests case-insensitively", () => {
    const { variants } = determineVariantProfiles(metadata1080p, ["720P"]);
    expect(variants.map((v) => v.id)).toEqual(["720p"]);
  });

  it("warns about and ignores unknown rendition ids", () => {
    const { variants, warnings } = determineVariantProfiles(metadata1080p, ["480p", "bogus"]);
    expect(variants.map((v) => v.id)).toEqual(["480p"]);
    expect(warnings.some((w) => w.includes("Ignoring unknown renditions: bogus"))).toBe(true);
  });

  it("throws when requested renditions all exceed the source height", () => {
    const small = { durationMs: 10_000, width: 854, height: 480, frameRate: 30 };
    expect(() => determineVariantProfiles(small, ["4k"])).toThrow(
      /None of the selected renditions/,
    );
  });

  it("defaults to 360p when the source is smaller than every profile", () => {
    const tiny = { durationMs: 10_000, width: 320, height: 200, frameRate: 30 };
    const { variants, warnings } = determineVariantProfiles(tiny);
    expect(variants.map((v) => v.id)).toEqual(["360p"]);
    expect(warnings.some((w) => w.includes("defaulting to 360p"))).toBe(true);
  });

  it("keeps every profile when the source height is unknown", () => {
    const unknown = { durationMs: null, width: null, height: null, frameRate: null };
    const { variants } = determineVariantProfiles(unknown);
    expect(variants.length).toBe(7);
  });
});

describe("collectFilesRecursively", () => {
  it("collects files across nested directories", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "hulesa-collect-"));
    try {
      await fs.mkdir(path.join(root, "240p"), { recursive: true });
      await fs.mkdir(path.join(root, "480p", "deep"), { recursive: true });
      await fs.writeFile(path.join(root, "master.m3u8"), "#EXTM3U");
      await fs.writeFile(path.join(root, "240p", "index.m3u8"), "#EXTM3U");
      await fs.writeFile(path.join(root, "480p", "deep", "segment-00001.ts"), "ts");

      const files = await collectFilesRecursively(root);
      expect(new Set(files)).toEqual(
        new Set([
          path.join(root, "master.m3u8"),
          path.join(root, "240p", "index.m3u8"),
          path.join(root, "480p", "deep", "segment-00001.ts"),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("createMasterManifest", () => {
  const profile = {
    id: "720p",
    label: "720p",
    height: 720,
    videoBitrate: 2_800_000,
    maxBitrate: 3_200_000,
    bufferSize: 6_000_000,
    audioBitrate: 128_000,
    x264Profile: "high" as const,
    x264Level: "4.0",
  };

  it("writes a valid HLS master playlist", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "hulesa-manifest-"));
    try {
      const manifestPath = await createMasterManifest(
        dir,
        [{ profile, playlistRelativePath: "720p/index.m3u8", width: 1280 }],
        { durationMs: 60_000, width: 1920, height: 1080, frameRate: 29.97 },
      );
      expect(manifestPath).toBe(path.join(dir, "master.m3u8"));
      const content = await fs.readFile(manifestPath, "utf-8");
      expect(content).toContain("#EXTM3U");
      expect(content).toContain("#EXT-X-STREAM-INF:");
      expect(content).toContain("BANDWIDTH=2928000");
      expect(content).toContain("RESOLUTION=1280x720");
      expect(content).toContain("FRAME-RATE=29.97");
      expect(content).toContain('CODECS="avc1.640028,mp4a.40.2"');
      expect(content).toContain("720p/index.m3u8");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("omits RESOLUTION and FRAME-RATE when unknown", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "hulesa-manifest-"));
    try {
      const manifestPath = await createMasterManifest(
        dir,
        [{ profile, playlistRelativePath: "720p/index.m3u8", width: null }],
        { durationMs: null, width: null, height: null, frameRate: null },
      );
      const content = await fs.readFile(manifestPath, "utf-8");
      expect(content).not.toContain("RESOLUTION=");
      expect(content).not.toContain("FRAME-RATE=");
      expect(content).toContain("BANDWIDTH=");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("probeVideoMetadata", () => {
  beforeAll(() => {
    // Mirror videoPipeline.prepareBinaries so the bundled ffprobe is runnable
    // even after installs that skipped package scripts.
    if (process.platform !== "win32") {
      chmodSync(ffprobeInstaller.path, 0o755);
    }
  });

  it("returns nulls instead of throwing for unreadable input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const metadata = await probeVideoMetadata(path.join(tmpdir(), "hulesa-does-not-exist.mp4"));
    expect(metadata).toEqual({ durationMs: null, width: null, height: null, frameRate: null });
    warn.mockRestore();
  });
});
