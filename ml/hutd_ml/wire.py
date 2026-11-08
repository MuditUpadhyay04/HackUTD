"""Wire format v1 from docs/plan/lucas/fpga_hardware_plan.md ("I/O contract").

Every layout here mirrors a table in that plan. If this file and the plan disagree, the plan wins: fix the plan
first (Lucas's call), then this file. All fields are little-endian.
"""
import struct

import numpy as np

MAGIC = 0x46474F45  # bytes 45 4F 47 46 = "EOGF"
VERSION = 1

# packet types (common header byte 5)
T_DATA, T_RESULT, T_ALERT, T_CONFIG, T_CONFIG_ACK, T_WEIGHTS, T_WEIGHTS_ACK, T_STATS, T_HEARTBEAT = range(1, 10)

# UDP ports
PORT_DATA, PORT_RESULT, PORT_ALERT, PORT_CONFIG, PORT_WEIGHTS, PORT_MUL = 7000, 7001, 7002, 7003, 7004, 7777

MAX_FACILITIES = 32
MAX_WELLS = 8
UDP_PAYLOAD = 1472
DATA_PER_PACKET = 30
RESULT_PER_PACKET = 45

HEADER = struct.Struct("<IBBHII")  # magic, version, type, count, seq, aux
assert HEADER.size == 16

# DATA record, 48 B (host -> FPGA, UDP 7000)
DATA_DTYPE = np.dtype([
    ("fac_id", "<u2"), ("reserved0", "<u2"), ("ts_unix", "<u4"), ("present", "<u4"),
    ("inflow", "<i2"),        # 0.5 bpd
    ("level", "<i2"),         # 0.01 %
    ("pump_flow", "<i2"),     # 0.5 bpd
    ("receive_flow", "<i2"),  # 0.5 bpd
    ("discharge", "<i2"),     # 0.1 psi
    ("pipeline", "<i2"),      # 0.1 psi
    ("pump_status", "u1"), ("reserved1", "u1"),
    ("well_status", "<u2"),   # 2 bits per slot, raw 0-3
    ("well_water", "<i2", (MAX_WELLS,)),  # 0.5 bpd
    ("reserved2", "<u4"),
])
assert DATA_DTYPE.itemsize == 48

# `present` bits. NOTE: bit order differs from the DATA field order (bit 4 = discharge, bit 5 = receive flow).
P_INFLOW, P_LEVEL, P_PUMP_STATUS, P_PUMP_FLOW, P_DISCHARGE, P_RECEIVE, P_PIPELINE = range(7)
P_WELL_STATUS0 = 8
P_WELL_WATER0 = 16
# The 7 facility readings in present-bit order. CONFIG lo[]/hi[] use this order (assumption, see ml/README.md).
FACILITY_FIELDS = ["inflow", "level", "pump_status", "pump_flow", "discharge", "receive_flow", "pipeline"]

LSB = {"inflow": 0.5, "level": 0.01, "pump_flow": 0.5, "receive_flow": 0.5, "discharge": 0.1, "pipeline": 0.1,
       "well_water": 0.5}

# Facility CONFIG record, 64 B (host -> FPGA, UDP 7003, header aux = 1)
FAC_CONFIG_DTYPE = np.dtype([
    ("fac_id", "<u2"), ("n_wells", "u1"), ("flags", "u1"),
    ("M_inv_B", "<u4"), ("M_inv_Q", "<u4"), ("M_inv_W", "<u4"), ("M_net", "<u4"),
    ("P0", "<i2"), ("shutdown_lvl", "<u2"), ("warning_lvl", "<u2"), ("reserved", "<u2"),
    ("K_cd", "<u4"),
    ("lo", "<i2", (7,)), ("hi", "<i2", (7,)),
    ("well_lo", "<i2"), ("well_hi", "<i2"),
])
assert FAC_CONFIG_DTYPE.itemsize == 64

# GLOBAL CONFIG record, 32 B (host -> FPGA, UDP 7003, header aux = 0)
GLOBAL_CONFIG_DTYPE = np.dtype([
    ("S", "u1"), ("hold_max", "u1"), ("cd_log2", "u1"), ("persist_K", "u1"),
    ("hb_period_ms", "<u2"), ("hb_timeout_ms", "<u2"),
    ("logit_thr", "<i2", (4,)), ("gap_thr", "<i2"), ("flags", "u1"), ("reserved", "u1", (13,)),
])
assert GLOBAL_CONFIG_DTYPE.itemsize == 32

# RESULT record, 32 B (FPGA -> host, UDP 7001)
RESULT_DTYPE = np.dtype([
    ("fac_id", "<u2"), ("status", "u1"), ("since_reset", "u1"), ("ts_unix", "<u4"), ("reason", "<u4"),
    ("logits", "<i2", (4,)), ("rules", "u1"), ("weights_ver", "u1"),
    ("countdown", "<u2", (3,)),  # p10, p50, p90 minutes; 0xFFFF = not filling or > 45 days
    ("result_no", "<u4"),
])
assert RESULT_DTYPE.itemsize == 32

ST_VALID, ST_HELD, ST_RESERVED, ST_INVALID, ST_DROPPED = range(5)
R_FIELD_HELD, R_GAP_HELD, R_RESET, R_RANGE, R_ENUM, R_SATURATED, R_PUMP_INCONSISTENT, R_WELL_INCONSISTENT, \
    R_DUPLICATE, R_OUT_OF_ORDER, R_UNKNOWN_FACILITY = (1 << i for i in range(11))
RULE_PUMP_FAULT, RULE_SHUT_IN, RULE_AT_SHUTDOWN, RULE_AT_WARNING, RULE_NOT_FILLING = (1 << i for i in range(5))
COUNTDOWN_NONE = 0xFFFF

# ALERT record, 16 B (FPGA -> server, UDP 7002)
ALERT_DTYPE = np.dtype([
    ("fac_id", "<u2"), ("kind", "u1"), ("source", "u1"), ("ts_unix", "<u4"), ("result_no", "<u4"),
    ("rules", "u1"), ("classes", "u1"), ("countdown_p10", "<u2"),
])
assert ALERT_DTYPE.itemsize == 16
A_NIGHT_SHIFT, A_ESTOP, A_CLEARED, A_ACKED = 1, 2, 3, 4

CONFIG_ACK = struct.Struct("<HBBI")   # fac_id (0xFFFF = GLOBAL), status, reserved, acked seq
WEIGHTS_CHUNK = struct.Struct("<IHH")  # offset, length (<= 1024), flags (bit 0 = COMMIT); data follows
WEIGHTS_COMMIT = struct.Struct("<II")  # ASSUMPTION: total length, CRC32 follow the chunk fields on COMMIT
WEIGHTS_ACK = struct.Struct("<IBBH")   # offset, status, active version, reserved
STATS = struct.Struct("<16I")
STATS_FIELDS = ["records_in", "results_out", "dropped_duplicate", "dropped_out_of_order", "dropped_unknown",
                "invalid", "held", "history_resets", "data_seq_gaps", "bad_packets", "alerts_raised", "mode",
                "weights_version", "engine_busy_cycles", "uptime_s", "replay_waiting"]

HEADS = ["pipeline_leak", "pump_degradation", "pump_failure", "facility_shut_in"]


def header(ptype, count, seq, aux=0):
    return HEADER.pack(MAGIC, VERSION, ptype, count, seq, aux)


def parse_header(buf):
    magic, version, ptype, count, seq, aux = HEADER.unpack_from(buf)
    if magic != MAGIC or version != VERSION:
        raise ValueError(f"bad header magic=0x{magic:08X} version={version}")
    return ptype, count, seq, aux


def data_packets(records, seq0=0):
    """Split DATA records (already timestep-major) into UDP payloads of up to 30 records."""
    out = []
    for i, start in enumerate(range(0, len(records), DATA_PER_PACKET)):
        chunk = records[start:start + DATA_PER_PACKET]
        out.append(header(T_DATA, len(chunk), seq0 + i) + chunk.tobytes())
    return out


def records_to_mem(records):
    """$readmemh text: one 64-bit little-endian beat per line (a 48 B DATA record = 6 beats, as stage S0 reads)."""
    raw = records.tobytes()
    lines = []
    for off in range(0, len(raw), 8):
        lines.append(int.from_bytes(raw[off:off + 8], "little").to_bytes(8, "big").hex())
    return "\n".join(lines) + "\n"
