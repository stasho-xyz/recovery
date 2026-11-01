import { closeSync, fchmodSync, openSync, writeFileSync } from "node:fs";

/**
 * Writes the recovery output readable by the owner only: it holds decrypted
 * project data. `fchmod` runs before any content lands, because `open`'s mode
 * applies only to a file it creates, not to one a previous run left at 0644.
 */
export function writeRecoveryFile(path: string, contents: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}
