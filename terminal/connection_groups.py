import json

from django import forms
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_http_methods

from .models import ConnectionGroup


class GroupForm(forms.ModelForm):
    class Meta:
        model = ConnectionGroup
        fields = ["name"]

    def clean_name(self):
        name = self.cleaned_data["name"].strip()
        if name.casefold() == "другие":
            raise forms.ValidationError(
                "Название «Другие» зарезервировано для подключений без группы."
            )
        if (
            ConnectionGroup.objects.filter(owner=self.instance.owner, name__iexact=name)
            .exclude(pk=self.instance.pk)
            .exists()
        ):
            raise forms.ValidationError("Группа с таким названием уже существует.")
        return name


@login_required
@require_http_methods(["GET", "POST", "PATCH", "DELETE"])
def groups(request, pk=None):
    if request.method == "GET":
        return JsonResponse(
            {
                "groups": list(
                    ConnectionGroup.objects.filter(owner=request.user).values("id", "name")
                )
            }
        )
    group = (
        get_object_or_404(ConnectionGroup, pk=pk, owner=request.user)
        if pk
        else ConnectionGroup(owner=request.user)
    )
    if request.method == "DELETE":
        if not pk:
            return JsonResponse({"error": "Выберите группу."}, status=400)
        group.delete()
        return JsonResponse({"deleted": True})
    if (request.method == "PATCH" and not pk) or (request.method == "POST" and pk):
        return JsonResponse({"error": "Некорректная операция."}, status=400)
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"error": "Некорректный JSON."}, status=400)
    if not isinstance(data, dict):
        return JsonResponse({"error": "Ожидается объект."}, status=400)
    form = GroupForm(data, instance=group)
    if not form.is_valid():
        return JsonResponse(
            {
                "error": " ".join(
                    message for messages in form.errors.values() for message in messages
                )
            },
            status=400,
        )
    group = form.save()
    return JsonResponse({"id": group.pk, "name": group.name}, status=200 if pk else 201)
