import json

from django.contrib.auth import get_user_model
from django.test import TestCase

from .models import ConnectionGroup, SavedConnection


class ConnectionGroupTests(TestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user("owner")
        self.other = get_user_model().objects.create_user("other")
        self.client.force_login(self.owner)
        self.payload = {
            "name": "Server",
            "host": "host",
            "username": "root",
            "port": 22,
            "auth_method": "password",
        }

    def send(self, method, path, data):
        return getattr(self.client, method)(path, json.dumps(data), content_type="application/json")

    def test_group_lifecycle(self):
        response = self.send("post", "/api/connection-groups/", {"name": "Production"})
        self.assertEqual(response.status_code, 201)
        pk = response.json()["id"]
        response = self.send("post", "/api/connections/", {**self.payload, "group": pk})
        self.assertEqual(response.status_code, 201)
        connection = SavedConnection.objects.get(pk=response.json()["id"])
        self.assertEqual(connection.group_id, pk)
        self.assertEqual(
            self.send("patch", f"/api/connection-groups/{pk}/", {"name": "New"}).status_code, 200
        )
        self.assertEqual(
            self.client.get("/api/connection-groups/").json()["groups"][0]["name"], "New"
        )
        self.assertEqual(self.client.delete(f"/api/connection-groups/{pk}/").status_code, 200)
        connection.refresh_from_db()
        self.assertIsNone(connection.group_id)

    def test_isolation(self):
        group = ConnectionGroup.objects.create(owner=self.other, name="Private")
        self.assertEqual(self.client.get("/api/connection-groups/").json()["groups"], [])
        self.assertEqual(
            self.send(
                "patch", f"/api/connection-groups/{group.pk}/", {"name": "Stolen"}
            ).status_code,
            404,
        )
        self.assertEqual(self.client.delete(f"/api/connection-groups/{group.pk}/").status_code, 404)
        self.assertEqual(
            self.send("post", "/api/connections/", {**self.payload, "group": group.pk}).status_code,
            400,
        )
        connection = SavedConnection.objects.create(
            owner=self.owner, name="Mine", host="host", username="root"
        )
        self.assertEqual(
            self.send(
                "patch", f"/api/connections/{connection.pk}/", {**self.payload, "group": group.pk}
            ).status_code,
            400,
        )

    def test_names_and_optional_group(self):
        ConnectionGroup.objects.create(owner=self.owner, name="Production")
        for name in ("production", "Другие", "   ", "a" * 81):
            self.assertEqual(
                self.send("post", "/api/connection-groups/", {"name": name}).status_code, 400
            )
        self.assertEqual(self.send("post", "/api/connections/", self.payload).status_code, 201)
        self.assertIsNone(SavedConnection.objects.get().group_id)
        self.client.force_login(self.other)
        self.assertEqual(
            self.send("post", "/api/connection-groups/", {"name": "Production"}).status_code, 201
        )
