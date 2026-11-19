"""Capture the board's UART (USB Serial Port, 115200 8N1) to deploy/uart.log for N seconds.
   python uart_capture.py [seconds] [COMx]"""
import sys, time, os
import serial
from serial.tools import list_ports

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 60
port = sys.argv[2] if len(sys.argv) > 2 else None
ports = list(list_ports.comports())
log = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "uart.log"), "w", buffering=1)
log.write("ports: " + "; ".join(f"{p.device} {p.description} {p.hwid}" for p in ports) + "\n")
if port is None:
    cands = [p.device for p in ports if "0403" in (p.hwid or "") or "Serial" in (p.description or "")]
    port = cands[0] if cands else None
log.write(f"using {port}\n")
if port:
    s = serial.Serial(port, 115200, timeout=0.2)
    t0 = time.time()
    while time.time() - t0 < secs:
        d = s.read(4096)
        if d:
            log.write(d.decode("ascii", "replace"))
    s.close()
log.write("\nUART_DONE\n")
