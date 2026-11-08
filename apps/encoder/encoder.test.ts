import { expect, test } from "bun:test";
import { encodeFrame } from "./index.ts";

test("encodes raw fields, missing unrepresentable values and illegal raw enums", () => {
  const bytes = encodeFrame({ facilityId: "a", tsUnix: 123, inflowBpd: 12.5, levelPct: 999999, pumpStatus: 7, pumpFlowBpd: null, receiveFlowBpd: null, dischargePsi: null, pipelinePsi: null, wellStatus: [3], wellWaterBpd: [10] }, 2, 1);
  const v = new DataView(bytes.buffer);
  expect(v.getUint16(0, true)).toBe(2); expect(v.getUint32(4, true)).toBe(123);
  expect(v.getUint32(8, true)).toBe(1 | 4 | (1 << 8) | (1 << 16));
  expect(v.getInt16(12, true)).toBe(25); expect(v.getUint8(24)).toBe(7); expect(v.getUint16(26, true)).toBe(3);
});
