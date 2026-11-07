# unpoker アーキテクチャ（2026-11-07）

> ルールは [rules.md](rules.md)、操作感は [ux.md](ux.md)、数値の根拠は [simulation.md](simulation.md) を参照。
> 「未検証」と付けた項目は、構築時に一次情報（docs.oracle.com、developers.cloudflare.com）か実機で確かめる。

## 1. 前提

| 項目 | 値 |
|---|---|
| OCI CLI プロファイル | 各自のプロファイル（`infra/terraform.tfvars` の `oci_profile` に書く） |
| リージョン | **ap-osaka-1**（大阪） |
| コンパートメント | 個人用のコンパートメント（名前と OCID はリポジトリに含めず、`infra/terraform.tfvars` に書く。このファイルは git 管理外） |
| ドメイン | Cloudflare で取得済みのドメインのサブドメイン（名前はリポジトリに書かない） |
| 方針 | マネージドサービスを優先するクラウドネイティブ構成。コンポーネントは最小限 |

2026-11-07 に大阪リージョンで確認したこと：

- Container Instances のシェイプ：`CI.Standard.A1.Flex` と `CI.Standard.E4.Flex` が使える
- NoSQL Database：API が応答する（テーブルはまだない）
- Generative AI：チャット用のモデルが一覧に出る

## 2. 構成

```
[iPad: テーブル]   [iPhone: 手札 × 3〜4]
        \               /
         HTTPS / WSS（モバイル回線）
                 |
        Cloudflare（DNS、プロキシ、TLS、WAF）
                 |  Full (strict)、Cloudflare Origin CA 証明書
                 v
   OCI Flexible Load Balancer（最小 10Mbps、HTTPS リスナー）
                 |  受け付けるのは Cloudflare の IP 範囲だけ（NSG で制限）
                 v
   OCI Container Instances（1 台、A1.Flex 1 OCPU / 2GB 程度）
     └─ Node.js サーバー：静的ファイル配信 ＋ WebSocket ＋ ゲームエンジン
          ├─ OCI NoSQL Database …… ルームの状態のスナップショット（再起動したときの復旧用、TTL 24 時間）
          ├─ OCI Logging ………… コンテナの標準出力
          └─ OCI Generative AI …… （2 段階目）AI 相談の説明文
   OCIR …… コンテナイメージ（arm64）
   Terraform（OCI Resource Manager か、手元の terraform）…… 全リソースをコードで管理
```

### 採用しなかったもの

| サービス | 理由 |
|---|---|
| API Gateway | WebSocket に対応していない認識（未検証）。なくても困らない |
| OCI Functions | 実行時間の短い処理向けで、常時つなぎっぱなしの WebSocket に向かない |
| OKE | コンテナ 1 つには過剰 |
| OCI Cache（Redis） | 状態は 1 台のメモリに置き、永続化は NoSQL で足りる |
| Object Storage での静的配信 | 同じコンテナから配信すれば、オリジンが 1 つで済む。Cloudflare がキャッシュする |

### 1 台構成にする理由

- ゲームは 1 ルームあたり最大 5 端末（iPad 1 台とスマホ 4 台）。同時に使うのは自分たちの 1 ルームだけ。
- 状態をサーバーのメモリに置くのが一番単純で速い。2 台以上にすると、同じルームの通信を同じサーバーに振り分ける仕組みが要る。
- 再起動やデプロイで状態が消えないよう、状態が変わるたびに NoSQL にスナップショットを書く。起動時にそこから読み戻す。

## 3. 通信と接続の維持

| 項目 | 方針 |
|---|---|
| 方式 | WebSocket（`wss://<ドメイン>/ws`）。サーバーが状態を持ち、端末ごとに見てよい情報だけを送る |
| 無通信による切断の防止 | アプリから 25 秒ごとに ping を送る。Cloudflare と LB のアイドルタイムアウトより短くするため（Cloudflare は約 100 秒と認識しているが未検証）。LB のアイドルタイムアウトも延ばしておく |
| 再接続 | 端末は `roomId` とトークンを保存しておく。再接続したら、最後に受け取った通番（`lastSeq`）を送り、サーバーは差分か全体のスナップショットを返す |
| 通番 | サーバーから送るイベントには、ルーム単位の通番を付ける。演出のきっかけもイベントとして送り、全端末で同時に再生する |
| 不正防止 | 他人の札、山札の中身、乱数の種は、端末に一切送らない。操作の妥当性はサーバーで検証する（zod でメッセージの形を検査） |

## 4. TLS・セキュリティ

- Cloudflare の SSL/TLS モードは **Full (strict)**。LB に Cloudflare Origin CA 証明書を入れる。
- LB の NSG では、443 番ポートへの接続を Cloudflare の IP 範囲だけに許可する。
- 認証はしない。ルームは推測しにくい ID にし、参加は QR コードで行う。端末ごとにトークンを発行する。
- ルームの作成数と、1 接続あたりのメッセージ数に上限を付ける。Cloudflare の WAF とレート制限も基本設定で使う。

## 5. デプロイと運用

| 項目 | 方針 |
|---|---|
| イメージ | GitHub Actions で arm64 イメージをビルドし、OCIR にプッシュする |
| 反映 | Terraform でイメージのタグを変え、Container Instance を作り直す。数十秒止まるが、ルームは NoSQL から復旧する。`restart` で新しいイメージを取り直すかは未検証 |
| 起動と停止 | 旅行中だけ動かす。`oci container-instances container-instance start/stop` をスクリプトにしておく |
| コスト | Container Instance は止めておけばほぼかからない。LB は止められず、置いている間は課金される（大阪は無料枠の対象外）。使わない期間は Terraform で LB を消す選択肢もある（その場合、作り直すたびに DNS の更新が要る） |
| 監視 | OCI Logging でコンテナのログを見る。外形監視は Cloudflare の Health Check で足りる |

## 6. アプリケーション構成

npm workspaces のモノレポにする（追加のツールが要らないため。pnpm は未導入）。

```
packages/core   … ルールエンジン（純粋な TypeScript。役判定、進行の状態遷移、サイドポット、ナッツ判定、AI 計算）
apps/server     … Node.js 24 ＋ ws。ルーム管理、通信プロトコル、NoSQL への永続化
apps/web        … Vite ＋ React ＋ TypeScript。/table（iPad）と /play（スマホ）
infra/          … Terraform
sim/            … 既存のシミュレーター（core ができたら core を使う形に寄せる）
```

| 領域 | 採用するもの | 理由 |
|---|---|---|
| ルールエンジン | 純粋関数の状態遷移 `(state, action) → state` | サーバーで実行し、テストしやすく、操作をやり直して再現できる |
| 乱数 | サーバー側で暗号論的乱数（`crypto`）を使う。テストでは種を固定できるようにする | 公平性と再現性を両立する |
| アニメーション | CSS ＋ Motion（React 用のアニメーションライブラリ） | 3D のカードめくり、ドラッグ、吸い付きを 60fps で作りやすい |
| 状態管理（web） | サーバーから届く状態を正とし、手元の操作は先に画面へ反映する | ux.md の「触った瞬間に反応する」 |
| テスト | Vitest（core と server）、Playwright（WebKit で複数端末をまとめて動かす） | iPhone の Safari に近い環境で、通しのテストができる |
| 実機での確認 | iOS Safari（iPhone、iPad）で、段階ごとに触って確かめる | ux.md の方針 |
| AI | 計算で答える（全パターンの数え上げとモンテカルロ）。生成 AI は 2 段階目の説明文だけに使う | 速く、正確で、費用がかからない |

## 7. 開発の段階

### 1 段階目（MVP：基本機能）

- ルーム作成（iPad）と QR コードからの参加（スマホ）、3〜4 人
- ルーム設定：初期持ち点、固定ベット額
- 配置フェーズ（3 枚めくる、1 枚を場に出す、3 セット作る）
- 場札公開と公開フェーズ（交代で自分の札をめくる）
- 仮順位とチャレンジ（採用ルール：最下位だけが宣言し、1 位は強制参加、2 位・3 位は任意）
- 得点処理：同点の等分、ナッツボーナス、オールインとサイドポット
- 連続プレイ、脱落、終了条件
- 再接続と状態の復旧、持ち時間と自動操作
- ux.md の演出の中核（カードめくり、公開フェーズ、ルーレット）

### 2 段階目

- 持ち回りベット（親がベット額を決める）
- 有料の追加めくりと持ち越しポット
- AI 相談（配置、チャレンジ）と、生成 AI による説明文
- PWA 化（ホーム画面に追加）、効果音の作り込み

## 8. 未検証・未決の項目

2026-11-07 の構築で確かめたこと:

- Cloudflare で管理しているドメインのサブドメインで公開する（実際の名前はリポジトリに書かない。Cloudflare プロキシ有効、SSL/TLS は Full (strict)、Origin CA 証明書を LB に載せる）
- Cloudflare → OCI LB（HTTP リスナー、アイドルタイムアウト 300 秒）→ Container Instance で WebSocket が通る。無操作 70 秒でも切れない（アプリの 25 秒 ping あり）
- Container Instance はリソース・プリンシパル（既存の動的グループ）で OCIR からイメージを取得でき、NoSQL にも読み書きできる
- NoSQL テーブルは Terraform で ON_DEMAND（容量指定 0）として作れる
- 本番 URL で 3 人（ボット）の 1 ゲームを、配置から結果まで通せた。ルームは NoSQL に保存される
- 実機（iPad と iPhone の Safari）での操作感、QR からの参加、スリープからの復帰はいずれも問題なし（ユーザー確認）

まだ確かめていないこと（いずれも今の構成には影響しない）:

- API Gateway が WebSocket に対応しているか（使っていない）
- Cloudflare のアイドルタイムアウトの正確な値（25 秒 ping で足りている）
- Container Instance から Generative AI をリソース・プリンシパルで呼べるか（第 2 段階の AI 相談で確かめる）
- `restart` で新しいイメージを取り直すか（今はタグを変えて作り直している）
