"""Integer logistic heads, int16 quantization and the weight blob (docs/plan/mudit/ml_plan.md section 4.8).

logit_q = sat16((sum_i w_q[i] * x_q[i] + b_q + 2^(S_out - 1)) >> S_out)
  x_q: features, 14 fractional bits (1/16384); w_q: int16 with Fw fractional bits;
  b_q: int32 with Fw + 14 fractional bits; logit_q: L_OUT = 8 fractional bits (1/256 logit units).
  S_out = Fw + 14 - L_OUT.

Blob (little-endian, PROPOSED layout until Lucas confirms open question 11):
  0 u16 blob_format=1 | 2 u8 n_heads=4 | 3 u8 n_features=31 | 4 u8 S_out | 5 u8 n_vectors | 6 u16 feature_set_id
  8 i16[4][31] weights (head-major, logit order) | 256 i32[4] biases | 272 u32 model_hash | 276 u32 reserved
  280 n_vectors x {i16[31] features, i16[4] expected logits}
CRC32 (zlib / IEEE 802.3) over the whole blob goes in the COMMIT chunk.
"""
import hashlib
import json
import struct
import zlib

import numpy as np

from .features_int import FEATURE_SET_ID, N_FEATURES, Weights, round_shift

L_OUT = 8
BLOB_FORMAT = 1
HDR = struct.Struct("<HBBBBH")
MAX_VECTORS = 10
MAX_BLOB = 1024


def logits_int(X, w_q, b_q, s_out):
    """Vectorized integer heads. X: (N, 31) int features. Returns (N, 4) int16 logits (as int64)."""
    acc = np.asarray(X, dtype=np.int64) @ np.asarray(w_q, dtype=np.int64).T + np.asarray(b_q, dtype=np.int64)
    assert np.abs(acc).max(initial=0) < 2 ** 47, "48-bit accumulator overflow"
    return np.clip(round_shift(acc, s_out), -32768, 32767)


def quantize(w, b, l_out=L_OUT):
    """Float weights (4 x 31) and biases (4) -> int16 weights, int32 biases, S_out with one shared Fw."""
    w = np.asarray(w, dtype=float)
    b = np.asarray(b, dtype=float)
    fw = int(np.floor(np.log2(32767 / max(np.abs(w).max(), 1e-12))))
    fw_bias = 31 - 14 - int(np.ceil(np.log2(np.abs(b).max() + 1))) - 1
    fw = min(fw, fw_bias, 30)
    s_out = fw + 14 - l_out
    if s_out < 1:
        raise ValueError(f"weights too large to export: Fw = {fw}")
    w_q = np.round(w * 2 ** fw).astype(np.int64)
    b_q = np.round(b * 2 ** (fw + 14)).astype(np.int64)
    assert np.abs(w_q).max() <= 32767 and np.abs(b_q).max() < 2 ** 31
    return w_q, b_q, s_out, fw


def model_hash(meta):
    return int.from_bytes(hashlib.sha256(json.dumps(meta, sort_keys=True).encode()).digest()[:4], "little")


def pack_blob(w_q, b_q, s_out, vectors=(), mhash=0):
    vectors = list(vectors)[:MAX_VECTORS]
    out = bytearray(HDR.pack(BLOB_FORMAT, 4, N_FEATURES, s_out, len(vectors), FEATURE_SET_ID))
    out += np.asarray(w_q, dtype="<i2").reshape(4, N_FEATURES).tobytes()
    out += np.asarray(b_q, dtype="<i4").reshape(4).tobytes()
    out += struct.pack("<II", mhash, 0)
    assert len(out) == 280
    for x in vectors:
        exp = logits_int(np.asarray(x).reshape(1, N_FEATURES), w_q, b_q, s_out)[0]
        out += np.asarray(x, dtype="<i2").tobytes() + exp.astype("<i2").tobytes()
    assert len(out) <= MAX_BLOB
    return bytes(out)


def unpack_blob(blob):
    fmt, nh, nf, s_out, nv, fsid = HDR.unpack_from(blob)
    if (fmt, nh, nf, fsid) != (BLOB_FORMAT, 4, N_FEATURES, FEATURE_SET_ID):
        raise ValueError(f"unsupported blob: format {fmt}, heads {nh}, features {nf}, feature set {fsid}")
    w_q = np.frombuffer(blob, dtype="<i2", count=4 * N_FEATURES, offset=8).reshape(4, N_FEATURES).astype(np.int64)
    b_q = np.frombuffer(blob, dtype="<i4", count=4, offset=256).astype(np.int64)
    mhash, _ = struct.unpack_from("<II", blob, 272)
    vectors = []
    for i in range(nv):
        off = 280 + i * 70
        x = np.frombuffer(blob, dtype="<i2", count=N_FEATURES, offset=off).astype(np.int64)
        e = np.frombuffer(blob, dtype="<i2", count=4, offset=off + 62).astype(np.int64)
        vectors.append((x, e))
    return {"w_q": w_q, "b_q": b_q, "s_out": s_out, "vectors": vectors, "model_hash": mhash}


def self_test(blob):
    """What the board does on COMMIT: check the header, recompute every packed vector and compare. A header the
    board can't run (format, heads, features, feature set) fails like a bad vector: ACK status 3 (FPGA #67 / #75)."""
    try:
        m = unpack_blob(blob)
    except (ValueError, struct.error):
        return False
    for x, e in m["vectors"]:
        if not np.array_equal(logits_int(x.reshape(1, -1), m["w_q"], m["b_q"], m["s_out"])[0], e):
            return False
    return True


def crc32(blob):
    return zlib.crc32(blob) & 0xFFFFFFFF


def to_weights(blob, version):
    m = unpack_blob(blob)
    return Weights(w=m["w_q"].tolist(), b=m["b_q"].tolist(), s_out=int(m["s_out"]), version=int(version))


def edge_vectors():
    """Synthetic self-test vectors that exercise sign, saturation and accumulator extremes."""
    return [np.full(N_FEATURES, 32767), np.full(N_FEATURES, -32768),
            np.array([32767 if i % 2 else -32768 for i in range(N_FEATURES)]), np.zeros(N_FEATURES, dtype=int)]


def weights_v0(seed=2026):
    """Deterministic untrained weights for RTL bring-up: full int16 range, both signs, some saturating logits."""
    rng = np.random.default_rng(seed)
    w_q = rng.integers(-32768, 32768, size=(4, N_FEATURES))
    b_q = rng.integers(-2 ** 30, 2 ** 30, size=4)
    s_out = 20
    return w_q, b_q, s_out
