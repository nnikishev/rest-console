import json
import time

# Fixed commands only; paths and shell fragments are never supplied by the browser.
COMMAND = "LC_ALL=C; export LC_ALL; printf '__PROC__\\n'; cat /proc/stat /proc/loadavg /proc/meminfo /proc/uptime; printf '__DF__\\n'; df -P -k -l 2>/dev/null; printf '__BLOCK__\\n'; lsblk -J -b -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,RO 2>/dev/null"


def parse_snapshot(output):
    proc, rest = output.split("__DF__\n", 1)
    disk_text, block_text = rest.split("__BLOCK__\n", 1)
    lines = proc.splitlines()
    cpu = next(line for line in lines if line.startswith("cpu ")).split()[1:]
    ticks = [int(value) for value in cpu[:8]]
    memory = {}
    for line in lines:
        if line.startswith(
            (
                "MemTotal:",
                "MemAvailable:",
                "MemFree:",
                "Buffers:",
                "Cached:",
                "SwapTotal:",
                "SwapFree:",
            )
        ):
            key, value, *_ = line.split()
            memory[key.rstrip(":")] = int(value) * 1024
    load = next(line for line in lines if len(line.split()) == 5 and "/" in line.split()[3]).split()
    uptime = lines[-1].split()[0]
    filesystems = []
    for line in disk_text.splitlines()[1:]:
        fields = line.split(None, 5)
        if len(fields) == 6:
            device, total, used, available, percent, mount = fields
            try:
                filesystems.append(
                    {
                        "device": device,
                        "total": int(total) * 1024,
                        "used": int(used) * 1024,
                        "available": int(available) * 1024,
                        "percent": int(percent.rstrip("%")),
                        "mount": mount,
                    }
                )
            except ValueError:
                continue
    try:
        blocks = json.loads(block_text).get("blockdevices", [])
    except (ValueError, AttributeError):
        blocks = None
    return {
        "cpu_total": sum(ticks),
        "cpu_idle": ticks[3] + (ticks[4] if len(ticks) > 4 else 0),
        "cpus": sum(1 for line in lines if line.startswith("cpu") and line[3:4].isdigit()),
        "load": [float(value) for value in load[:3]],
        "uptime": float(uptime),
        "memory": memory,
        "filesystems": filesystems,
        "blocks": blocks,
    }


def snapshot(client):
    transport = client.get_transport()
    channel = transport.open_session(timeout=5)
    try:
        channel.settimeout(5)
        channel.exec_command(COMMAND)
        deadline = time.monotonic() + 8
        output = bytearray()
        while True:
            if time.monotonic() > deadline:
                raise ValueError("Тайм-аут мониторинга.")
            if channel.recv_ready():
                output.extend(channel.recv(32768))
                if len(output) > 512 * 1024:
                    raise ValueError("Слишком большой ответ мониторинга.")
            elif channel.exit_status_ready():
                break
            else:
                time.sleep(0.02)
        return parse_snapshot(output.decode("utf-8", errors="replace"))
    finally:
        channel.close()
