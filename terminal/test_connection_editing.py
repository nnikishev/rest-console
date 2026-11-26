import json

from django.contrib.auth import get_user_model
from django.test import TestCase

from .models import SavedConnection


class ConnectionEditingTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("editor")
        self.other = get_user_model().objects.create_user("other")
        self.client.force_login(self.user)
        self.connection = SavedConnection.objects.create(
            owner=self.user,
            name="Old",
            host="host",
            username="root",
            auth_method="key",
            encrypted_key="existing-encrypted-value",
        )
        self.payload = {
            "name": "New",
            "host": "updated-host",
            "port": 2222,
            "username": "deploy",
            "auth_method": "key",
        }

    def update(self, payload):
        return self.client.patch(
            f"/api/connections/{self.connection.pk}/",
            json.dumps(payload),
            content_type="application/json",
        )

    def test_update_in_place_preserves_key(self):
        self.assertEqual(self.update(self.payload).status_code, 200)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.name, "New")
        self.assertEqual(self.connection.port, 2222)
        self.assertEqual(self.connection.encrypted_key, "existing-encrypted-value")
        self.assertEqual(SavedConnection.objects.count(), 1)

    def test_remove_key_or_switch_to_password(self):
        self.assertEqual(self.update({**self.payload, "remove_key": True}).status_code, 200)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.encrypted_key, "")
        self.connection.encrypted_key = "existing"
        self.connection.save()
        self.assertEqual(self.update({**self.payload, "auth_method": "password"}).status_code, 200)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.encrypted_key, "")

    def test_isolation_and_validation(self):
        self.client.force_login(self.other)
        self.assertEqual(self.update(self.payload).status_code, 404)
        self.client.force_login(self.user)
        self.assertEqual(self.update({**self.payload, "port": 0}).status_code, 400)
        self.assertEqual(self.update([]).status_code, 400)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.host, "host")
