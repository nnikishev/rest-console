import json
import stat
from types import SimpleNamespace
from unittest.mock import MagicMock

from django.contrib.auth import get_user_model
from django.test import TestCase

from .models import QuickCommand
from .sftp import operate


class QuickCommandTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="commands")
        self.client.force_login(self.user)
        self.payload = {"category": "Диагностика", "name": "Диск", "command": "df -h"}

    def test_create_list_delete(self):
        response = self.client.post(
            "/api/quick-commands/", json.dumps(self.payload), content_type="application/json"
        )
        self.assertEqual(response.status_code, 201)
        pk = response.json()["id"]
        self.assertEqual(
            self.client.get("/api/quick-commands/").json()["commands"][0]["command"], "df -h"
        )
        self.assertEqual(self.client.delete(f"/api/quick-commands/{pk}/").status_code, 200)
        self.assertFalse(QuickCommand.objects.exists())

    def test_isolation(self):
        other = get_user_model().objects.create_user(username="other-command-user")
        command = QuickCommand.objects.create(owner=other, **self.payload)
        self.assertEqual(self.client.get("/api/quick-commands/").json()["commands"], [])
        self.assertEqual(self.client.delete(f"/api/quick-commands/{command.pk}/").status_code, 404)

    def test_reject_control_characters(self):
        for command in ("ls\nwhoami", "ls\x1b[A", "a" * 4097):
            response = self.client.post(
                "/api/quick-commands/",
                json.dumps({**self.payload, "command": command}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 400)

    def test_service_filter(self):
        client = MagicMock()
        sftp = client.open_sftp.return_value.__enter__.return_value
        sftp.listdir_iter.return_value = [
            SimpleNamespace(filename=name, st_mode=mode)
            for name, mode in [
                ("app.service", stat.S_IFREG),
                ("linked.service", stat.S_IFLNK),
                ("a.timer", stat.S_IFREG),
                ("nested.service", stat.S_IFDIR),
                ("bad';.service", stat.S_IFREG),
            ]
        ]
        self.assertEqual(
            operate(client, {"action": "services"})["services"], ["app.service", "linked.service"]
        )
        sftp.listdir_iter.assert_called_once_with("/etc/systemd/system")
