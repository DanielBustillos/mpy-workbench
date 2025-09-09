import sys
try:
    import serial
    from serial.tools import list_ports
except ImportError:
    print("missing:pyserial")
    sys.exit(1)
print("ok")
