/**
 * S3 integration tests against a live RustFS container (opt-in via
 * `pnpm run test:integration`). Bring the stack up first:
 *
 *   docker compose up -d
 *
 * Point at a non-default port with S3_TEST_ENDPOINT_URL, e.g.
 *   S3_TEST_ENDPOINT_URL=http://localhost:9002 pnpm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupBucket } from "./helpers";

const endpoint = process.env.S3_TEST_ENDPOINT_URL ?? "http://localhost:9000";
const bucket = `s3ream-itest-${Date.now()}`;

// Any HTTP response means the server is up; only a connection failure skips.
const reachable = await fetch(endpoint)
  .then(() => true)
  .catch(() => false);

describe.skipIf(!reachable)("RustFS round trip", () => {
  beforeAll(() => {
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

  it("creates the bucket and is idempotent", async () => {
    const { ensureBucket, getMinioClient } = await import("../../src/main/services/minioClient");
    const client = getMinioClient();
    await ensureBucket(bucket);
    expect(await client.bucketExists(bucket)).toBe(true);
    // Second call must not throw (bucket exists, policy already in place).
    await ensureBucket(bucket);
  });

  it("uploads an object that is anonymously readable via buildPublicUrl", async () => {
    const { buildPublicUrl, getMinioClient } = await import("../../src/main/services/minioClient");
    const client = getMinioClient();
    const key = "round-trip/hello.txt";
    await client.putObject(bucket, key, "hello s3ream");

    const url = buildPublicUrl(key);
    expect(url).toBe(`${endpoint}/${bucket}/${key}`);
    const response = await fetch(url ?? "");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello s3ream");
  });
});
