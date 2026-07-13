import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeStorage } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { S3SettingsInput } from "@shared/ipc";
import { SettingsService } from "../../src/main/services/settingsService";

// The electron mock resolves app.getPath("userData") from this env var at
// construction time, so each test gets a pristine store.
const createService = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "s3ream-settings-"));
  vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
  return { service: new SettingsService(), dir, file: path.join(dir, "settings.json") };
};

const baseInput: S3SettingsInput = {
  endpointUrl: "http://localhost:9000",
  region: "us-east-1",
  bucketName: "videos",
  bucketUrl: "http://localhost:9000/videos",
  viewEndpoint: "",
  pathStyle: true,
  uploadConcurrency: 8,
  publicRead: false,
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "super-secret-value",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SettingsService", () => {
  it("starts with no settings and reports encryption as unavailable", () => {
    const { service } = createService();
    expect(service.getS3Settings()).toBeNull();
    expect(service.getView()).toEqual({ s3: null, encryptionAvailable: false });
  });

  it("round-trips settings in plaintext when OS encryption is unavailable", () => {
    const { service, dir, file } = createService();
    const resolved = service.save(baseInput);
    expect(resolved).toEqual(baseInput);

    const stored = JSON.parse(readFileSync(file, "utf-8"));
    expect(stored.s3.secrets.format).toBe("plain");
    // The plaintext fallback is honest: the raw secret sits in the file and
    // the view flags encryptionAvailable: false so the UI can disclose it.
    expect(readFileSync(file, "utf-8")).toContain("super-secret-value");

    // A fresh instance loads the same values back from disk.
    vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
    const reloaded = new SettingsService();
    expect(reloaded.getS3Settings()).toEqual(resolved);
  });

  it("clamps uploadConcurrency into the 1..16 range and defaults garbage", () => {
    const { service } = createService();
    expect(service.save({ ...baseInput, uploadConcurrency: 99 }).uploadConcurrency).toBe(16);
    expect(service.save({ ...baseInput, uploadConcurrency: 0 }).uploadConcurrency).toBe(1);
    expect(service.save({ ...baseInput, uploadConcurrency: Number.NaN }).uploadConcurrency).toBe(4);
  });

  it("defaults uploadConcurrency and publicRead for stores written before they existed", () => {
    const { service, dir, file } = createService();
    service.save(baseInput);
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    delete stored.s3.uploadConcurrency;
    delete stored.s3.publicRead;
    writeFileSync(file, JSON.stringify(stored), "utf-8");
    vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
    const reloaded = new SettingsService();
    expect(reloaded.getS3Settings()?.uploadConcurrency).toBe(4);
    // Legacy stores predate the toggle, so they keep the historical
    // policy-applying behavior (public read on).
    expect(reloaded.getS3Settings()?.publicRead).toBe(true);
  });

  it("masks secrets in the renderer-facing view", () => {
    const { service } = createService();
    service.save(baseInput);
    const view = service.getView();
    expect(view.s3?.bucketName).toBe("videos");
    expect(view.s3?.hasAccessKey).toBe(true);
    expect(view.s3?.hasSecretKey).toBe(true);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("AKIAEXAMPLE");
  });

  it("keeps the stored secrets when the input fields are left empty", () => {
    const { service } = createService();
    service.save(baseInput);
    const updated = service.save({
      ...baseInput,
      bucketName: "other-bucket",
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(updated.bucketName).toBe("other-bucket");
    expect(updated.accessKeyId).toBe("AKIAEXAMPLE");
    expect(updated.secretAccessKey).toBe("super-secret-value");
  });

  it("recovers from a corrupt settings file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(path.join(tmpdir(), "s3ream-settings-"));
    vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
    writeFileSync(path.join(dir, "settings.json"), "not valid json{", "utf-8");
    const service = new SettingsService();
    expect(service.getView().s3).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("ignores a settings file whose secrets block is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "s3ream-settings-"));
    vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ s3: { endpointUrl: "http://localhost:9000", bucketName: "videos" } }),
      "utf-8",
    );
    const service = new SettingsService();
    expect(service.getS3Settings()).toBeNull();
    expect(service.getView().s3).toBeNull();
  });

  it("encrypts secrets at rest when OS encryption is available", () => {
    vi.spyOn(safeStorage, "isEncryptionAvailable").mockReturnValue(true);
    vi.spyOn(safeStorage, "encryptString").mockImplementation((value: string) =>
      Buffer.from(`enc:${value}`, "utf-8"),
    );
    vi.spyOn(safeStorage, "decryptString").mockImplementation((buffer: Buffer) =>
      buffer.toString("utf-8").replace(/^enc:/, ""),
    );

    const { service, dir, file } = createService();
    service.save(baseInput);

    const raw = readFileSync(file, "utf-8");
    const stored = JSON.parse(raw);
    expect(stored.s3.secrets.format).toBe("enc");
    expect(raw).not.toContain("super-secret-value");
    expect(raw).not.toContain("AKIAEXAMPLE");

    // A fresh instance decrypts the values back.
    vi.stubEnv("S3REAM_TEST_USER_DATA", dir);
    const reloaded = new SettingsService();
    expect(reloaded.getS3Settings()?.accessKeyId).toBe("AKIAEXAMPLE");
    expect(reloaded.getS3Settings()?.secretAccessKey).toBe("super-secret-value");
    expect(reloaded.getView().encryptionAvailable).toBe(true);
  });

  it("treats undecryptable secrets as unset instead of crashing", () => {
    vi.spyOn(safeStorage, "isEncryptionAvailable").mockReturnValue(true);
    vi.spyOn(safeStorage, "encryptString").mockImplementation((value: string) =>
      Buffer.from(`enc:${value}`, "utf-8"),
    );
    vi.spyOn(safeStorage, "decryptString").mockImplementation(() => {
      throw new Error("keychain entry gone");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { service } = createService();
    service.save(baseInput);
    const resolved = service.getS3Settings();
    expect(resolved?.accessKeyId).toBe("");
    expect(resolved?.secretAccessKey).toBe("");
    expect(service.getView().s3?.hasAccessKey).toBe(false);
    expect(service.getView().s3?.hasSecretKey).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
