import path from "node:path";
import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AppSettingsView, S3SettingsInput } from "@shared/ipc";

export interface ResolvedS3Settings {
  endpointUrl: string;
  region: string;
  bucketName: string;
  bucketUrl: string;
  viewEndpoint: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

interface StoredSecrets {
  format: "enc" | "plain";
  accessKeyId: string;
  secretAccessKey: string;
}

interface StoredSettings {
  s3: Omit<ResolvedS3Settings, "accessKeyId" | "secretAccessKey"> & {
    secrets: StoredSecrets;
  };
}

const SETTINGS_FILENAME = "settings.json";

/**
 * Persists the user's S3 connection settings to `settings.json` in the
 * Electron userData directory. Secrets are encrypted at rest with the OS
 * keychain via Electron's safeStorage; on systems without a keychain the
 * values fall back to plaintext and the view reports
 * `encryptionAvailable: false` so the UI can disclose that honestly.
 */
export class SettingsService {
  private settings: StoredSettings | null = null;
  private filePath: string;

  constructor() {
    const userDataPath = app.getPath("userData");
    if (!existsSync(userDataPath)) {
      mkdirSync(userDataPath, { recursive: true });
    }
    this.filePath = path.join(userDataPath, SETTINGS_FILENAME);
    this.load();
  }

  get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private load() {
    if (!existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as StoredSettings;
      const secrets = parsed?.s3?.secrets;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.s3 &&
        secrets &&
        typeof secrets === "object" &&
        (secrets.format === "enc" || secrets.format === "plain") &&
        typeof secrets.accessKeyId === "string" &&
        typeof secrets.secretAccessKey === "string"
      ) {
        this.settings = parsed;
      }
    } catch (error) {
      console.warn("Failed to load settings, ignoring stored values.", error);
      this.settings = null;
    }
  }

  private persist() {
    // Temp-file + rename so a crash mid-write cannot truncate settings.json.
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.settings, null, 2), "utf-8");
    renameSync(tempPath, this.filePath);
  }

  private encrypt(value: string, format: StoredSecrets["format"]): string {
    if (!value) {
      return "";
    }
    if (format === "enc") {
      return safeStorage.encryptString(value).toString("base64");
    }
    return value;
  }

  private decrypt(value: string, format: StoredSecrets["format"]): string {
    if (!value) {
      return "";
    }
    if (format === "enc") {
      try {
        return safeStorage.decryptString(Buffer.from(value, "base64"));
      } catch (error) {
        // Keychain entry lost (OS reinstall, profile change) — treat as unset
        // rather than crashing startup; the user re-enters the secret.
        console.warn("Unable to decrypt stored secret; treating as unset.", error);
        return "";
      }
    }
    return value;
  }

  /** Full decrypted settings for main-process use. Never sent to the renderer. */
  getS3Settings(): ResolvedS3Settings | null {
    if (!this.settings) {
      return null;
    }
    const { secrets, ...rest } = this.settings.s3;
    return {
      ...rest,
      accessKeyId: this.decrypt(secrets.accessKeyId, secrets.format),
      secretAccessKey: this.decrypt(secrets.secretAccessKey, secrets.format),
    };
  }

  getView(): AppSettingsView {
    const resolved = this.getS3Settings();
    return {
      s3: resolved
        ? {
            endpointUrl: resolved.endpointUrl,
            region: resolved.region,
            bucketName: resolved.bucketName,
            bucketUrl: resolved.bucketUrl,
            viewEndpoint: resolved.viewEndpoint,
            pathStyle: resolved.pathStyle,
            hasAccessKey: resolved.accessKeyId.length > 0,
            hasSecretKey: resolved.secretAccessKey.length > 0,
          }
        : null,
      encryptionAvailable: this.encryptionAvailable,
    };
  }

  save(input: S3SettingsInput): ResolvedS3Settings {
    const previous = this.getS3Settings();
    const format: StoredSecrets["format"] = this.encryptionAvailable ? "enc" : "plain";

    // Empty secret fields mean "keep the existing value".
    const accessKeyId = input.accessKeyId || previous?.accessKeyId || "";
    const secretAccessKey = input.secretAccessKey || previous?.secretAccessKey || "";

    this.settings = {
      s3: {
        endpointUrl: input.endpointUrl.trim(),
        region: input.region.trim(),
        bucketName: input.bucketName.trim(),
        bucketUrl: input.bucketUrl.trim(),
        viewEndpoint: input.viewEndpoint.trim(),
        pathStyle: input.pathStyle,
        secrets: {
          format,
          accessKeyId: this.encrypt(accessKeyId, format),
          secretAccessKey: this.encrypt(secretAccessKey, format),
        },
      },
    };
    this.persist();
    return this.getS3Settings() as ResolvedS3Settings;
  }
}

export const settingsService = new SettingsService();
