#!/usr/bin/env bash
# イメージをビルドして OCIR に push し、Terraform で Container Instance を差し替える
# 前提: infra/terraform.tfvars がある、OCIR に docker login 済み（ユーザー名とトークンは各自で入力）
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)}"
IMAGE_BASE=$(terraform output -raw image_url 2>/dev/null | sed 's/:[^:]*$//' || true)
if [ -z "$IMAGE_BASE" ]; then
  echo "先に terraform apply で OCIR リポジトリを作る（README 参照）" >&2
  exit 1
fi
echo "== build ${IMAGE_BASE}:${TAG}"
docker build --platform linux/arm64 -t "${IMAGE_BASE}:${TAG}" ..
docker push "${IMAGE_BASE}:${TAG}"
echo "== apply image_tag=${TAG}"
terraform apply -var "image_tag=${TAG}"
