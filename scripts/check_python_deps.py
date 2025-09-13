import sys
import subprocess

try:
    # Check if mpremote command is available
    result = subprocess.run(['mpremote', '--version'],
                          capture_output=True,
                          text=True,
                          timeout=5)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, 'mpremote')
except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
    print("missing:mpremote")
    sys.exit(1)
print("ok")
