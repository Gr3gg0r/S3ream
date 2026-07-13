/**
 * Shared helpers for the opt-in integration suites
 * (`pnpm run test:integration`, requires `docker compose up -d`).
 */
import { execa } from "execa";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import type { Client } from "minio";

const ffmpegPath = ffmpegInstaller.path;

/** Generates a short 320x240 test clip with a sine-wave audio track. */
export const generateTestVideo = async (filePath: string) => {
  await execa(ffmpegPath, [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=duration=2:size=320x240:rate=15",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    filePath,
  ]);
};

/** Removes every object in the bucket, then the bucket itself. */
export const cleanupBucket = async (client: Client, bucket: string) => {
  const objects: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = client.listObjectsV2(bucket, "", true);
    stream.on("data", (item) => {
      if (item.name) objects.push(item.name);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  if (objects.length > 0) {
    await client.removeObjects(bucket, objects);
  }
  await client.removeBucket(bucket).catch(() => {});
};
