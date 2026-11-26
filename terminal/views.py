import json

from django import forms
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.core.exceptions import PermissionDenied
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods

from .key_storage import encrypt_key
from .models import ConnectionGroup, QuickCommand, SavedConnection


class ApplicationUserForm(UserCreationForm):
    class Meta(UserCreationForm.Meta):
        model = get_user_model()
        fields = ("username",)


@login_required
@require_http_methods(["GET", "POST"])
def create_user(request):
    if not request.user.is_superuser:
        raise PermissionDenied
    form = ApplicationUserForm(request.POST if request.method == "POST" else None)
    if request.method == "POST" and form.is_valid():
        user = form.save(commit=False)
        user.is_staff = False
        user.is_superuser = False
        user.save()
        return redirect("/users/new/?created=1")
    return render(
        request, "create_user.html", {"form": form, "created": request.GET.get("created") == "1"}
    )


class QuickCommandForm(forms.ModelForm):
    class Meta:
        model = QuickCommand
        fields = ["category", "name", "command"]

    def clean_command(self):
        command = self.cleaned_data["command"]
        if any(ord(char) < 32 or ord(char) == 127 for char in command):
            raise forms.ValidationError(
                "Команда должна быть одной строкой без управляющих символов."
            )
        return command


@login_required
@require_http_methods(["GET", "POST"])
def quick_commands(request):
    if request.method == "GET":
        return JsonResponse(
            {
                "commands": list(
                    QuickCommand.objects.filter(owner=request.user).values(
                        "id", "category", "name", "command"
                    )
                )
            }
        )
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"error": "Некорректный JSON."}, status=400)
    if not isinstance(data, dict):
        return JsonResponse({"error": "Ожидается объект."}, status=400)
    form = QuickCommandForm(data)
    if not form.is_valid():
        return JsonResponse(
            {"error": "Укажите категорию, название и однострочную команду (до 4096 символов)."},
            status=400,
        )
    command = form.save(commit=False)
    command.owner = request.user
    command.save()
    return JsonResponse({"id": command.pk}, status=201)


@login_required
@require_http_methods(["DELETE"])
def delete_quick_command(request, pk):
    get_object_or_404(QuickCommand, pk=pk, owner=request.user).delete()
    return JsonResponse({"deleted": True})


class ConnectionForm(forms.ModelForm):
    class Meta:
        model = SavedConnection
        fields = ["name", "host", "port", "username", "auth_method", "group"]

    def __init__(self, *args, owner, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["group"].queryset = ConnectionGroup.objects.filter(owner=owner)


def serialize(connection):
    return {
        "id": connection.pk,
        "has_key": bool(connection.encrypted_key),
        **{
            field: getattr(connection, field)
            for field in ConnectionForm.Meta.fields
            if field != "group"
        },
        "group": connection.group_id,
    }


@login_required
def terminal_page(request):
    return render(request, "terminal.html")


@login_required
@require_http_methods(["GET", "POST"])
def connections(request):
    if request.method == "GET":
        return JsonResponse(
            {
                "connections": [
                    serialize(c) for c in SavedConnection.objects.filter(owner=request.user)
                ]
            }
        )
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"error": "Некорректный JSON."}, status=400)
    if not isinstance(data, dict):
        return JsonResponse({"error": "Ожидается объект."}, status=400)
    form = ConnectionForm(data, owner=request.user)
    if not form.is_valid():
        return JsonResponse(
            {"error": "Проверьте поля закладки.", "fields": form.errors}, status=400
        )
    connection = form.save(commit=False)
    connection.owner = request.user
    if data.get("save_key") is True:
        if connection.auth_method != "key":
            return JsonResponse(
                {"error": "Сохранение ключа доступно только для входа по SSH-ключу."}, status=400
            )
        try:
            connection.encrypted_key = encrypt_key(data.get("key"))
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
    connection.save()
    return JsonResponse(serialize(connection), status=201)


@login_required
@require_http_methods(["PATCH", "DELETE"])
def delete_connection(request, pk):
    connection = get_object_or_404(SavedConnection, pk=pk, owner=request.user)
    if request.method == "PATCH":
        try:
            data = json.loads(request.body)
        except (ValueError, UnicodeDecodeError):
            return JsonResponse({"error": "Некорректный JSON."}, status=400)
        if not isinstance(data, dict):
            return JsonResponse({"error": "Ожидается объект."}, status=400)
        form = ConnectionForm(data, instance=connection, owner=request.user)
        if not form.is_valid():
            return JsonResponse(
                {"error": "Проверьте поля подключения.", "fields": form.errors}, status=400
            )
        connection = form.save(commit=False)
        if connection.auth_method != "key" or data.get("remove_key") is True:
            connection.encrypted_key = ""
        if data.get("save_key") is True:
            if connection.auth_method != "key":
                return JsonResponse({"error": "Выберите вход по SSH-ключу."}, status=400)
            try:
                connection.encrypted_key = encrypt_key(data.get("key"))
            except ValueError as exc:
                return JsonResponse({"error": str(exc)}, status=400)
        connection.save()
        return JsonResponse(serialize(connection))
    connection.delete()
    return JsonResponse({"deleted": True})
