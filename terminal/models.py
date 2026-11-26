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


class SavedConnection(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    name = models.CharField(max_length=100)
    host = models.CharField(max_length=253)
    port = models.PositiveIntegerField(
        default=22, validators=[MinValueValidator(1), MaxValueValidator(65535)]
    )
    username = models.CharField(max_length=128)
    encrypted_key = models.TextField(blank=True, default="", editable=False)
    auth_method = models.CharField(
        max_length=8, choices=[("password", "Пароль"), ("key", "SSH-ключ")], default="password"
    )

    class Meta:
        ordering = ["name", "pk"]
