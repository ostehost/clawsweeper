import { createHash } from "node:crypto";
import fs from "node:fs";

export type RegularFileSnapshot = {
  bytes: number;
  sha256: string;
};

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export function sha256RegularFile(file: string): RegularFileSnapshot {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`refusing non-regular prepared publication file: ${file}`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function snapshotRegularFile(source: string, destination: string): RegularFileSnapshot {
  const sourceDescriptor = fs.openSync(source, fs.constants.O_RDONLY | NO_FOLLOW);
  let destinationDescriptor: number | undefined;
  try {
    const stat = fs.fstatSync(sourceDescriptor);
    if (!stat.isFile()) {
      throw new Error(`refusing non-regular prepared publication file: ${source}`);
    }
    destinationDescriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) {
        offset += fs.writeSync(destinationDescriptor, buffer, offset, count - offset);
      }
      bytes += count;
    }
    fs.fsyncSync(destinationDescriptor);
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (destinationDescriptor !== undefined) fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
  }
}
