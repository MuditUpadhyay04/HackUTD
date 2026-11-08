"""make_weights_sd.py — wrap a weight blob as weights.eog, the default model on the board's microSD card.

    python FPGA/deploy/make_weights_sd.py --blob ml/artifacts/v3/weights.bin --version 3 --out weights.eog
    python FPGA/deploy/make_weights_sd.py --check weights.eog          (verify an existing file, print its fields)

Format (FPGA/docs/SD_BOOT_WEIGHTS.md): a 16-byte header, then the blob byte for byte as model_int.pack_blob made it.
  0 u32 LE magic 0x57474F45 ("EOGW") | 4 u8 weights_ver (1-255) | 5 u8 wrapper format = 1 | 6 u16 LE blob length
  (<= 1,024) | 8 u32 LE CRC32 (zlib / IEEE) over the blob | 12 u32 reserved = 0 | 16 the blob
Before writing it checks what the board checks at boot (eog_proto.c eog_boot_load_weights): the blob header
(blob_format 1, n_heads 4, n_features 31, feature_set_id 1), the length (280 B + 70 B per self-test vector, <= 1,024),
and the self-test vectors, recomputed here in plain Python with the same integer arithmetic as the board. If Mudit's
hutd_ml is importable (--ml, $EOG_ML, or the default checkout path) model_int.self_test must pass as well.
"""
import argparse
import os
import struct
import sys
import zlib
from pathlib import Path

MAGIC = 0x57474F45
WRAPPER_FORMAT = 1
HDR = struct.Struct("<IBBHII")
HDR_LEN = 16
MAX_BLOB = 1024
BLOB_HDR_LEN = 280
VEC_LEN = 70
DEFAULT_ML = "C:/Users/gurne/Documents/Lucas HackUTD/HackUTD/ml/ml"


class WeightsError(ValueError):
    pass


def crc32(b):
    return zlib.crc32(b) & 0xFFFFFFFF


def _sat16(v):
    return max(-32768, min(32767, v))


def check_blob(blob):
    """The board's checks on a blob (eog_proto.c blob_validate). Returns the number of self-test vectors."""
    if len(blob) < BLOB_HDR_LEN or len(blob) > MAX_BLOB:
        raise WeightsError(f"blob is {len(blob)} B; must be 280..{MAX_BLOB} B")
    fmt, nh, nf, s_out, nv, fsid = struct.unpack_from("<HBBBBH", blob)
    if (fmt, nh, nf, fsid) != (1, 4, 31, 1):
        raise WeightsError(f"bad blob header: format {fmt}, heads {nh}, features {nf}, feature set {fsid} "
                           "(expected 1, 4, 31, 1)")
    if len(blob) < BLOB_HDR_LEN + VEC_LEN * nv:
        raise WeightsError(f"blob is {len(blob)} B but holds {nv} self-test vectors ({BLOB_HDR_LEN + VEC_LEN * nv} B)")
    if len(blob) != BLOB_HDR_LEN + VEC_LEN * nv:
        print(f"note: {len(blob) - BLOB_HDR_LEN - VEC_LEN * nv} B after the self-test vectors (ignored by the board)")
    w = struct.unpack_from("<124h", blob, 8)
    b = struct.unpack_from("<4i", blob, 256)
    for v in range(nv):
        off = BLOB_HDR_LEN + VEC_LEN * v
        x = struct.unpack_from("<31h", blob, off)
        exp = struct.unpack_from("<4h", blob, off + 62)
        for k in range(4):
            acc = sum(w[31 * k + i] * x[i] for i in range(31)) + b[k]
            if s_out > 0:
                acc += 1 << (s_out - 1)
            got = _sat16(acc >> s_out)  # Python >> on ints is the floor shift the board uses
            if got != exp[k]:
                raise WeightsError(f"self-test vector {v} head {k}: computed {got}, blob expects {exp[k]}")
    return nv


def wrap(blob, version):
    if not 1 <= version <= 255:
        raise WeightsError(f"version {version}: must be 1..255 (0 = no model, rejected by the board)")
    check_blob(blob)
    return HDR.pack(MAGIC, version, WRAPPER_FORMAT, len(blob), crc32(blob), 0) + bytes(blob)


def unwrap(data):
    """Check a weights.eog in the board's order. Returns (version, blob)."""
    if len(data) < HDR_LEN:
        raise WeightsError(f"file is {len(data)} B, shorter than the 16-byte header")
    magic, ver, fmt, n, crc, _ = HDR.unpack_from(data)
    if magic != MAGIC:
        raise WeightsError(f"bad magic 0x{magic:08X}")
    if fmt != WRAPPER_FORMAT:
        raise WeightsError(f"bad wrapper format {fmt}")
    if ver == 0:
        raise WeightsError("version 0")
    if n > MAX_BLOB or len(data) != HDR_LEN + n:
        raise WeightsError(f"length mismatch: header says {n} B, file has {len(data) - HDR_LEN} B after the header")
    blob = data[HDR_LEN:]
    if crc32(blob) != crc:
        raise WeightsError(f"CRC mismatch: header 0x{crc:08X}, blob 0x{crc32(blob):08X}")
    check_blob(blob)
    return ver, bytes(blob)


def ml_self_test(blob, ml_dir):
    """Mudit's model_int.self_test, if hutd_ml can be imported. Returns True/False, or None if unavailable."""
    if not ml_dir or not (Path(ml_dir) / "hutd_ml" / "model_int.py").exists():
        return None
    if str(ml_dir) not in sys.path:
        sys.path.insert(0, str(ml_dir))
    try:
        try:
            import pandas  # noqa: F401  (features_int -> encode imports it; not used here)
        except ImportError:
            import types
            sys.modules["pandas"] = types.ModuleType("pandas")
        from hutd_ml import model_int
    except Exception as e:  # numpy missing, etc.
        print(f"note: hutd_ml not importable from {ml_dir} ({e!r}); skipping model_int.self_test")
        return None
    return bool(model_int.self_test(blob))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--blob", help="weight blob from model_int.pack_blob (e.g. ml/artifacts/v3/weights.bin)")
    ap.add_argument("--version", type=int, help="weights_ver, 1..255; same sequence as pushed blobs (#50)")
    ap.add_argument("--out", help="output file (copy it to the card's root as weights.eog)")
    ap.add_argument("--check", metavar="FILE", help="verify an existing weights.eog instead")
    ap.add_argument("--ml", default=None, help="folder containing hutd_ml (default: $EOG_ML or Mudit's checkout)")
    a = ap.parse_args(argv)
    ml_dir = a.ml or os.environ.get("EOG_ML") or DEFAULT_ML
    try:
        if a.check:
            data = Path(a.check).read_bytes()
            ver, blob = unwrap(data)
        else:
            if not (a.blob and a.version is not None and a.out):
                ap.error("--blob, --version and --out are required (or --check FILE)")
            blob = Path(a.blob).read_bytes()
            data = wrap(blob, a.version)
            ver = a.version
            unwrap(data)  # round trip
        st = ml_self_test(blob, ml_dir)
        if st is False:
            raise WeightsError("hutd_ml model_int.self_test failed")
    except (WeightsError, OSError) as e:
        print(f"make_weights_sd: FAIL: {e}", file=sys.stderr)
        return 1
    if not a.check:
        Path(a.out).write_bytes(data)
    nv = blob[5]
    print(f"{a.check or a.out}: weights.eog v{ver}, {len(data)} B (16 B header + {len(blob)} B blob, {nv} self-test "
          f"vectors), CRC32 0x{crc32(blob):08X}, header checks OK, self-test OK"
          + ("" if st is None else ", hutd_ml model_int.self_test OK"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
