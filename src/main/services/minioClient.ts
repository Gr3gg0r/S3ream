import { Client } from "minio";
import type { ResolvedS3Settings } from "./settingsService";

/**
 * Runtime configuration override, applied when the user saves connection
 * settings in the app. Takes precedence over environment variables for any
 * non-empty field; env vars remain as the fallback for the dev:* presets.
 */
let configOverride: ResolvedS3Settings | null = null;

export const configureS3 = (settings: ResolvedS3Settings | null) => {
  configOverride = settings;
  cachedClient = null;
};

/** Upload worker count from saved settings; null when unset so env/default applies. */
export const getActiveUploadConcurrency = (): number | null =>
  configOverride?.uploadConcurrency ?? null;

/** Public-read preference from saved settings; null when unset so the policy applies. */
export const getActivePublicRead = (): boolean | null => configOverride?.publicRead ?? null;

const resolveValue = (overrideValue: string | undefined, envValue: string | undefined) => {
  if (overrideValue && overrideValue.length > 0) {
    return overrideValue;
  }
  return envValue ?? "";
};

export const resolveBoolean = (value: string | undefined, fallback = false) => {
  if (value === undefined) {
    return fallback;
  }
  return ["true", "1", "yes"].includes(value.toLowerCase());
};

export const parseEndpoint = (rawEndpoint: string | undefined) => {
  const fallback = "http://localhost:9000";
  const value = rawEndpoint && rawEndpoint.length > 0 ? rawEndpoint : fallback;
  const normalized = value.includes("://") ? value : `https://${value}`;
  let url: URL;

  try {
    url = new URL(normalized);
  } catch (error) {
    throw new Error(`Invalid S3 endpoint URL. Received "${value}".`, { cause: error });
  }

  const useSSL = url.protocol === "https:";
  const port = url.port ? Number.parseInt(url.port, 10) : useSSL ? 443 : 80;

  return {
    endPoint: url.hostname,
    port,
    useSSL,
  };
};

const createClient = () => {
  const accessKey = resolveValue(configOverride?.accessKeyId, process.env.S3_ACCESS_KEY_ID);
  const secretKey = resolveValue(configOverride?.secretAccessKey, process.env.S3_SECRET_ACCESS_KEY);
  const region = resolveValue(configOverride?.region, process.env.S3_REGION) || undefined;
  const pathStyle = configOverride
    ? configOverride.pathStyle
    : resolveBoolean(process.env.S3_USE_PATH_STYLE_ENDPOINT, true);
  const { endPoint, port, useSSL } = parseEndpoint(
    resolveValue(configOverride?.endpointUrl, process.env.S3_ENDPOINT_URL) || undefined,
  );

  if (!accessKey || !secretKey) {
    throw new Error(
      "Missing S3 credentials. Open S3 settings in the app, or set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.",
    );
  }

  return new Client({
    endPoint,
    port,
    region,
    accessKey,
    secretKey,
    useSSL,
    pathStyle,
  });
};

/** Bucket name from saved settings, falling back to the environment. */
export const getActiveBucketName = () =>
  resolveValue(configOverride?.bucketName, process.env.S3_BUCKET_NAME);

let cachedClient: Client | null = null;

export const getMinioClient = () => {
  if (!cachedClient) {
    cachedClient = createClient();
  }
  return cachedClient;
};

export const ensureBucket = async (bucket: string) => {
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME is required.");
  }
  const client = getMinioClient();
  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket, resolveValue(configOverride?.region, process.env.S3_REGION));
  }
  // Only skip when the user explicitly disabled public read; env-only setups
  // (no saved settings) keep the historical behavior of applying the policy.
  if (getActivePublicRead() !== false) {
    await ensurePublicReadPolicy(client, bucket);
  }
};

export const buildPublicUrl = (objectKey: string) => {
  const viewEndpoint = resolveValue(configOverride?.viewEndpoint, process.env.S3_VIEW_ENDPOINT);
  const bucketUrl = resolveValue(configOverride?.bucketUrl, process.env.S3_BUCKET_URL);
  const base = (viewEndpoint || bucketUrl).replace(/\/$/, "");
  if (!base) {
    return null;
  }
  const normalized = objectKey.replace(/^\//, "");
  return `${base}/${normalized}`;
};

export const sanitizeObjectKey = (objectKey: string) =>
  objectKey
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "")
    .replace(/\s+/g, "-");

const readPolicyDocument = (bucket: string) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });

const ensurePublicReadPolicy = async (client: Client, bucket: string) => {
  const policy = readPolicyDocument(bucket);
  try {
    const currentPolicy = await client.getBucketPolicy(bucket);
    if (currentPolicy === policy) {
      return;
    }
  } catch (error) {
    if ((error as Error & { code?: string }).code !== "NoSuchBucketPolicy") {
      console.warn("Unable to read existing bucket policy:", error);
    }
  }
  await client.setBucketPolicy(bucket, policy);
};
