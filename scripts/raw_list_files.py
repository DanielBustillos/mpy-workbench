import serial
import ast
import time
import argparse
import json

LISTDIR_SCRIPT_TEMPLATE = r"""
import builtins
try:
    import uos as os
except ImportError:
    import os
def listdir(x):
    if hasattr(os, "listdir"):
        return os.listdir(x)
    else:
        return [rec[0] for rec in os.ilistdir(x) if rec[0] not in ('.', '..')]
DIRBIT = 0x4000
root = r"{PATH}"
result = []
try:
    names = listdir(root)
except OSError:
    print("<end_char>[]</end_char>", end='')
else:
    for name in names:
        if not name.startswith('.'):
            full = (root.rstrip('/') + '/' + name) if root != '/' else '/' + name
            try:
                st = os.stat(full)
                isdir = (st[0] & DIRBIT) != 0 if isinstance(st, tuple) else False
            except OSError:
                isdir = False
            result.append({"name": name, "isDir": isdir})
    import ujson as json
    print("<end_char>" + json.dumps(result) + "</end_char>", end='')
"""


def enter_raw_repl(ser):
    ser.write(b'\x03')  # Ctrl-C
    time.sleep(0.1)
    ser.write(b'\x01')  # Ctrl-A (raw REPL)
    time.sleep(0.1)
    ser.reset_input_buffer()


def exit_raw_repl(ser):
    ser.write(b'\x02')  # Ctrl-B (friendly REPL)
    time.sleep(0.1)


def exec_script(ser, script):
    ser.write(script.encode("utf-8") + b'\x04')  # EOT
    output = b""
    deadline = time.time() + 5.0
    while time.time() < deadline:
        chunk = ser.read(1024)
        if chunk:
            output += chunk
            if b"<end_char>" in output and b"</end_char>" in output:
                break
        else:
            time.sleep(0.02)
    return output


def parse_result(output):
    start = output.find(b"<end_char>")
    end = output.find(b"</end_char>")
    if start == -1 or end == -1:
        return []
    start += len(b"<end_char>")
    data = output[start:end].decode("utf-8")
    try:
        return json.loads(data)
    except Exception:
        try:
            return ast.literal_eval(data)
        except Exception:
            return []


def list_dir(port, baudrate, path):
    with serial.Serial(port, baudrate, timeout=2) as ser:
        enter_raw_repl(ser)
        script = LISTDIR_SCRIPT_TEMPLATE.replace("{PATH}", path)
        output = exec_script(ser, script)
        exit_raw_repl(ser)
        result = parse_result(output)
        return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', required=True)
    ap.add_argument('--baudrate', type=int, default=115200)
    ap.add_argument('--path', default='/')
    args = ap.parse_args()
    res = list_dir(args.port, args.baudrate, args.path)
    print(json.dumps(res))


if __name__ == '__main__':
    main()

