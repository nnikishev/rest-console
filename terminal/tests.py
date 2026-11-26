import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from .models import SavedConnection


class ConnectionTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="alice", password="test-pass")
        self.other = get_user_model().objects.create_user(username="bob")
        self.client.force_login(self.user)
        self.payload = {
            "name": "Production",
            "host": "server.example.com",
            "port": 22,
            "username": "deploy",
            "auth_method": "key",
        }

    def test_save_without_secrets_and_list(self):
        response = self.client.post(
            "/api/connections/",
            data=json.dumps({**self.payload, "password": "secret", "key": "private"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertNotIn("password", response.json())
        self.assertNotIn("key", response.json())
        self.assertEqual(SavedConnection.objects.get().owner, self.user)
        self.assertEqual(len(self.client.get("/api/connections/").json()["connections"]), 1)

    def test_owner_isolation(self):
        connection = SavedConnection.objects.create(owner=self.other, **self.payload)
        self.assertEqual(self.client.get("/api/connections/").json()["connections"], [])
        self.assertEqual(self.client.delete(f"/api/connections/{connection.pk}/").status_code, 404)
        self.assertTrue(SavedConnection.objects.filter(pk=connection.pk).exists())

    def test_delete(self):
        connection = SavedConnection.objects.create(owner=self.user, **self.payload)
        self.assertEqual(self.client.delete(f"/api/connections/{connection.pk}/").status_code, 200)
        self.assertFalse(SavedConnection.objects.exists())

    def test_validation(self):
        for changes in ({"port": 0}, {"port": 65536}, {"host": ""}, {"auth_method": "invalid"}):
            response = self.client.post(
                "/api/connections/",
                data=json.dumps({**self.payload, **changes}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 400)
        self.assertFalse(SavedConnection.objects.exists())

    def test_authentication_and_csrf_required(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/connections/").status_code, 302)
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user)
        self.assertEqual(client.post("/api/connections/", self.payload).status_code, 403)

    @override_settings(LOCAL_SSH_HOST="127.0.0.1", LOCAL_SSH_PORT=2222, LOCAL_SSH_USERNAME="local")
    def test_local_server_configuration(self):
        response = self.client.get("/")
        self.assertEqual(
            response.context["local_ssh"],
            {
                "host": "127.0.0.1",
                "port": 2222,
                "username": "local",
            },
        )
        self.assertContains(response, 'id="local-server"')
