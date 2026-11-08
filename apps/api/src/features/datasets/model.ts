import { DomainError } from "../../../../../packages/contracts/src/index";

// The largest network the board takes (32 facilities x 8 wells) for a week is ~1.5M rows, ~90 MB; the judges' network
// (S6-S11) is unseen, so leave room. Memory: ~1 GB for a 0.7M-row week (measured).
export const MAX_TELEMETRY_BYTES = 160 * 1024 * 1024;
export const MAX_TELEMETRY_RECORDS = 2_500_000;
export const MAX_TIMESTEPS = 100_000;
export const MAX_FRAMES = 1_000_000;

export function invalid(file: string, path: string, message: string): never {
  throw new DomainError("INVALID_DATASET", `${file}: ${path}: ${message}`, 400, [{ file, path, message }]);
}
