import { Client } from "minio";

const resolveBoolean = (value: string | undefined, fallback = false) => {
  if (value === undefined) {
    return fallback;
  }
  return ["true", "1", "yes"].includes(value.toLowerCase());
};

const parseEndpoint = (rawEndpoint: string | undefined) => {
  const fallback = "http://localhost:9000";
  const value = rawEndpoint && rawEndpoint.length > 0 ? rawEndpoint : fallback;
  const normalized = value.includes("://") ? value : `https://${value}`;
  let url: URL;

  try {
    url = new URL(normalized);
  } catch (error) {
    throw new Error(`Invalid S3 endpoint URL. Received "${value}".`);
  }

  const useSSL = url.protocol === "https:";
  const port = url.port ? Number.parseInt(url.port, 10) : useSSL ? 443 : 80;

  return {
    endPoint: url.hostname,
    port,
    useSSL
  };
};

const createClient = () => {
  const accessKey = process.env.S3_ACCESS_KEY_ID ?? "";
  const secretKey = process.env.S3_SECRET_ACCESS_KEY ?? "";
  const region = process.env.S3_REGION;
  const pathStyle = resolveBoolean(process.env.S3_USE_PATH_STYLE_ENDPOINT, true);
  const { endPoint, port, useSSL } = parseEndpoint(process.env.S3_ENDPOINT_URL);

  if (!accessKey || !secretKey) {
    throw new Error("Missing S3 credentials. Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.");
  }

  return new Client({
    endPoint,
    port,
    region,
    accessKey,
    secretKey,
    useSSL,
    pathStyle
  });
};

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
    await client.makeBucket(bucket, process.env.S3_REGION ?? "");
  }
  await ensurePublicReadPolicy(client, bucket);
};

export const buildPublicUrl = (objectKey: string) => {
  const base = (process.env.S3_VIEW_ENDPOINT ?? process.env.S3_BUCKET_URL ?? "").replace(/\/$/, "");
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
        Resource: [`arn:aws:s3:::${bucket}/*`]
      }
    ]
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
