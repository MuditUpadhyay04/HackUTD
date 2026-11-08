import { readFile } from "node:fs/promises";
import { DomainError } from "@hackutd/contracts";

/** Trusted host configuration, not a dataset format or FPGA wire format. */
export interface RegisteredModel {
  id: string;
  weightsVer: number;
  weights: number[];
  biases: number[];
  outputShift: number;
  /** Multiplier converting an int16 simulator logit to a dimensionless log-odds value. */
  logitScale: number;
  thresholds: [number, number, number, number];
  persistK: number;
}

export function parseRegisteredModel(input: unknown): RegisteredModel {
  const fail = (): never => { throw new DomainError("invalid_model_metadata", "Invalid registered model metadata", 400); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const m = input as Record<string, unknown>;
  const integer = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  if (typeof m.id !== "string" || !m.id.trim() || !integer(m.weightsVer, 1, 255) || !integer(m.outputShift, 0, 47) || !integer(m.persistK, 1, Number.MAX_SAFE_INTEGER) || typeof m.logitScale !== "number" || !Number.isFinite(m.logitScale) || m.logitScale <= 0) return fail();
  if (!Array.isArray(m.weights) || m.weights.length !== 124 || !m.weights.every(v => integer(v, -32768, 32767))) return fail();
  if (!Array.isArray(m.biases) || m.biases.length !== 4 || !m.biases.every(v => integer(v, -2147483648, 2147483647))) return fail();
  if (!Array.isArray(m.thresholds) || m.thresholds.length !== 4 || !m.thresholds.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) return fail();
  return { id: m.id, weightsVer: m.weightsVer, weights: [...m.weights], biases: [...m.biases], outputShift: m.outputShift, logitScale: m.logitScale, thresholds: [...m.thresholds] as RegisteredModel["thresholds"], persistK: m.persistK };
}

/** Only call with an administrator-controlled server config path, never an upload. */
export async function readRegisteredModel(path: string): Promise<RegisteredModel> {
  return parseRegisteredModel(JSON.parse(await readFile(path, "utf8")));
}
