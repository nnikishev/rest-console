import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

from .models import QuickCommand, SavedConnection


class UserManagementTests(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            "admin", password="Strong-start-783!"
        )
        self.member = get_user_model().objects.create_user("member", password="Strong-start-783!")
        self.client.force_login(self.admin)
        self.payload = {
            "username": "new-user",
            "first_name": "Имя",
            "last_name": "",
            "email": "",
            "is_active": True,
            "is_superuser": False,
            "password": "Another-strong-783!",
        }

    def request(self, method, path, data):
        if method == "get":
            return self.client.get(path)
        return getattr(self.client, method)(path, json.dumps(data), content_type="application/json")

    def test_create_edit_password_and_delete(self):
        response = self.request("post", "/api/users/", self.payload)
        self.assertEqual(response.status_code, 201)
        pk = response.json()["id"]
        user = get_user_model().objects.get(pk=pk)
        self.assertTrue(user.check_password(self.payload["password"]))
        response = self.request(
            "patch",
            f"/api/users/{pk}/",
            {
                **self.payload,
                "is_active": False,
                "is_superuser": True,
                "password": "Changed-strong-784!",
            },
        )
        self.assertEqual(response.status_code, 200)
        user.refresh_from_db()
        self.assertFalse(user.is_active)
        self.assertTrue(user.is_superuser)
        self.assertTrue(user.check_password("Changed-strong-784!"))
        SavedConnection.objects.create(owner=user, name="Private", host="host", username="root")
        QuickCommand.objects.create(owner=user, name="Test", category="Test", command="ls")
        self.assertEqual(self.client.delete(f"/api/users/{pk}/").status_code, 200)
        self.assertFalse(SavedConnection.objects.filter(owner_id=pk).exists())
        self.assertFalse(QuickCommand.objects.filter(owner_id=pk).exists())

    def test_self_protection(self):
        self.assertEqual(self.client.delete(f"/api/users/{self.admin.pk}/").status_code, 400)
        for active, superuser in ((False, True), (True, False)):
            self.assertEqual(
                self.request(
                    "patch",
                    f"/api/users/{self.admin.pk}/",
                    {
                        **self.payload,
                        "username": "admin",
                        "is_active": active,
                        "is_superuser": superuser,
                        "password": "",
                    },
                ).status_code,
                400,
            )

    def test_authorization_and_csrf(self):
        self.client.force_login(self.member)
        for method, path in [
            ("get", "/api/users/"),
            ("post", "/api/users/"),
            ("patch", f"/api/users/{self.admin.pk}/"),
            ("delete", f"/api/users/{self.admin.pk}/"),
        ]:
            self.assertEqual(self.request(method, path, self.payload).status_code, 403)
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.admin)
        self.assertEqual(client.post("/api/users/", self.payload).status_code, 403)

    def test_validation(self):
        for data in (
            {**self.payload, "password": "123"},
            {**self.payload, "username": "admin"},
            {**self.payload, "password": ""},
        ):
            self.assertEqual(self.request("post", "/api/users/", data).status_code, 400)

    def test_own_password_keeps_session(self):
        response = self.request(
            "patch",
            f"/api/users/{self.admin.pk}/",
            {**self.payload, "username": "admin", "is_superuser": True},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/users/").status_code, 200)
        self.assertNotIn("password", response.json())
