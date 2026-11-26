from django.contrib.auth import get_user_model
from django.test import TestCase

from .models import QuickCommand, SavedConnection


class UserCreationTests(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "owner", password="Existing-pass-123!"
        )
        self.user = get_user_model().objects.create_user("member", password="Existing-pass-123!")
        self.payload = {
            "username": "new-member",
            "password1": "Random-long-pass-783!",
            "password2": "Random-long-pass-783!",
        }

    def test_only_superuser_can_create(self):
        self.assertEqual(self.client.get("/users/new/").status_code, 302)
        self.client.force_login(self.user)
        self.assertEqual(self.client.get("/users/new/").status_code, 403)
        self.assertEqual(self.client.post("/users/new/", self.payload).status_code, 403)
        self.assertFalse(get_user_model().objects.filter(username="new-member").exists())

    def test_create_user_and_keep_admin_session(self):
        SavedConnection.objects.create(
            owner=self.admin, name="Private", host="host", username="root"
        )
        QuickCommand.objects.create(
            owner=self.admin, name="Private", category="Admin", command="ls"
        )
        self.client.force_login(self.admin)
        response = self.client.post(
            "/users/new/", {**self.payload, "is_superuser": "1", "is_staff": "1"}
        )
        self.assertEqual(response.status_code, 302)
        created = get_user_model().objects.get(username="new-member")
        self.assertTrue(created.check_password(self.payload["password1"]))
        self.assertFalse(created.is_superuser)
        self.assertFalse(created.is_staff)
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.admin.pk)
        self.client.force_login(created)
        self.assertEqual(self.client.get("/api/connections/").json()["connections"], [])
        self.assertEqual(self.client.get("/api/quick-commands/").json()["commands"], [])

    def test_password_validation_and_duplicates(self):
        self.client.force_login(self.admin)
        for payload in (
            {**self.payload, "password1": "123", "password2": "123"},
            {**self.payload, "password2": "wrong"},
            {**self.payload, "username": self.user.username},
        ):
            self.assertEqual(self.client.post("/users/new/", payload).status_code, 200)
        self.assertFalse(get_user_model().objects.filter(username="new-member").exists())

    def test_creation_page_csrf(self):
        from django.test import Client

        client = Client(enforce_csrf_checks=True)
        client.force_login(self.admin)
        self.assertEqual(client.post("/users/new/", self.payload).status_code, 403)
