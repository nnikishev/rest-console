from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models


class QuickCommand(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    category = models.CharField(max_length=80, default="Мои команды")
    name = models.CharField(max_length=100)
    command = models.CharField(max_length=4096)

    class Meta:
        ordering = ["category", "name", "pk"]


class ConnectionGroup(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    name = models.CharField(max_length=80)

    class Meta:
        ordering = ["name", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "name"], name="unique_connection_group_owner_name"
            )
        ]

    def __str__(self):
        return self.name


class SavedConnection(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    name = models.CharField(max_length=100)
    host = models.CharField(max_length=253)
    port = models.PositiveIntegerField(
        default=22, validators=[MinValueValidator(1), MaxValueValidator(65535)]
    )
    username = models.CharField(max_length=128)
    group = models.ForeignKey(
        ConnectionGroup,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="connections",
    )
    encrypted_key = models.TextField(blank=True, default="", editable=False)
    auth_method = models.CharField(
        max_length=8, choices=[("password", "Пароль"), ("key", "SSH-ключ")], default="password"
    )

    class Meta:
        ordering = ["name", "pk"]
