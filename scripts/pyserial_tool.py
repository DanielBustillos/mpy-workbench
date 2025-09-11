def cmd_mv(port, src, dst):
    """Move or rename a file or folder on the board."""
    code = (
        "import os\n"
        f"src=r\"{src}\"\n"
        f"dst=r\"{dst}\"\n"
        "try:\n os.rename(src, dst); print('OK', end='')\n"
        "except Exception as e:\n print('ERR:'+str(e), end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code, wait_marker=False)
        raw_exit(ser)
    s = out.decode('utf-8', errors='ignore')
    if s.startswith('OK'):
        return True
    else:
        raise Exception(f"Rename failed: {s}")
import argparse
import base64
import io
import json
import os
import sys
import time
import serial
from serial.tools import list_ports

# Default baud rate. Can be overridden by CLI --baud or env MPY_WORKBENCH_BAUD
BAUD = int(os.environ.get("MPY_WORKBENCH_BAUD", "115200"))
BAUD = 115200

def open_ser(port):
    """Open a serial port with a sane timeout.
    Separating this allows us to centralize any future tweaks (e.g., DTR/RTS).
    """
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


def warmup_handshake(ser):
    """Send extra interrupts and soft-resets to stabilize REPL before running code.
    Two Ctrl-C and two Ctrl-D often clear stuck tasks and flush buffers.
    """
    try:
        ser.write(b"\x03\x03")  # two interrupts
        time.sleep(0.12)
        ser.reset_input_buffer()
        ser.write(b"\x04")  # soft reset
        time.sleep(0.15)
        ser.reset_input_buffer()
        ser.write(b"\x04")  # second soft reset
        time.sleep(0.18)
        ser.reset_input_buffer()
    except Exception:
        # Ignore handshake errors; subsequent raw_enter may still succeed
        pass


def raw_exec(ser, code, wait_marker=True):
    """Execute code in raw REPL and collect output.
    Handles transient read errors more gracefully and stops on marker.
    """
    data = code.encode("utf-8") + b"\x04"
    ser.write(data)
    out = b""
    deadline = time.time() + 8.0
    if wait_marker:
        while time.time() < deadline:
            try:
                chunk = ser.read(1024)
            except serial.SerialException as e:
                # Raise a clearer message; upstream will catch and surface nicely
                raise serial.SerialException(
                    f"serial-read-failed: {e}") from e
            if chunk:
                out += chunk
                if b"<thonny>" in out and b"</thonny>" in out:
                    break
            else:
                time.sleep(0.02)
    else:
        time.sleep(0.2)
        try:
            out += ser.read_all()
        except serial.SerialException as e:
            raise serial.SerialException(f"serial-read-failed: {e}") from e
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


def cmd_delete_file(port, filepath):
    """Deletes a file using pyserial"""
    code = (
        "import os\n"
        f"path = r\"{filepath}\"\n"
        f"try:\n"
        f" # Check that file exists before deleting\n"
        f" stat_info = os.stat(path)\n"
        f" # Try to delete\n"
        f" os.remove(path)\n"
        f" # Verify it was deleted\n"
        f" try:\n"
        f"  os.stat(path)\n"
        f"  print('<thonny>error:still_exists</thonny>',end='')\n"
        f" except OSError:\n"
        f"  print('<thonny>deleted</thonny>',end='')\n"
        f"except OSError as e:\n"
        f" errno = getattr(e, 'errno', None) or (e.args[0] if e.args else 'unknown')\n"
        f" print('<thonny>error:OSError_'+str(errno)+'_'+str(e)+'</thonny>',end='')\n"
        f"except Exception as e:\n"
        f" print('<thonny>error:'+type(e).__name__+'_'+str(e)+'</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    
    # Verificar la respuesta
    s = out.decode("utf-8", errors="ignore")
    if "<thonny>error:" in s:
        try:
            error_msg = s.split("<thonny>error:")[1].split("</thonny>")[0]
            print(f"Error deleting file: {error_msg}", file=sys.stderr)
        except:
            print("Unknown error deleting file", file=sys.stderr)


def cmd_delete_folder_recursive(port, folderpath):
    """Deletes folder recursively using pyserial"""
    code = (
        "import os\n"
        "errors = []\n"
        "def delete_recursive(path):\n"
        " try:\n"
        "  items = os.listdir(path)\n"
        "  for item in items:\n"
        "   item_path = path + '/' + item if not path.endswith('/') else path + item\n"
        "   try:\n"
        "    stat_info = os.stat(item_path)\n"
        "    if (stat_info[0] & 0x4000) != 0:\n"
        "     delete_recursive(item_path)\n"
        "     try:\n"
        "      os.rmdir(item_path)\n"
        "     except Exception as e:\n"
        "      errors.append('rmdir:'+item_path+':'+str(e))\n"
        "    else:\n"
        "     try:\n"
        "      os.remove(item_path)\n"
        "     except Exception as e:\n"
        "      errors.append('remove:'+item_path+':'+str(e))\n"
        "   except Exception as e:\n"
        "    errors.append('stat:'+item_path+':'+str(e))\n"
        "  try:\n"
        "   os.rmdir(path)\n"
        "  except Exception as e:\n"
        "   errors.append('rmdir:'+path+':'+str(e))\n"
        " except Exception as e:\n"
        "  errors.append('listdir:'+path+':'+str(e))\n"
        f"delete_recursive(r\"{folderpath}\")\n"
        "if errors:\n"
        " print('<thonny>errors:'+';'.join(errors)+'</thonny>',end='')\n"
        "else:\n"
        " print('<thonny>deleted</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    
    # Verificar la respuesta
    s = out.decode("utf-8", errors="ignore")
    if "<thonny>errors:" in s:
        try:
            error_msg = s.split("<thonny>errors:")[1].split("</thonny>")[0]
            print(f"Errors deleting folder: {error_msg}", file=sys.stderr)
        except:
            print("Unknown errors deleting folder", file=sys.stderr)


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
        warmup_handshake(ser)
        raw_enter(ser)
        out = raw_exec(ser, code, wait_marker=False)
        raw_exit(ser)
    sys.stdout.write(out.decode("utf-8", errors="ignore"))


def cmd_reset(port):
    with open_ser(port) as ser:
        ser.write(b"\x04")
        time.sleep(0.1)


def cmd_file_exists(port, path):
    """Checks if a file or folder exists"""
    code = (
        "import os\n"
        f"path = r\"{path}\"\n"
        f"try:\n"
        f" stat_result = os.stat(path)\n"
        f" print('<thonny>exists</thonny>',end='')\n"
        f"except OSError as e:\n"
        f" # Error 2 means 'No such file or directory'\n"
        f" if hasattr(e, 'errno') and e.errno == 2:\n"
        f"  print('<thonny>not_exists</thonny>',end='')\n"
        f" else:\n"
        f"  print('<thonny>not_exists</thonny>',end='')\n"
        f"except Exception as e:\n"
        f" print('<thonny>not_exists</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    
    s = out.decode("utf-8", errors="ignore")
    try:
        result = s.split("<thonny>")[1].split("</thonny>")[0]
        sys.stdout.write(result.strip())
    except Exception:
        sys.stdout.write("not_exists")


def cmd_file_info(port, path):
    """Gets detailed information about a file or folder"""
    code = (
        "import os\n"
        f"try:\n"
        f" stat = os.stat(r\"{path}\")\n"
        f" mode = stat[0]\n"
        f" size = stat[6] if len(stat) > 6 else 0\n"
        f" is_dir = (mode & 0x4000) != 0\n"
        f" is_readonly = (mode & 0x0080) == 0\n"
        f" print('<thonny>'+str(mode)+'|'+str(size)+'|'+('dir' if is_dir else 'file')+'|'+('ro' if is_readonly else 'rw')+'</thonny>',end='')\n"
        f"except OSError as e:\n"
        f" print('<thonny>error:'+str(e)+'</thonny>',end='')\n"
        f"except Exception as e:\n"
        f" print('<thonny>error:'+str(e)+'</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    
    s = out.decode("utf-8", errors="ignore")
    try:
        result = s.split("<thonny>")[1].split("</thonny>")[0]
        sys.stdout.write(result)
    except Exception:
        sys.stdout.write("error")


def cmd_delete_all_in_path(port, root_path):
    """Deletes all files and folders in a path using improved functions"""
    # Primero obtener lista de archivos
    items_json = cmd_tree_stats_json(port, root_path)
    
    try:
        import json
        items = json.loads(items_json)
    except:
        print("Error: Could not parse file list", file=sys.stderr)
        return
    
    deleted = []
    errors = []
    
    # Separate files and folders
    files = [item for item in items if not item['isDir']]
    dirs = [item for item in items if item['isDir']]
    # Sort folders by depth (deepest first)
    dirs.sort(key=lambda x: x['path'].count('/'), reverse=True)
    
    # Delete files first
    for file_item in files:
        try:
            cmd_delete_file(port, file_item['path'])
            deleted.append(file_item['path'])
        except Exception as e:
            errors.append(f"File {file_item['path']}: {str(e)}")
    
    # Delete folders (from deepest)
    for dir_item in dirs:
        try:
            cmd_delete_folder_recursive(port, dir_item['path'])
            deleted.append(dir_item['path'])
        except Exception as e:
            errors.append(f"Directory {dir_item['path']}: {str(e)}")
    
    # Report results
    result = {
        "deleted": deleted,
        "errors": errors,
        "deleted_count": len(deleted),
        "error_count": len(errors)
    }
    
    try:
        import json
        print(json.dumps(result))
    except:
        print(f"Deleted: {len(deleted)}, Errors: {len(errors)}")

def cmd_wipe_path(port, root):
    """Ultra-fast delete of all children under 'root' in a single raw REPL roundtrip."""
    code = (
        "import os\nDIR=0x4000\n"
        f"root=r\"{root}\"\n"
        "try:\n import ujson as json\nexcept: import json\n"
        "errors=[]\n"
        "deleted=0\n"
        "def isdir(p):\n"
        " try:\n  return (os.stat(p)[0] & DIR)!=0\n"
        " except: return False\n"
        "def rmrf(p):\n"
        " global deleted\n"
        " try:\n"
        "  for n in os.listdir(p):\n"
        "   fp=p+('/' if not p.endswith('/') else '')+n\n"
        "   if isdir(fp):\n"
        "    rmrf(fp)\n"
        "    try:\n"
        "     os.rmdir(fp)\n"
        "     deleted += 1\n"
        "    except Exception as e:\n"
        "     errors.append('rmdir:'+fp+':'+str(e))\n"
        "   else:\n"
        "    try:\n"
        "     os.remove(fp)\n"
        "     deleted += 1\n"
        "    except Exception as e:\n"
        "     errors.append('remove:'+fp+':'+str(e))\n"
        " except Exception as e:\n"
        "  errors.append('list:'+p+':'+str(e))\n"
        "try:\n"
        " for n in os.listdir(root):\n"
        "  fp=root+('/' if not root.endswith('/') else '')+n\n"
        "  if isdir(fp):\n"
        "   rmrf(fp)\n"
        "   try:\n"
        "    os.rmdir(fp)\n"
        "    deleted += 1\n"
        "   except Exception as e:\n"
        "    errors.append('rmdir:'+fp+':'+str(e))\n"
        "  else:\n"
        "   try:\n"
        "    os.remove(fp)\n"
        "    deleted += 1\n"
        "   except Exception as e:\n"
        "    errors.append('remove:'+fp+':'+str(e))\n"
        "except Exception as e:\n"
        " errors.append('list_root:'+root+':'+str(e))\n"
        "print('<thonny>'+json.dumps({'deleted_count':deleted,'error_count':len(errors),'errors':errors})+'</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    s = out.decode("utf-8", errors="ignore")
    try:
        a = s.split("<thonny>")[1].split("</thonny>")[0]
        print(a)
    except Exception:
        print("{\"deleted_count\":0,\"error_count\":1,\"errors\":[\"wipe_failed\"]}")


def cmd_delete_any(port, target):
    """Delete a file or a folder (recursively) in a single roundtrip.
    Prints JSON: { ok: bool, is_dir: bool, deleted: int, errors: [..] }
    """
    code = (
        "import os\nDIR=0x4000\n"
        f"p=r\"{target}\"\n"
        "try:\n import ujson as json\nexcept: import json\n"
        "errors=[]\n"
        "deleted=0\n"
        "def isdir(x):\n"
        " try:\n  return (os.stat(x)[0] & DIR)!=0\n"
        " except: return False\n"
        "def rmrf(x):\n"
        " global deleted\n"
        " try:\n"
        "  for n in os.listdir(x):\n"
        "   fp=x+('/' if not x.endswith('/') else '')+n\n"
        "   if isdir(fp):\n"
        "    rmrf(fp)\n"
        "    try:\n"
        "     os.rmdir(fp); deleted += 1\n"
        "    except Exception as e:\n"
        "     errors.append('rmdir:'+fp+':'+str(e))\n"
        "   else:\n"
        "    try:\n"
        "     os.remove(fp); deleted += 1\n"
        "    except Exception as e:\n"
        "     errors.append('remove:'+fp+':'+str(e))\n"
        " except Exception as e:\n"
        "  errors.append('list:'+x+':'+str(e))\n"
        "isd=isdir(p)\n"
        "if isd:\n"
        " rmrf(p)\n"
        " try:\n"
        "  os.rmdir(p); deleted += 1\n"
        " except Exception as e:\n"
        "  errors.append('rmdir:'+p+':'+str(e))\n"
        "else:\n"
        " try:\n"
        "  os.remove(p); deleted += 1\n"
        " except Exception as e:\n"
        "  errors.append('remove:'+p+':'+str(e))\n"
        "print('<thonny>'+json.dumps({'ok':len(errors)==0,'is_dir':isd,'deleted':deleted,'errors':errors})+'</thonny>',end='')\n"
    )
    with open_ser(port) as ser:
        raw_enter(ser)
        out = raw_exec(ser, code)
        raw_exit(ser)
    s = out.decode("utf-8", errors="ignore")
    try:
        a = s.split("<thonny>")[1].split("</thonny>")[0]
        print(a)
    except Exception:
        print("{\"ok\":false,\"is_dir\":false,\"deleted\":0,\"errors\":[\"delete_any_failed\"]}")


def cmd_tree_stats_json(port, root):
    """Version that returns JSON directly"""
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
        return a
    except Exception:
        return "[]"


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
    # Global optional baud override
    ap.add_argument("--baud", type=int, default=None, help="Baud rate (default: 115200; may be ignored on USB CDC)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devs")

    p_ls = sub.add_parser("ls"); p_ls.add_argument("--port", required=True); p_ls.add_argument("--path", required=True)
    p_lst = sub.add_parser("ls_typed"); p_lst.add_argument("--port", required=True); p_lst.add_argument("--path", required=True)
    p_mkdir = sub.add_parser("mkdir"); p_mkdir.add_argument("--port", required=True); p_mkdir.add_argument("--path", required=True)
    p_rm = sub.add_parser("rm"); p_rm.add_argument("--port", required=True); p_rm.add_argument("--path", required=True)
    p_rmrf = sub.add_parser("rmrf"); p_rmrf.add_argument("--port", required=True); p_rmrf.add_argument("--path", required=True)
    p_del_file = sub.add_parser("delete_file"); p_del_file.add_argument("--port", required=True); p_del_file.add_argument("--path", required=True)
    p_del_folder = sub.add_parser("delete_folder_recursive"); p_del_folder.add_argument("--port", required=True); p_del_folder.add_argument("--path", required=True)
    p_exists = sub.add_parser("file_exists"); p_exists.add_argument("--port", required=True); p_exists.add_argument("--path", required=True)
    p_info = sub.add_parser("file_info"); p_info.add_argument("--port", required=True); p_info.add_argument("--path", required=True)
    p_cpf = sub.add_parser("cp_from"); p_cpf.add_argument("--port", required=True); p_cpf.add_argument("--src", required=True); p_cpf.add_argument("--dst", required=True)
    p_cpt = sub.add_parser("cp_to"); p_cpt.add_argument("--port", required=True); p_cpt.add_argument("--src", required=True); p_cpt.add_argument("--dst", required=True)
    p_upr = sub.add_parser("upload_replacing"); p_upr.add_argument("--port", required=True); p_upr.add_argument("--src", required=True); p_upr.add_argument("--dst", required=True)
    p_run = sub.add_parser("run_file"); p_run.add_argument("--port", required=True); p_run.add_argument("--src", required=True)
    p_res = sub.add_parser("reset"); p_res.add_argument("--port", required=True)
    p_tree = sub.add_parser("tree_stats"); p_tree.add_argument("--port", required=True); p_tree.add_argument("--path", required=True)
    p_delete_all = sub.add_parser("delete_all_in_path"); p_delete_all.add_argument("--port", required=True); p_delete_all.add_argument("--path", required=True)
    p_delete_any = sub.add_parser("delete_any"); p_delete_any.add_argument("--port", required=True); p_delete_any.add_argument("--path", required=True)
    p_wipe = sub.add_parser("wipe_path"); p_wipe.add_argument("--port", required=True); p_wipe.add_argument("--path", required=True)

    p_mv = sub.add_parser("mv"); p_mv.add_argument("--port", required=True); p_mv.add_argument("--src", required=True); p_mv.add_argument("--dst", required=True)

    args = ap.parse_args()
    # Apply global baud override if provided
    if getattr(args, "baud", None):
        global BAUD
        BAUD = int(args.baud)
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
    if args.cmd == "delete_file":
        return cmd_delete_file(args.port, args.path)
    if args.cmd == "delete_folder_recursive":
        return cmd_delete_folder_recursive(args.port, args.path)
    if args.cmd == "file_exists":
        return cmd_file_exists(args.port, args.path)
    if args.cmd == "file_info":
        return cmd_file_info(args.port, args.path)
    if args.cmd == "delete_all_in_path":
        return cmd_delete_all_in_path(args.port, args.path)
    if args.cmd == "delete_any":
        return cmd_delete_any(args.port, args.path)
    if args.cmd == "wipe_path":
        return cmd_wipe_path(args.port, args.path)
    if args.cmd == "mv":
        return cmd_mv(args.port, args.src, args.dst)


def _friendly_os_error(e: OSError) -> str:
    # Map common OS-level issues to concise, user-friendly messages
    msg = str(e)
    eno = getattr(e, 'errno', None)
    if eno == 2 or 'No such file or directory' in msg:
        return "Serial port not found. Select the correct port."
    if eno in (13, 16) or 'Permission denied' in msg or 'Resource busy' in msg:
        return "Serial port busy or permission denied. Close other serial monitors (Arduino, Thonny, miniterm)."
    if 'Device not configured' in msg or 'Input/output error' in msg or 'could not open port' in msg:
        return "Serial device not available. Reconnect the board or check the cable."
    return f"OS error: {msg}"


def _friendly_serial_error(e: Exception) -> str:
    msg = str(e)
    low = msg.lower()
    if 'readiness to read' in low and 'no data' in low:
        return "Serial read returned no data. Device disconnected or port used by another program."
    if 'port is already open' in low:
        return "Port already open. Close other tools using the port."
    if 'could not open port' in low:
        return "Could not open serial port. Check permissions and availability."
    return f"Serial error: {msg}"


if __name__ == "__main__":
    # Top-level guard to avoid long Python tracebacks surfacing in VS Code.
    # Print concise, actionable messages instead. Enable full tracebacks by
    # setting MPY_WORKBENCH_DEBUG=1 in the environment.
    debug = os.environ.get("MPY_WORKBENCH_DEBUG") == "1"
    try:
        main()
    except serial.SerialException as e:
        msg = _friendly_serial_error(e)
        if debug:
            raise
        sys.stderr.write(msg)
        sys.exit(2)
    except FileNotFoundError as e:  # e.g., python can't find device file
        if debug:
            raise
        sys.stderr.write("Serial port not found. Select the correct port.")
        sys.exit(2)
    except PermissionError as e:
        if debug:
            raise
        sys.stderr.write("Permission denied opening serial port. Close other tools and/or adjust permissions.")
        sys.exit(2)
    except OSError as e:
        if debug:
            raise
        sys.stderr.write(_friendly_os_error(e))
        sys.exit(2)
    except Exception as e:
        if debug:
            raise
        # Fallback generic error
        sys.stderr.write(f"Unexpected error: {e}")
        sys.exit(1)
