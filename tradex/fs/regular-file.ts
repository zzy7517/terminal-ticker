import crypto from "node:crypto";
import fs from "node:fs";

const NOFOLLOW_NONBLOCK = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** Reads at most the snapshotted regular-file size without following a final symlink or blocking on a FIFO. */
export function readRegularFileSync(file: string, maxBytes: number): Buffer {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 0 || !Number.isSafeInteger(stat.size) || stat.size > maxBytes) {
      throw new Error("file is not a supported regular file");
    }
    const content = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === content.length ? content : content.subarray(0, offset);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

/** Appends only to a regular file, creating it without following a final symlink. */
export function appendRegularFileSync(file: string, content: string | Buffer, mode = 0o600): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY
        | fs.constants.O_APPEND
        | fs.constants.O_CREAT
        | NOFOLLOW_NONBLOCK,
      mode,
    );
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("file is not a regular file");
    fs.writeFileSync(descriptor, content);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

/** Atomically replaces a file through an unpredictable, exclusively-created regular temp file. */
export function replaceRegularFileSync(file: string, content: string | Buffer, mode = 0o600): void {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temp,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | NOFOLLOW_NONBLOCK,
      mode,
    );
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("temporary file is not a regular file");
    fs.writeFileSync(descriptor, content);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, file);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temp, { force: true });
  }
}
