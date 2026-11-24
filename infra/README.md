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

## 長く使わないとき（消して、また作る）

**消す前**（記録を手元に残す）

1. リポジトリの直下で `npm run nosql -- backup` … NoSQL の 3 テーブルを `.data/backups/<日付>/` に書き出す（JSON Lines と件数の manifest.json）。`.data/` は .gitignore 済み。プレイヤーの名前と端末の ID が入るので、公開リポジトリには入れない
2. `terraform plan -destroy -out=destroy.tfplan` で消すものを確かめてから `terraform apply destroy.tfplan`

**また遊ぶとき**

1. 「初回」の 3〜5 をもう一度行う（OCIR リポジトリを作る → ログイン → `./scripts/deploy.sh`）。イメージも作り直す
2. 新しい LB の IP（`terraform output lb_public_ip`）を、Cloudflare の DNS の A レコードに入れ直す（**IP は変わる**）
3. リポジトリの直下で `npm run nosql -- restore .data/backups/<日付>` … 記録を書き戻す。件数が manifest と合わなければ止まる
4. `rooms` は 24 時間で消えるルームの状態なので、書き戻しても古いルームは起動時に捨てられる（記録の `games`・`game_events` が本体）

**2026-11-24 の削除**：`.data/backups/2026-11-24/`（3 テーブルとも 0 件）を取ってから、38 リソースをすべて消した。書き戻しの手順は、消す前に本番の NoSQL で 1 行ずつ書き戻し・書き出しを往復して確かめた
