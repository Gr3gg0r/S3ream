import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPublicUrl,
  parseEndpoint,
  resolveBoolean,
  sanitizeObjectKey,
} from "../../src/main/services/minioClient";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveBoolean", () => {
  it("returns the fallback when the value is undefined", () => {
    expect(resolveBoolean(undefined)).toBe(false);
    expect(resolveBoolean(undefined, true)).toBe(true);
  });

  it("accepts common truthy spellings case-insensitively", () => {
    expect(resolveBoolean("true")).toBe(true);
    expect(resolveBoolean("TRUE")).toBe(true);
    expect(resolveBoolean("1")).toBe(true);
    expect(resolveBoolean("Yes")).toBe(true);
  });

  it("treats anything else as false", () => {
    expect(resolveBoolean("false")).toBe(false);
    expect(resolveBoolean("0")).toBe(false);
    expect(resolveBoolean("garbage")).toBe(false);
    expect(resolveBoolean("")).toBe(false);
  });
});

describe("parseEndpoint", () => {
  it("falls back to local RustFS when unset", () => {
    expect(parseEndpoint(undefined)).toEqual({
      endPoint: "localhost",
      port: 9000,
      useSSL: false,
    });
    expect(parseEndpoint("")).toEqual({
      endPoint: "localhost",
      port: 9000,
      useSSL: false,
    });
  });

  it("parses an explicit http endpoint with port", () => {
    expect(parseEndpoint("http://localhost:9000")).toEqual({
      endPoint: "localhost",
      port: 9000,
      useSSL: false,
    });
  });

  it("defaults https endpoints to port 443", () => {
    expect(parseEndpoint("https://s3.amazonaws.com")).toEqual({
      endPoint: "s3.amazonaws.com",
      port: 443,
      useSSL: true,
    });
  });

  it("assumes https when the scheme is missing", () => {
    expect(parseEndpoint("rustfs.example.com:9000")).toEqual({
      endPoint: "rustfs.example.com",
      port: 9000,
      useSSL: true,
    });
  });

  it("throws on an invalid URL", () => {
    expect(() => parseEndpoint("http://")).toThrow(/Invalid S3 endpoint URL/);
  });
});

describe("sanitizeObjectKey", () => {
  it("normalizes separators, duplicates, and whitespace", () => {
    expect(sanitizeObjectKey("\\uploads\\\\my folder//video")).toBe("uploads/my-folder/video");
  });

  it("strips the leading slash", () => {
    expect(sanitizeObjectKey("/prefix/file")).toBe("prefix/file");
  });
});

describe("buildPublicUrl", () => {
  it("prefers S3_VIEW_ENDPOINT over S3_BUCKET_URL", () => {
    vi.stubEnv("S3_VIEW_ENDPOINT", "https://cdn.example.com");
    vi.stubEnv("S3_BUCKET_URL", "https://bucket.example.com");
    expect(buildPublicUrl("a/b/master.m3u8")).toBe("https://cdn.example.com/a/b/master.m3u8");
  });

  it("falls back to S3_BUCKET_URL and trims trailing slashes", () => {
    vi.stubEnv("S3_BUCKET_URL", "https://bucket.example.com/");
    expect(buildPublicUrl("/a/b")).toBe("https://bucket.example.com/a/b");
  });

  it("returns null when no base URL is configured", () => {
    vi.stubEnv("S3_VIEW_ENDPOINT", "");
    vi.stubEnv("S3_BUCKET_URL", "");
    expect(buildPublicUrl("a/b")).toBeNull();
  });
});

describe("getMinioClient", () => {
  it("throws when credentials are missing", async () => {
    vi.resetModules();
    vi.stubEnv("S3_ACCESS_KEY_ID", "");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "");
    const mod = await import("../../src/main/services/minioClient");
    expect(() => mod.getMinioClient()).toThrow(/Missing S3 credentials/);
  });

  it("constructs a client and caches it when configured", async () => {
    vi.resetModules();
    vi.stubEnv("S3_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("S3_ENDPOINT_URL", "http://localhost:9000");
    const mod = await import("../../src/main/services/minioClient");
    const first = mod.getMinioClient();
    expect(first).toBeDefined();
    expect(mod.getMinioClient()).toBe(first);
  });
});

describe("configureS3 overrides", () => {
  const override = {
    endpointUrl: "http://override.example.com:9000",
    region: "eu-west-1",
    bucketName: "override-bucket",
    bucketUrl: "https://override-cdn.example.com",
    viewEndpoint: "",
    pathStyle: false,
    uploadConcurrency: 6,
    publicRead: false,
    accessKeyId: "override-key",
    secretAccessKey: "override-secret",
  };

  it("prefers saved settings over environment variables for public URLs", async () => {
    vi.resetModules();
    vi.stubEnv("S3_VIEW_ENDPOINT", "");
    vi.stubEnv("S3_BUCKET_URL", "https://env-bucket.example.com");
    const mod = await import("../../src/main/services/minioClient");
    mod.configureS3(override);
    expect(mod.buildPublicUrl("a/b.m3u8")).toBe("https://override-cdn.example.com/a/b.m3u8");
  });

  it("falls back to environment values for empty override fields", async () => {
    vi.resetModules();
    vi.stubEnv("S3_VIEW_ENDPOINT", "https://env-cdn.example.com");
    const mod = await import("../../src/main/services/minioClient");
    mod.configureS3({ ...override, bucketUrl: "", viewEndpoint: "" });
    expect(mod.buildPublicUrl("x")).toBe("https://env-cdn.example.com/x");
  });

  it("resolves the active bucket name from settings, then env", async () => {
    vi.resetModules();
    vi.stubEnv("S3_BUCKET_NAME", "env-bucket");
    const mod = await import("../../src/main/services/minioClient");
    expect(mod.getActiveBucketName()).toBe("env-bucket");
    mod.configureS3(override);
    expect(mod.getActiveBucketName()).toBe("override-bucket");
    mod.configureS3(null);
    expect(mod.getActiveBucketName()).toBe("env-bucket");
  });

  it("resets the cached client when settings change", async () => {
    vi.resetModules();
    vi.stubEnv("S3_ACCESS_KEY_ID", "env-key");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "env-secret");
    vi.stubEnv("S3_ENDPOINT_URL", "http://localhost:9000");
    const mod = await import("../../src/main/services/minioClient");
    const first = mod.getMinioClient();
    mod.configureS3(override);
    const second = mod.getMinioClient();
    expect(second).not.toBe(first);
    mod.configureS3(null);
  });

  it("exposes the saved upload concurrency, then null when cleared", async () => {
    vi.resetModules();
    const mod = await import("../../src/main/services/minioClient");
    expect(mod.getActiveUploadConcurrency()).toBeNull();
    mod.configureS3(override);
    expect(mod.getActiveUploadConcurrency()).toBe(6);
    mod.configureS3(null);
    expect(mod.getActiveUploadConcurrency()).toBeNull();
  });

  it("exposes the saved public-read preference, then null when cleared", async () => {
    vi.resetModules();
    const mod = await import("../../src/main/services/minioClient");
    expect(mod.getActivePublicRead()).toBeNull();
    mod.configureS3(override);
    expect(mod.getActivePublicRead()).toBe(false);
    mod.configureS3(null);
    expect(mod.getActivePublicRead()).toBeNull();
  });
});
