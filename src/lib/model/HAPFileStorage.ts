import createDebug from "debug";
import fs from "node:fs";
import path from "node:path";

const debug = createDebug("HAP-NodeJS:HAPFileStorage");

/**
 * The persisted files hold the setup code, the accessory's signing key and the public keys of paired controllers,
 * so they and the directory they live in are only accessible to the user running HAP-NodeJS.
 */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Init options supported by {@link HAPFileStorage.initSync}.
 *
 * This is the subset of node-persist's init options which was ever functional for HAP-NodeJS's storage.
 * Passing any other node-persist option throws instead of being silently ignored.
 *
 * @group Model
 */
export interface HAPFileStorageInitOptions {
  /**
   * Path of the storage directory. If provided, it must be an absolute path.
   * If omitted, storage defaults to the directory `persist` inside the current working directory.
   */
  dir?: string;
}

const SUPPORTED_METHODS = "initSync, getItem, setItemSync and removeItemSync";

/**
 * Every method of node-persist 0.0.12's `LocalStorage` prototype which {@link HAPFileStorage} does not implement.
 * They are assigned as throwing stubs in the constructor, so code depending on the removed node-persist API
 * fails with a clear error instead of exhibiting undefined behavior.
 */
const UNSUPPORTED_METHODS = [
  "setOptions", "init", "key", "keys", "length", "forEach", "values", "valuesWithKeyMatch",
  "setItem", "getItemSync", "removeItem", "clear", "clearSync", "persist", "persistSync",
  "persistKey", "persistKeySync", "removePersistedKey", "removePersistedKeySync",
  "parseString", "parseTTLDir", "parseTTLDirSync", "parseDataDir", "parseDataDirSync",
  "parseDir", "parseDirSync", "parseDataFile", "parseDataFileSync", "parseTTLFile",
  "parseTTLFileSync", "parseFile", "parseFileSync", "isExpired", "resolveDir",
  "stopInterval", "log",
] as const;

/**
 * Minimal synchronous file storage, a drop-in replacement for the subset of `node-persist@0.0.12`
 * which HAP-NodeJS used: `initSync`, `getItem`, `setItemSync` and `removeItemSync`.
 *
 * The on-disk layout is kept byte-for-byte compatible with node-persist 0.0.12:
 * one file per key inside the storage directory, named after the raw key (no hashing or escaping),
 * containing the bare `JSON.stringify` representation of the value. Values are read once
 * at {@link initSync} and served from memory afterwards.
 *
 * Keys must therefore be plain filenames: one which names a subdirectory, escapes the storage directory
 * or starts with a dot is rejected rather than written somewhere it could never be read back from.
 *
 * Writes are atomic, which node-persist's were not: see {@link setItemSync}.
 *
 * The storage directory is restricted to its owner (`0700`) and so are the files in it (`0600`), which node-persist
 * did not do. Windows has no equivalent permission bits, so nothing is changed there. See {@link initSync}.
 *
 * @group Model
 */
export class HAPFileStorage {

  // node-persist 0.0.12 default: the relative directory "persist", resolved against the current working directory
  private dir = "persist";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly data = new Map<string, any>();

  constructor() {
    for (const method of UNSUPPORTED_METHODS) {
      // runtime-only stubs, deliberately absent from the class type: TypeScript consumers get a compile error,
      // JavaScript consumers get this error instead of "storage.keys is not a function"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)[method] = () => {
        throw new Error(`${method}() is not supported anymore: HAP-NodeJS replaced node-persist with a minimal file storage ` +
          `which only implements ${SUPPORTED_METHODS} (see https://github.com/homebridge/HAP-NodeJS/issues/1107).`);
      };
    }
  }

  /**
   * Loads the storage directory, creating it if it does not exist.
   *
   * The directory is restricted to its owner (`0700`) and so are the files already in it (`0600`).
   * Failing to do so, like on a filesystem without permission bits or for files owned by another user,
   * is logged at debug level and otherwise ignored, so that it can never keep an accessory from starting.
   */
  initSync(options?: HAPFileStorageInitOptions): void {
    if (options) {
      const unsupportedOptions = Object.keys(options).filter(key => key !== "dir");
      if (unsupportedOptions.length > 0) {
        throw new Error(`HAP-NodeJS's storage does not support the init options: ${unsupportedOptions.join(", ")}. ` +
          "Only \"dir\" is supported (see https://github.com/homebridge/HAP-NodeJS/issues/1107).");
      }

      if ("dir" in options) {
        if (typeof options.dir !== "string" || !path.isAbsolute(options.dir)) {
          // node-persist silently redirected relative paths into its own module directory inside node_modules,
          // where the data was lost on the next npm install. There is no sane location to keep that behavior.
          throw new Error(`HAP-NodeJS's storage requires an absolute storage path, got ${JSON.stringify(options.dir)}!`);
        }
        this.dir = path.normalize(options.dir);
      }
    }

    if (fs.existsSync(this.dir)) {
      // a directory created by an earlier version is typically 0755, which lets every local user list and read it
      HAPFileStorage.restrictPermissions(this.dir, DIRECTORY_MODE);

      for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) {
          continue;
        }

        const file = path.join(this.dir, entry.name);
        // only regular files hold values: reading a directory here would abort startup with a cryptic EISDIR.
        // this resolves symlinks, which entry.isDirectory() does not, so a link to a directory is skipped
        // like the directory itself while a link to a file still loads
        if (!HAPFileStorage.isFile(file)) {
          continue;
        }

        // files written by an earlier version are typically 0644, and would stay that way until their next write.
        // a symlink is left alone, as chmod follows it and would change a file outside the storage directory
        if (entry.isFile()) {
          HAPFileStorage.restrictPermissions(file, FILE_MODE);
        }

        this.data.set(entry.name, HAPFileStorage.parse(fs.readFileSync(file, "utf8")));
      }
    } else {
      fs.mkdirSync(this.dir, { recursive: true });
      HAPFileStorage.restrictPermissions(this.dir, DIRECTORY_MODE);
    }
  }

  /**
   * Returns the in-memory value for the given key.
   * node-persist's legacy `getItem(key, callback)` form throws, like every other removed API.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getItem(key: string, ...legacyCallback: never[]): any {
    if (legacyCallback.length > 0) {
      throw new Error("getItem() with a callback is not supported anymore: HAP-NodeJS replaced node-persist with a minimal file storage " +
        `which only implements ${SUPPORTED_METHODS} (see https://github.com/homebridge/HAP-NodeJS/issues/1107).`);
    }

    return this.data.get(key);
  }

  /**
   * Persists the given value, replacing the file for this key atomically.
   *
   * The value is written to a temporary file which is then renamed over the target, so an interrupted write
   * leaves the previous contents intact instead of a truncated file. This matters because a truncated
   * `AccessoryInfo` file reads back as an accessory which lost its pairings.
   *
   * The in-memory value is only replaced once the new one reached the disk, so a failed write cannot leave
   * an accessory which reads as paired now and unpaired after a restart.
   *
   * The temporary file is created owner-only (`0600`) and the rename carries that mode over to the target,
   * so a file which was world-readable before is restricted by its next write.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  setItemSync(key: string, value: any): void {
    HAPFileStorage.assertPlainKey(key);

    // node-persist 0.0.12 ran mkdirp.sync before every write, which recreated a storage directory removed at runtime.
    // mkdirSync only returns a path when it created something, so an existing directory is not chmod'ed on every write
    if (fs.mkdirSync(this.dir, { recursive: true }) !== undefined) {
      HAPFileStorage.restrictPermissions(this.dir, DIRECTORY_MODE);
    }

    const file = path.join(this.dir, key);
    // the dot prefix keeps a temporary file left behind by a crash from being loaded as a key by initSync,
    // the pid keeps processes sharing a storage directory (like child bridges) from racing on the same temporary file.
    // it sits in the storage directory next to its target, as renaming across directories would not be atomic
    const temporaryFile = path.join(this.dir, `.${key}.${process.pid}.tmp`);

    try {
      // the mode applies when the file is created, which the temporary file is unless a crashed process with the same
      // pid left one behind. it is a no-op on Windows, and 0600 does not make the file read-only there
      fs.writeFileSync(temporaryFile, JSON.stringify(value), { mode: FILE_MODE });
      fs.renameSync(temporaryFile, file);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch {
        // the temporary file may never have been created, in which case there is nothing to clean up
      }

      throw error;
    }

    // only now that the value is on disk: everything is served from memory afterwards, so a value cached
    // for a write which never landed would be indistinguishable from a saved one until the next restart
    this.data.set(key, value);
  }

  removeItemSync(key: string): void {
    HAPFileStorage.assertPlainKey(key);

    // force ignores a file which is already gone, without the exists-then-unlink
    // gap in which another process (child bridges share a storage directory)
    // could remove the file first and turn this into an ENOENT crash
    fs.rmSync(path.join(this.dir, key), { force: true });

    this.data.delete(key);
  }

  /**
   * Rejects a key which is not a plain filename, before it reaches the filesystem.
   *
   * `path.join` would otherwise read a key as a path: `nested/key.json` writes into a subdirectory which
   * {@link initSync} skips, so the value comes back `undefined` after a restart, and `../escaped.json` writes
   * outside the storage directory altogether. node-persist 0.0.12 created such subdirectories too, but crashed
   * with `EISDIR` on the next load rather than losing the value quietly.
   *
   * A leading dot is rejected for the same reason: {@link initSync} skips dotfiles, so `.hidden` would be
   * written, served from memory while the process runs, and then be gone after a restart.
   */
  private static assertPlainKey(key: string): void {
    if (!key || key.startsWith(".") || /[/\\]/.test(key)) {
      throw new Error(`HAP-NodeJS's storage requires a key which is a plain filename, got ${JSON.stringify(key)}! ` +
        "One file is kept per key inside the storage directory, so a key can neither name a subdirectory, escape it, " +
        "nor start with a dot, which would be skipped the next time the directory is loaded.");
    }
  }

  /**
   * Restricts the given path to the given mode, without ever throwing.
   *
   * chmod is rejected on filesystems without permission bits (FAT, some network and container mounts) and for
   * paths owned by another user, which is what happens when a container which ran as root is switched to a
   * non-root user. Neither is a reason to refuse starting up, as the storage worked before it was restricted,
   * so the failure is only logged. Windows has no permission bits to restrict, so nothing is attempted there.
   */
  private static restrictPermissions(target: string, mode: number): void {
    if (process.platform === "win32") {
      return;
    }

    try {
      fs.chmodSync(target, mode);
    } catch (error) {
      debug("Could not restrict '%s' to mode %s: %s", target, mode.toString(8), (error as NodeJS.ErrnoException).code ?? error);
    }
  }

  /**
   * Whether the given path is a regular file, following symlinks.
   *
   * An entry which cannot be stat'ed at all, like a broken or circular symlink, is one to skip
   * rather than one to abort startup over.
   */
  private static isFile(file: string): boolean {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static parse(json: string): any {
    try {
      return JSON.parse(json);
    } catch {
      // node-persist 0.0.12 swallowed unparseable files, leaving the value undefined
      return undefined;
    }
  }

}
