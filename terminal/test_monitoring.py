from unittest import TestCase
from unittest.mock import MagicMock

from .monitoring import parse_snapshot, snapshot

SAMPLE = """__PROC__
cpu  10 0 5 80 5 0 0 0 0 0
cpu0 10 0 5 80
1.50 1.20 0.70 2/100 123
MemTotal: 1000 kB
MemAvailable: 400 kB
SwapTotal: 100 kB
SwapFree: 90 kB
3600.50 1000.00
__DF__
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 1000 200 800 20% /
/dev/sdb1 100 90 10 90% /media/my disk
__BLOCK__
{"blockdevices":[{"name":"sda","type":"disk","size":1024000}]}
"""


class MonitoringTests(TestCase):
    def test_parse_metrics(self):
        data = parse_snapshot(SAMPLE)
        self.assertEqual(data["cpu_total"], 100)
        self.assertEqual(data["cpu_idle"], 85)
        self.assertEqual(data["cpus"], 1)
        self.assertEqual(data["load"], [1.5, 1.2, 0.7])
        self.assertEqual(data["memory"]["MemAvailable"], 409600)
        self.assertEqual(data["filesystems"][1]["mount"], "/media/my disk")
        self.assertEqual(data["blocks"][0]["name"], "sda")

    def test_missing_lsblk_is_nonfatal(self):
        self.assertIsNone(parse_snapshot(SAMPLE.split("__BLOCK__")[0] + "__BLOCK__\n")["blocks"])

    def test_snapshot_closes_exec_channel(self):
        client = MagicMock()
        channel = client.get_transport.return_value.open_session.return_value
        channel.recv_ready.side_effect = [True, False]
        channel.recv.return_value = SAMPLE.encode()
        channel.exit_status_ready.return_value = True
        self.assertEqual(snapshot(client)["cpus"], 1)
        channel.close.assert_called_once()
