# unpoker インフラ（OCI 大阪）

構成は docs/architecture.md を参照。Cloudflare → Flexible LB → Container Instances ＋ NoSQL。

## 初回

1. **Cloudflare Origin CA 証明書を作る**（Cloudflare ダッシュボード → SSL/TLS → Origin Server）。
   証明書と秘密鍵を手元に保存する（例: `~/.unpoker/origin.pem` と `~/.unpoker/origin.key`）。リポジトリには入れない。
2. `cp terraform.tfvars.example terraform.tfvars` して値を入れる。
3. OCIR リポジトリだけ先に作る:
   `terraform init && terraform apply -target=oci_artifacts_container_repository.server`
4. OCIR にログインする（ユーザー名は `<namespace>/<ユーザー名>`、パスワードは各自の認証トークン）:
   `docker login kix.ocir.io`
5. `./scripts/deploy.sh` … イメージを push し、残りのリソースを作る。
6. 出力された `lb_public_ip` を、Cloudflare の DNS に A レコード（プロキシ有効）で登録し、SSL/TLS を **Full (strict)** にする。

## 普段

- 遊ぶ前: `./scripts/app.sh start`、終わったら `./scripts/app.sh stop`
- 更新: `./scripts/deploy.sh`

## 注意

- tfstate に証明書の秘密鍵が入るので、state は手元だけに置く（.gitignore 済み）。
- LB は止められないので、置いている間は課金される。長く使わないときは `terraform destroy` で消す。
