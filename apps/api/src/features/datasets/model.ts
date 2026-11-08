import { DomainError } from "../../../../../packages/contracts/src/index";

export const MAX_TELEMETRY_BYTES = 40 * 1024 * 1024;
export const MAX_TELEMETRY_RECORDS = 1_000_000;
export const MAX_TIMESTEPS = 100_000;
export const MAX_FRAMES = 1_000_000;

export function invalid(file: string, path: string, message: string): never {
  throw new DomainError("INVALID_DATASET", `${file}: ${path}: ${message}`, 400, [{ file, path, message }]);
}
