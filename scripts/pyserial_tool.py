import argparse
import base64
import io
import json
import os
import sys
import time
import serial
from serial.tools import list_ports

BAUD = 115200


def open_ser(port):
    return serial.Serial(port, BAUD, timeout=2)


def raw_enter(ser):
    ser.write(b"\x03")
    time.sleep(0.08)
    ser.write(b"\x01")
    time.sleep(0.08)
    ser.reset_input_buffer()


def raw_exit(ser):
    ser.write(b"\x02")
    time.sleep(0.05)


def raw_exec(ser, code, wait_marker=True):
    data = code.encode("utf-8") + b"\x04"
    ser.write(data)
    out = b""
    deadline = time.time() + 8.0
    if wait_marker:
        while time.time() < deadline:
            chunk = ser.read(1024)
            if chunk:
                out += chunk
                if b"<thonny>" in out and b"</thonny>" in out:
                    break
            else:
                time.sleep(0.02)
    else:
        time.sleep(0.2)
        out += ser.read_all()
    return out


def cmd_devs():
    ports = [p.device for p in list_ports.comports()]
    sys.stdout.write("\n".join(ports))


def cmd_ls(port, path):
    code = (
        "import os\n"
        f"p=r\"{path}\"\n"
        "sep='' if p.endswith('/') else '/'\n"
        "try:\n"
        " import ujson as json\n"
        "except: import json\n"
        "try:\n"
        " out=os.listdir(p)\n"
        " print('<thonny>'+json.dumps(out)+'</thonny>',end='')\n"
        "except Exception as e:\n"
        " print('<thonny>[]</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    s = out.decode("utf-8", errors="ignore")
    try:
        a = s.split("<thonny>")[1].split("</thonny>")[0]
        j = json.loads(a)
        sys.stdout.write("\n".join(j))
    except Exception:
        sys.stdout.write("")


def cmd_ls_typed(port, path):
    code = (
        "import os\n"
        "DIR=0x4000\n"
        f"p=r\"{path}\"\n"
        "sep='' if p.endswith('/') else '/'\n"
        "try:\n import ujson as json\nexcept: import json\n"
        "out=[]\n"
        "try:\n"
        " for n in os.listdir(p):\n"
        "  isdir=False\n"
        "  try:\n"
        "   st=os.stat(p+sep+n)[0]; isdir=(st & DIR)!=0\n"
        "  except: pass\n"
        "  out.append({'name':n,'isDir':isdir})\n"
        " print('<thonny>'+json.dumps(out)+'</thonny>',end='')\n"
        "except Exception as e:\n"
        " print('<thonny>[]</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    s = out.decode("utf-8", errors="ignore")
    try:
        a = s.split("<thonny>")[1].split("</thonny>")[0]
        sys.stdout.write(a)
    except Exception:
        sys.stdout.write("[]")


def cmd_mkdir(port, path):
    code = f"import os\ntry:\n os.mkdir(r\"{path}\")\nexcept Exception: pass\nprint('<thonny>ok</thonny>',end='')\n"
    with open_ser(port) as ser:
        raw_enter(ser)
        raw_exec(ser, code)
        raw_exit(ser)


def cmd_rm(port, path):
    code = f"import os\ntry:\n os.remove(r\"{path}\")\nexcept Exception: pass\nprint('<thonny>ok</thonny>',end='')\n"
    with open_ser(port) as ser:
        raw_enter(ser)
        raw_exec(ser, code)
        raw_exit(ser)


def cmd_rmrf(port, path):
    code = (
        "import os\nDIR=0x4000\n"
        "def isdir(p):\n"
        " try:\n"
        "  return (os.stat(p)[0] & DIR)!=0\n"
        " except: return False\n"
        "def rmrf(p):\n"
        " try:\n"
        "  for n in os.listdir(p):\n"
        "   fp=p+('/' if not p.endswith('/') else '')+n\n"
        "   if isdir(fp):\n"
        "    rmrf(fp)\n"
        "    try:\n os.rmdir(fp)\n    except: pass\n"
        "   else:\n"
        "    try:\n os.remove(fp)\n    except: pass\n"
        " except: pass\n"
        f"rmrf(r\"{path}\")\n"
        "print('<thonny>ok</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        raw_exec(ser, code)
        raw_exit(ser)


def cmd_cp_from(port, src, dst):
    code = (
        "import ubinascii as b64, os\n"
        f"p=r\"{src}\"\n"
        "try:\n f=open(p,'rb'); d=f.read(); f.close();\n s=b64.b2a_base64(d).decode()\n print('<thonny>'+s+'</thonny>',end='')\n"
        "except Exception as e:\n print('<thonny></thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    s = out.decode("utf-8", errors="ignore")
    try:
        b = s.split("<thonny>")[1].split("</thonny>")[0]
        data = base64.b64decode(b or "")
        with open(dst, "wb") as f:
            f.write(data)
    except Exception:
        pass


def cmd_cp_to(port, src, dst):
    with open(src, "rb") as f:
        data = f.read()
    b = base64.b64encode(data).decode()
    # ensure dir exists + write
    code = (
        "import os,ubinascii as b64\n"
        f"dst=r\"{dst}\"\n"
        "d=dst[:dst.rfind('/') or 1]\n"
        "pp='/' if d=='/' else ''\n"
        "parts=[x for x in d.split('/') if x]\n"
        "for p in parts:\n"
        " pp=(pp+p) if pp.endswith('/') else (pp+'/'+p) if pp else ('/'+p)\n"
        " try:\n  os.mkdir(pp)\n except: pass\n"
        f"data=b64.a2b_base64(r'''{b}''')\n"
        "f=open(dst,'wb'); f.write(data); f.close()\n"
        "print('<thonny>ok</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        raw_exec(ser, code)
        raw_exit(ser)


def cmd_upload_replacing(port, src, dst):
    tmp = dst + ".new"
    cmd_cp_to(port, src, tmp)
    code = (
        "import os\n"
        f"tmp=r\"{tmp}\"; dst=r\"{dst}\"\n"
        "try:\n os.remove(dst)\nexcept: pass\n"
        "try:\n os.rename(tmp,dst)\nexcept: pass\n"
        "print('<thonny>ok</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        raw_exec(ser, code)
        raw_exit(ser)


def cmd_run_file(port, src):
    with open(src, "r", encoding="utf-8") as f:
        code = f.read()
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code, wait_marker=False)
        raw_exit(ser)
    sys.stdout.write(out.decode("utf-8", errors="ignore"))


def cmd_reset(port):
    with open_ser(port) as ser:
        ser.write(b"\x04")
        time.sleep(0.1)


def cmd_tree_stats(port, root):
    code = (
        "import os\nDIR=0x4000\n"
        f"root=r\"{root}\"\n"
        "try:\n import ujson as json\nexcept: import json\n"
        "out=[]\n"
        "def isdir(p):\n"
        " try:\n  return (os.stat(p)[0] & DIR)!=0\n"
        " except: return False\n"
        "def walk(p):\n"
        " try:\n  for n in os.listdir(p):\n   fp=p+('/' if not p.endswith('/') else '')+n\n   try:\n    st=os.stat(fp)\n    mode=st[0]; size=st[6] if len(st)>6 else 0; mtime=st[8] if len(st)>8 else 0\n    d=(mode & DIR)!=0\n    out.append({'path':fp,'isDir':d,'size':size,'mtime':mtime})\n    if d: walk(fp)\n   except: pass\n except: pass\n"
        "walk(root)\n"
        "print('<thonny>'+json.dumps(out)+'</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    s = out.decode("utf-8", errors="ignore")
    try:
        a = s.split("<thonny>")[1].split("</thonny>")[0]
        sys.stdout.write(a)
    except Exception:
        sys.stdout.write("[]")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devs")

    p_ls = sub.add_parser("ls"); p_ls.add_argument("--port", required=True); p_ls.add_argument("--path", required=True)
    p_lst = sub.add_parser("ls_typed"); p_lst.add_argument("--port", required=True); p_lst.add_argument("--path", required=True)
    p_mkdir = sub.add_parser("mkdir"); p_mkdir.add_argument("--port", required=True); p_mkdir.add_argument("--path", required=True)
    p_rm = sub.add_parser("rm"); p_rm.add_argument("--port", required=True); p_rm.add_argument("--path", required=True)
    p_rmrf = sub.add_parser("rmrf"); p_rmrf.add_argument("--port", required=True); p_rmrf.add_argument("--path", required=True)
    p_cpf = sub.add_parser("cp_from"); p_cpf.add_argument("--port", required=True); p_cpf.add_argument("--src", required=True); p_cpf.add_argument("--dst", required=True)
    p_cpt = sub.add_parser("cp_to"); p_cpt.add_argument("--port", required=True); p_cpt.add_argument("--src", required=True); p_cpt.add_argument("--dst", required=True)
    p_upr = sub.add_parser("upload_replacing"); p_upr.add_argument("--port", required=True); p_upr.add_argument("--src", required=True); p_upr.add_argument("--dst", required=True)
    p_run = sub.add_parser("run_file"); p_run.add_argument("--port", required=True); p_run.add_argument("--src", required=True)
    p_res = sub.add_parser("reset"); p_res.add_argument("--port", required=True)
    p_tree = sub.add_parser("tree_stats"); p_tree.add_argument("--port", required=True); p_tree.add_argument("--path", required=True)

    args = ap.parse_args()
    if args.cmd == "devs":
        return cmd_devs()
    if args.cmd == "ls":
        return cmd_ls(args.port, args.path)
    if args.cmd == "ls_typed":
        return cmd_ls_typed(args.port, args.path)
    if args.cmd == "mkdir":
        return cmd_mkdir(args.port, args.path)
    if args.cmd == "rm":
        return cmd_rm(args.port, args.path)
    if args.cmd == "rmrf":
        return cmd_rmrf(args.port, args.path)
    if args.cmd == "cp_from":
        return cmd_cp_from(args.port, args.src, args.dst)
    if args.cmd == "cp_to":
        return cmd_cp_to(args.port, args.src, args.dst)
    if args.cmd == "upload_replacing":
        return cmd_upload_replacing(args.port, args.src, args.dst)
    if args.cmd == "run_file":
        return cmd_run_file(args.port, args.src)
    if args.cmd == "reset":
        return cmd_reset(args.port)
    if args.cmd == "tree_stats":
        return cmd_tree_stats(args.port, args.path)


if __name__ == "__main__":
    main()

