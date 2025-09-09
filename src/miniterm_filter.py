import sys
import subprocess
import threading
import re
import os

def filter_line(line):
    # Oculta mensajes de raw REPL, CTRL-B, Thonny, etc.
    patterns = [
        r"raw REPL; CTRL-B to exit",
        r"^>+$",
        r"<thonny>ok</thonny>",
        r"^MicroPython v[0-9.]+ on ",
        r"^Type \"help\(\)\" for more information\."
    ]
    for pat in patterns:
        if re.search(pat, line):
            return False
    return True

def handle_input(proc):
    try:
        while True:
            data = sys.stdin.read(1)
            if not data:
                break
            proc.stdin.write(data.encode())
            proc.stdin.flush()
    except:
        pass

def main():
    if len(sys.argv) < 3:
        print("Usage: miniterm_filter.py <device> <baudrate>", file=sys.stderr)
        sys.exit(1)
    device = sys.argv[1]
    baud = sys.argv[2]
    
    # Usar miniterm directamente sin filtro para mantener interactividad
    os.execvp(sys.executable, [sys.executable, "-m", "serial.tools.miniterm", device, baud])

if __name__ == "__main__":
    main()