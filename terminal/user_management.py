import json

from django import forms
from django.contrib.auth import get_user_model, password_validation, update_session_auth_hash
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

User = get_user_model()


class ManagedUserForm(forms.ModelForm):
    class Meta:
        model = User
        fields = ["username", "first_name", "last_name", "email", "is_active", "is_superuser"]


def serialize(user):
    return {
        field: getattr(user, field)
        for field in (
            "id",
            "username",
            "first_name",
            "last_name",
            "email",
            "is_active",
            "is_superuser",
        )
    }


@login_required
@require_http_methods(["GET", "POST", "PATCH", "DELETE"])
def users(request, pk=None):
    if not request.user.is_superuser:
        raise PermissionDenied
    if request.method == "GET":
        return JsonResponse(
            {
                "users": [serialize(user) for user in User.objects.order_by("username")],
                "current_user": request.user.pk,
            }
        )
    try:
        data = json.loads(request.body) if request.body else {}
        if not isinstance(data, dict):
            raise ValueError
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"error": "Некорректный JSON."}, status=400)
    with transaction.atomic():
        # Lock administrators together to serialize changes to the last-admin invariant.
        list(User.objects.select_for_update().filter(is_superuser=True).order_by("pk"))
        user = User.objects.filter(pk=pk).first() if pk else None
        if pk and user is None:
            return JsonResponse({"error": "Пользователь не найден."}, status=404)
        if request.method == "DELETE":
            if user is None:
                return JsonResponse({"error": "Выберите пользователя."}, status=400)
            if user.pk == request.user.pk:
                return JsonResponse(
                    {"error": "Нельзя удалить собственную учётную запись."}, status=400
                )
            if (
                user.is_active
                and user.is_superuser
                and User.objects.filter(is_active=True, is_superuser=True).count() <= 1
            ):
                return JsonResponse(
                    {"error": "Нельзя удалить последнего активного администратора."}, status=400
                )
            user.delete()
            return JsonResponse({"deleted": True})
        if (request.method == "PATCH" and user is None) or (request.method == "POST" and pk):
            return JsonResponse({"error": "Некорректная операция."}, status=400)
        form = ManagedUserForm(data, instance=user)
        if not form.is_valid():
            return JsonResponse(
                {"error": "Проверьте поля пользователя.", "fields": form.errors}, status=400
            )
        candidate = form.save(commit=False)
        if (
            user
            and candidate.pk == request.user.pk
            and (not candidate.is_active or not candidate.is_superuser)
        ):
            return JsonResponse(
                {"error": "Нельзя отключить себя или снять собственные права администратора."},
                status=400,
            )
        if user and not (candidate.is_active and candidate.is_superuser):
            if (
                not User.objects.filter(is_active=True, is_superuser=True)
                .exclude(pk=candidate.pk)
                .exists()
            ):
                return JsonResponse(
                    {"error": "Должен остаться активный администратор."}, status=400
                )
        password = data.get("password", "")
        if not isinstance(password, str) or len(password) > 4096:
            return JsonResponse({"error": "Некорректный пароль."}, status=400)
        if not user and not password:
            return JsonResponse({"error": "Укажите пароль нового пользователя."}, status=400)
        if password:
            try:
                password_validation.validate_password(password, candidate)
            except ValidationError as exc:
                return JsonResponse({"error": " ".join(exc.messages)}, status=400)
            candidate.set_password(password)
        candidate.is_staff = candidate.is_superuser
        candidate.save()
        if password and candidate.pk == request.user.pk:
            update_session_auth_hash(request, candidate)
        return JsonResponse(serialize(candidate), status=200 if user else 201)
