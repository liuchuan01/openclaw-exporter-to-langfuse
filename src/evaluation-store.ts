import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/** One atomic file per request; only the running plugin service opens this store. */
export function createEvaluationStore(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = (id: string) =>
    join(directory, createHash("sha256").update(id).digest("hex") + ".json");
  return {
    read(): unknown[] {
      return readdirSync(directory)
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
    },
    write(id: string, value: unknown) {
      const target = path(id);
      const temporary = target + "." + randomUUID() + ".tmp";
      try {
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify(value));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, target);
        const directoryFd = openSync(directory, "r");
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      } finally {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
    remove(id: string) {
      try {
        unlinkSync(path(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
