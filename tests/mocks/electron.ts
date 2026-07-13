/**
 * Mock for the `electron` module used in Node-based Vitest runs.
 *
 * Importing `electron` in plain Node resolves to a string path to the
 * binary instead of the API surface, so Vitest aliases `electron` to this
 * file (see vitest.config.ts). Only the members consumed by the services
 * under test are provided.
 */
export const app = {
  getPath: (): string => process.env.S3REAM_TEST_USER_DATA ?? "/tmp/s3ream-test",
  getName: (): string => "s3ream-test",
  getVersion: (): string => "0.0.0-test",
  isPackaged: false,
  whenReady: async (): Promise<void> => {},
  on: (): void => {},
  once: (): void => {},
  quit: (): void => {},
  setPath: (): void => {},
};

export const powerSaveBlocker = {
  start: (): number => 1,
  isStarted: (): boolean => true,
  stop: (): void => {},
};

export class BrowserWindow {
  webContents = {
    send: (): void => {},
    isDestroyed: (): boolean => false,
  };

  isDestroyed(): boolean {
    return false;
  }

  loadURL(): Promise<void> {
    return Promise.resolve();
  }

  loadFile(): Promise<void> {
    return Promise.resolve();
  }

  on(): void {}
  once(): void {}
  show(): void {}
  close(): void {}
}

export const ipcMain = {
  handle: (): void => {},
  on: (): void => {},
  removeHandler: (): void => {},
};

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: [],
  }),
};

export const shell = {
  openExternal: async (): Promise<void> => {},
};

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): Buffer => {
    throw new Error("safeStorage encryption is unavailable in tests");
  },
  decryptString: (): string => "",
};

export const webUtils = {
  getPathForFile: (file: File): string => (file as File & { path?: string }).path ?? "",
};
