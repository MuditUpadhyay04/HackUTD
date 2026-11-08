# Listen on UDP 7001 for a few seconds and print the board's STATS counters (no heartbeats sent).
import socket, struct, sys, time
names = ["records_in","results_out","dropped_duplicate","dropped_out_of_order","dropped_unknown","invalid","held",
         "history_resets","data_seq_gaps","bad_packets","alerts_raised","mode","weights_version","engine_busy_cycles",
         "uptime_s","replay_waiting"]
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", 7001)); s.settimeout(1.0)
t0 = time.time(); n_res = 0; last = None
while time.time() - t0 < float(sys.argv[1] if len(sys.argv) > 1 else 4):
    try: b, a = s.recvfrom(2048)
    except socket.timeout: continue
    typ = b[5]
    if typ == 8 and len(b) >= 80: last = dict(zip(names, struct.unpack_from("<16I", b, 16)))
    elif typ == 2: n_res += struct.unpack_from("<H", b, 6)[0]
print("RESULT records seen:", n_res); print("last STATS:", last)
