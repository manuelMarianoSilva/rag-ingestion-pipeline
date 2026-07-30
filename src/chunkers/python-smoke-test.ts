import { chunkPythonFile } from "./python.js";
import type { RawDocument } from "../types.js";

const sample = `
from fastapi import FastAPI
from flask import Blueprint
from bottle import route
from django.db import models
from rest_framework import serializers
from rest_framework.views import APIView
from rest_framework.decorators import api_view

app = FastAPI()
bp = Blueprint("users", __name__)


@app.get("/users/{user_id}")
async def get_user(user_id: str):
    """Returns a single user by id."""
    return {"id": user_id}


@bp.route("/users", methods=["POST"])
def create_user():
    """Creates a new user from the request body."""
    return {"created": True}


@route("/health")
def health_check():
    return "ok"


def _internal_helper(user):
    return user.name is not None


class User(models.Model):
    """A registered user."""
    name = models.CharField(max_length=100)
    email = models.EmailField()


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "name", "email"]


class UserView(APIView):
    """List and retrieve users."""

    @api_view(["GET"])
    def get(self, request):
        return Response(UserSerializer(User.objects.all(), many=True).data)

    def _format(self, user):
        return {"id": user.id, "name": user.name}
`;

const doc: RawDocument = {
  sourceType: "code",
  sourceId: "github:acme/users-service:app/users.py",
  content: sample,
  metadata: {
    repo: "acme/users-service",
    provider: "github",
    ref: "main",
    filePath: "app/users.py",
    language: "python",
    url: "https://github.com/acme/users-service/blob/main/app/users.py",
    contentHash: "test-hash",
  },
};

const chunks = chunkPythonFile(doc);

console.log(`Extracted ${chunks.length} chunks:\n`);
for (const c of chunks) {
  console.log("─".repeat(60));
  console.log(`symbol: ${c.metadata.symbolName}  type: ${c.metadata.symbolType}  exported: ${c.metadata.exported}`);
  console.log(`lines: ${c.metadata.startLine}-${c.metadata.endLine}  markers: ${c.metadata.frameworkMarkers?.join(", ")}`);
  console.log(`imports found in file: ${c.metadata.imports?.join(", ")}`);
  console.log("\n--- embedded content ---");
  console.log(c.content);
  console.log();
}
