import json

from asgiref.sync import async_to_sync
from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from .consumers import TerminalConsumer
from .key_storage import decrypt_key
from .models import SavedConnection


@override_settings(SSH_KEY_ENCRYPTION_KEY=Fernet.generate_key().decode())
class SavedKeyTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="key-owner")
        self.client.force_login(self.user)
        self.key = "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----"
        self.data = {
            "name": "Key",
            "host": "localhost",
            "port": 22,
            "username": "deploy",
            "auth_method": "key",
            "save_key": True,
            "key": self.key,
        }

    def save_key(self):
        return self.client.post(
            "/api/connections/", json.dumps(self.data), content_type="application/json"
        )

    def test_encrypted_storage_and_no_disclosure(self):
        response = self.save_key()
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.json()["has_key"])
        connection = SavedConnection.objects.get()
        self.assertNotIn(self.key, connection.encrypted_key)
        self.assertEqual(decrypt_key(connection.encrypted_key), self.key)
        listing = self.client.get("/api/connections/").json()["connections"][0]
        self.assertNotIn("key", listing)
        self.assertNotIn("encrypted_key", listing)

    @override_settings(SSH_KEY_ENCRYPTION_KEY="")
    def test_requires_encryption_configuration(self):
        self.assertEqual(self.save_key().status_code, 400)
        self.assertFalse(SavedConnection.objects.exists())

    def test_key_is_not_saved_without_consent(self):
        self.data["save_key"] = False
        self.assertEqual(self.save_key().status_code, 201)
        self.assertEqual(SavedConnection.objects.get().encrypted_key, "")

    def test_saved_key_access_is_owner_only(self):
        self.save_key()
        connection = SavedConnection.objects.get()
        consumer = TerminalConsumer()
        consumer.scope = {"user": self.user}
        saved, key = async_to_sync(consumer.saved_key)(connection.pk)
        self.assertEqual(saved.pk, connection.pk)
        self.assertEqual(key, self.key)
        other = get_user_model().objects.create_user(username="other-key-user")
        consumer.scope = {"user": other}
        with self.assertRaisesMessage(ValueError, "Закладка недоступна"):
            async_to_sync(consumer.saved_key)(connection.pk)

    def test_wrong_encryption_secret_fails_closed(self):
        self.save_key()
        with override_settings(SSH_KEY_ENCRYPTION_KEY=Fernet.generate_key().decode()):
            with self.assertRaisesMessage(ValueError, "Не удалось расшифровать"):
                decrypt_key(SavedConnection.objects.get().encrypted_key)
