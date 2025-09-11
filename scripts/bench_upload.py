#!/usr/bin/env python3
"""
Benchmark upload time to a MicroPython board using:
  1) This repo's pyserial uploader (scripts/pyserial_tool.py)
  2) rshell cp to /pyboard

Usage examples:
  python3 scripts/bench_upload.py --port /dev/tty.usbserial-XXXX \
    --src /path/to/file.py --dst /bench_benchmark.dat --repeats 5

  # Only one method
  python3 scripts/bench_upload.py --port COM7 --src big.bin --method pyserial

Notes:
  - Requires rshell installed and on PATH for the rshell method.
  - The pyserial method uses this repo's scripts/pyserial_tool.py with upload_replacing.
  - Destination path for rshell is mapped to /pyboard<dst> automatically.
"""

from __future__ import annotations

import argparse
import os
import shutil
import statistics
import subprocess
import sys
import time
from typing import List, Tuple


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYSERIAL_TOOL = os.path.join(ROOT, "scripts", "pyserial_tool.py")


def human_bytes(n: float) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024.0:
            return f"{n:0.1f} {unit}"
        n /= 1024.0
    return f"{n:0.1f} TB"


def run_cmd(cmd: List[str]) -> Tuple[int, str, str]:
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate()
    return p.returncode, out, err


def upload_pyserial(port: str, src: str, dst: str) -> Tuple[float, str]:
    start = time.perf_counter()
    code, out, err = run_cmd([sys.executable, PYSERIAL_TOOL, "upload_replacing", "--port", port, "--src", src, "--dst", dst])
    dur = time.perf_counter() - start
    if code != 0:
        raise RuntimeError(f"pyserial upload failed: {err.strip() or out.strip()}")
    return dur, out.strip() or err.strip()


def upload_rshell(port: str, baud: int, src: str, dst: str) -> Tuple[float, str]:
    rshell = shutil.which("rshell")
    if not rshell:
        raise RuntimeError("rshell not found on PATH. Install it: pip install rshell")

    # Map device path to rshell /pyboard namespace
    # e.g., dst "/bench.dat" -> "/pyboard/bench.dat"
    mapped_dst = "/pyboard" + (dst if dst.startswith("/") else f"/{dst}")
    start = time.perf_counter()
    code, out, err = run_cmd([rshell, "-p", port, "-b", str(baud), "cp", src, mapped_dst])
    dur = time.perf_counter() - start
    if code != 0:
        raise RuntimeError(f"rshell upload failed: {err.strip() or out.strip()}")
    return dur, out.strip() or err.strip()


def main():
    ap = argparse.ArgumentParser(description="Benchmark uploads via pyserial_tool.py vs rshell")
    ap.add_argument("--port", required=True, help="Serial port (e.g., /dev/tty.usbserial-xxxx or COM7)")
    ap.add_argument("--src", required=True, help="Local file to upload")
    ap.add_argument("--dst", default="/bench_upload.dat", help="Destination path on device (default: /bench_upload.dat)")
    ap.add_argument("--repeats", type=int, default=3, help="Number of runs per method (default: 3)")
    ap.add_argument("--baud", type=int, default=115200, help="Baud for rshell (default: 115200)")
    ap.add_argument("--method", choices=["both", "pyserial", "rshell"], default="both", help="Which method(s) to test")
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        print(f"Source file not found: {args.src}", file=sys.stderr)
        sys.exit(2)
    size = os.path.getsize(args.src)

    methods = []
    if args.method in ("both", "pyserial"):
        methods.append(("pyserial", lambda: upload_pyserial(args.port, args.src, args.dst)))
    if args.method in ("both", "rshell"):
        methods.append(("rshell", lambda: upload_rshell(args.port, args.baud, args.src, args.dst)))

    print(f"Benchmarking upload of {args.src} -> {args.dst} ({human_bytes(size)})")
    print(f"Port: {args.port}  Repeats: {args.repeats}\n")

    for name, fn in methods:
        times: List[float] = []
        print(f"== {name} ==")
        for i in range(1, args.repeats + 1):
            try:
                dur, _ = fn()
                times.append(dur)
                throughput = size / dur if dur > 0 else 0.0
                print(f"  run {i}: {dur:0.3f}s  ({human_bytes(throughput)}/s)")
            except Exception as e:
                print(f"  run {i}: ERROR: {e}")
        if times:
            avg = statistics.mean(times)
            p50 = statistics.median(times)
            p95 = sorted(times)[max(0, int(len(times)*0.95)-1)]
            th_avg = size / avg if avg > 0 else 0.0
            print(f"  avg: {avg:0.3f}s  median: {p50:0.3f}s  p95: {p95:0.3f}s  (~{human_bytes(th_avg)}/s)\n")
        else:
            print("  no successful runs\n")


if __name__ == "__main__":
    main()

