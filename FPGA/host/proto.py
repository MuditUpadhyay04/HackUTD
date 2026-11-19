"""Wire protocol shared by the host web server and the mock board.

All fields big-endian (network order).
  request  (16 B): magic u32 | seq u32 | a i32 | b i32
  response (28 B): magic u32 | seq u32 | status u32 | a i32 | b i32 | p_hi u32 | p_lo u32
"""
import struct

MAGIC = 0x4D554C31  # "MUL1"
DEFAULT_PORT = 7777

REQ = struct.Struct(">IIii")
RSP = struct.Struct(">IIIiiII")
REQ_LEN = REQ.size   # 16
RSP_LEN = RSP.size   # 28

STATUS = {0: "OK", 1: "BAD_LEN", 2: "BAD_MAGIC", 3: "HW_TIMEOUT"}

INT32_MIN, INT32_MAX = -(2**31), 2**31 - 1


def pack_request(seq: int, a: int, b: int) -> bytes:
    return REQ.pack(MAGIC, seq & 0xFFFFFFFF, a, b)


def unpack_request(buf: bytes):
    return REQ.unpack(buf)


def pack_response(seq: int, status: int, a: int, b: int, product: int) -> bytes:
    p = product & 0xFFFFFFFFFFFFFFFF
    return RSP.pack(MAGIC, seq & 0xFFFFFFFF, status, a, b, p >> 32, p & 0xFFFFFFFF)


def unpack_response(buf: bytes) -> dict:
    if len(buf) != RSP_LEN:
        raise ValueError(f"response is {len(buf)} bytes, expected {RSP_LEN}")
    magic, seq, status, a, b, hi, lo = RSP.unpack(buf)
    if magic != MAGIC:
        raise ValueError(f"bad magic 0x{magic:08x}")
    p = (hi << 32) | lo
    if p >= 2**63:
        p -= 2**64
    return {"seq": seq, "status": status, "status_name": STATUS.get(status, "?"),
            "a": a, "b": b, "product": p}
