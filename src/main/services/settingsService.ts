import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  AppSettingsView,
  MaskedS3SettingsView,
  S3SettingsInput,
  SaveProfileInput,
} from "@shared/ipc";

export interface ResolvedS3Settings {
  endpointUrl: string;
  region: string;
  bucketName: string;
  bucketUrl: string;
  viewEndpoint: string;
  pathStyle: boolean;
  uploadConcurrency: number;
  publicRead: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

interface StoredSecrets {
  format: "enc" | "plain";
  accessKeyId: string;
  secretAccessKey: string;
}

interface StoredS3Block extends Omit<ResolvedS3Settings, "accessKeyId" | "secretAccessKey"> {
  secrets: StoredSecrets;
}

interface StoredProfile {
  id: string;
  name: string;
  s3: StoredS3Block;
}

interface StoredSettings {
  s3?: StoredS3Block;
  profiles?: StoredProfile[];
}

const SETTINGS_FILENAME = "settings.json";

export const DEFAULT_UPLOAD_CONCURRENCY = 4;
export const MAX_UPLOAD_CONCURRENCY = 16;

export const clampUploadConcurrency = (value: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }
  return Math.min(MAX_UPLOAD_CONCURRENCY, Math.max(1, Math.round(value)));
};

const isValidSecrets = (secrets: unknown): secrets is StoredSecrets => {
  if (!secrets || typeof secrets !== "object") {
    return false;
  }
  const candidate = secrets as StoredSecrets;
  return (
    (candidate.format === "enc" || candidate.format === "plain") &&
    typeof candidate.accessKeyId === "string" &&
    typeof candidate.secretAccessKey === "string"
  );
};

const isValidS3Block = (s3: unknown): s3 is StoredS3Block => {
  if (!s3 || typeof s3 !== "object") {
    return false;
  }
  return isValidSecrets((s3 as StoredS3Block).secrets);
};

const isValidProfile = (profile: unknown): profile is StoredProfile => {
  if (!profile || typeof profile !== "object") {
    return false;
  }
  const candidate = profile as StoredProfile;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    isValidS3Block(candidate.s3)
  );
};

/**
 * Persists the user's S3 connection settings to `settings.json` in the
 * Electron userData directory. Secrets are encrypted at rest with the OS
 * keychain via Electron's safeStorage; on systems without a keychain the
 * values fall back to plaintext and the view reports
 * `encryptionAvailable: false` so the UI can disclose that honestly.
 *
 * The active settings (`s3`) are the single source of truth consumed by the
 * S3 client and the video pipeline. `profiles` stores named, reusable
 * connections; applying one copies it over the active settings, so secrets
 * never need to cross IPC.
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
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      // Accept each section independently: a malformed `s3` block (the legacy
      // "ignore the whole file" case) must not also discard valid profiles.
      const accepted: StoredSettings = {};
      if (isValidS3Block(parsed.s3)) {
        accepted.s3 = parsed.s3;
      }
      if (Array.isArray(parsed.profiles)) {
        const profiles = parsed.profiles.filter(isValidProfile);
        if (profiles.length > 0) {
          accepted.profiles = profiles;
        }
      }
      if (accepted.s3 || accepted.profiles) {
        this.settings = accepted;
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

  private resolveS3Block(block: StoredS3Block): ResolvedS3Settings {
    const { secrets, ...rest } = block;
    return {
      ...rest,
      // Stores written before these fields existed fall back to defaults
      // (publicRead defaults on to preserve the pre-toggle behavior).
      uploadConcurrency: rest.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY,
      publicRead: rest.publicRead ?? true,
      accessKeyId: this.decrypt(secrets.accessKeyId, secrets.format),
      secretAccessKey: this.decrypt(secrets.secretAccessKey, secrets.format),
    };
  }

  private toMaskedView(resolved: ResolvedS3Settings): MaskedS3SettingsView {
    return {
      endpointUrl: resolved.endpointUrl,
      region: resolved.region,
      bucketName: resolved.bucketName,
      bucketUrl: resolved.bucketUrl,
      viewEndpoint: resolved.viewEndpoint,
      pathStyle: resolved.pathStyle,
      uploadConcurrency: resolved.uploadConcurrency,
      publicRead: resolved.publicRead,
      hasAccessKey: resolved.accessKeyId.length > 0,
      hasSecretKey: resolved.secretAccessKey.length > 0,
    };
  }

  /**
   * Builds the stored block for a settings input. Empty secret fields mean
   * "keep the previous value" — the active settings for `save()`, or the
   * profile being overwritten for `saveProfile()`.
   */
  private buildS3Block(
    input: S3SettingsInput,
    previous?: ResolvedS3Settings | null,
  ): StoredS3Block {
    const format: StoredSecrets["format"] = this.encryptionAvailable ? "enc" : "plain";
    const accessKeyId = input.accessKeyId || previous?.accessKeyId || "";
    const secretAccessKey = input.secretAccessKey || previous?.secretAccessKey || "";
    return {
      endpointUrl: input.endpointUrl.trim(),
      region: input.region.trim(),
      bucketName: input.bucketName.trim(),
      bucketUrl: input.bucketUrl.trim(),
      viewEndpoint: input.viewEndpoint.trim(),
      pathStyle: input.pathStyle,
      uploadConcurrency: clampUploadConcurrency(input.uploadConcurrency),
      // Callers that predate the toggle omit it — default on.
      publicRead: input.publicRead !== false,
      secrets: {
        format,
        accessKeyId: this.encrypt(accessKeyId, format),
        secretAccessKey: this.encrypt(secretAccessKey, format),
      },
    };
  }

  /** Full decrypted settings for main-process use. Never sent to the renderer. */
  getS3Settings(): ResolvedS3Settings | null {
    if (!this.settings?.s3) {
      return null;
    }
    return this.resolveS3Block(this.settings.s3);
  }

  getView(): AppSettingsView {
    const resolved = this.getS3Settings();
    return {
      s3: resolved ? this.toMaskedView(resolved) : null,
      profiles: (this.settings?.profiles ?? []).map((profile) => ({
        id: profile.id,
        name: profile.name,
        s3: this.toMaskedView(this.resolveS3Block(profile.s3)),
      })),
      encryptionAvailable: this.encryptionAvailable,
    };
  }

  save(input: S3SettingsInput): ResolvedS3Settings {
    const block = this.buildS3Block(input, this.getS3Settings());
    this.settings = { ...this.settings, s3: block };
    this.persist();
    return this.resolveS3Block(block);
  }

  /**
   * Creates or updates a named connection. With `id` the matching profile is
   * overwritten (empty secrets keep that profile's stored values); without it
   * a new profile is created, even if the name collides — the renderer decides
   * when to overwrite by passing the id.
   */
  saveProfile(input: SaveProfileInput): void {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Connection name is required.");
    }
    const profiles = [...(this.settings?.profiles ?? [])];
    const index = input.id ? profiles.findIndex((profile) => profile.id === input.id) : -1;
    const previous = index >= 0 ? this.resolveS3Block(profiles[index].s3) : null;
    const block = this.buildS3Block(input.settings, previous);
    if (index >= 0) {
      profiles[index] = { id: profiles[index].id, name, s3: block };
    } else {
      profiles.push({ id: randomUUID(), name, s3: block });
    }
    this.settings = { ...this.settings, profiles };
    this.persist();
  }

  /** Removes a saved connection; unknown ids are a no-op. */
  deleteProfile(id: string): void {
    const profiles = this.settings?.profiles;
    if (!profiles) {
      return;
    }
    const next = profiles.filter((profile) => profile.id !== id);
    if (next.length === profiles.length) {
      return;
    }
    this.settings = { ...this.settings, profiles: next };
    this.persist();
  }

  /**
   * Copies a saved connection over the active settings so it becomes live for
   * jobs. The copy is deep so later profile edits cannot alias the active
   * block. Returns the resolved active settings (like `save()`).
   */
  applyProfile(id: string): ResolvedS3Settings {
    const profile = this.settings?.profiles?.find((candidate) => candidate.id === id);
    if (!profile) {
      throw new Error(`Saved connection not found: ${id}`);
    }
    const block = JSON.parse(JSON.stringify(profile.s3)) as StoredS3Block;
    this.settings = { ...this.settings, s3: block };
    this.persist();
    return this.resolveS3Block(block);
  }
}

export const settingsService = new SettingsService();
