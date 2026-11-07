#!/usr/bin/env bash
# 遊ぶときだけ Container Instance を動かす: ./app.sh start | stop | status
set -euo pipefail
cd "$(dirname "$0")/.."
# プロファイルは環境変数 OCI_PROFILE か、terraform.tfvars の oci_profile から取る
PROFILE="${OCI_PROFILE:-$(sed -n 's/^oci_profile *= *"\(.*\)"/\1/p' terraform.tfvars 2>/dev/null)}"
PROFILE="${PROFILE:-DEFAULT}"
ID=$(terraform output -raw container_instance_id)
case "${1:-status}" in
  start) oci container-instances container-instance start --container-instance-id "$ID" --profile "$PROFILE" --region ap-osaka-1 >/dev/null && echo "起動を指示しました" ;;
  stop) oci container-instances container-instance stop --container-instance-id "$ID" --profile "$PROFILE" --region ap-osaka-1 >/dev/null && echo "停止を指示しました" ;;
  status) oci container-instances container-instance get --container-instance-id "$ID" --profile "$PROFILE" --region ap-osaka-1 --query 'data."lifecycle-state"' --raw-output ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 1 ;;
esac
