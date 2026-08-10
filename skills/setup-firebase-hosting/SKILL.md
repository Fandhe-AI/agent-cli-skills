---
name: setup-firebase-hosting
description: 静的サイトを Firebase Hosting（Spark プラン・課金なし）で公開し、GitHub Actions から自動デプロイする環境をコードで構築する。プロジェクト作成・API 有効化・サービスアカウント・Secret 登録・firebase.json・デプロイワークフローまでを一括で用意する。「Firebase で公開したい」「無料でデプロイ」「CI からデプロイ」などで使用。
model: sonnet
---

# setup-firebase-hosting

静的サイト（SSG 出力・SPA・LP など）を Firebase Hosting へ公開し、`main` への push で自動デプロイされる状態までを構築します。

**公開先は Spark プラン（請求先アカウント未紐付け）を既定とします。** 請求手段が存在しないため、アクセスが集中しても課金が発生しません。

## 前提条件

必須:

- `gcloud` CLI（未導入なら `brew install --cask google-cloud-sdk`。PATH は `/opt/homebrew/share/google-cloud-sdk/bin`）
- `gh` CLI（認証済み）
- Node.js（`npx firebase-tools` を使う）
- 対象リポジトリが GitHub 上にあること

対象サイトの条件:

- **完全な静的サイト**であること（サーバー処理・API・DB を持たない）。動的処理が要るなら Cloud Run 等を検討する（後述の「他サービスを選ばない理由」参照）
- ビルドコマンドを 1 つ叩けば出力ディレクトリ（`dist/` 等）が完成すること

**sandbox 環境での実行について:** `bootstrap-firebase.sh` は `gcloud auth login` のブラウザ認証・GCP/Firebase API 呼び出し・`gh secret set` などネットワーク越しの認証操作を必須とするため、sandbox（ネットワーク制限下）では実行できません。認証済みのローカル端末または CI 上で実行してください。`firebase.json` の作成やローカル検証（Step 3-4）はネットワーク不要なため sandbox でも実行可能です。

## 最初にユーザーへ確認すること

### 1. Firebase 利用規約の承諾（**Google アカウントにつき 1 回・コンソールでしか行えない**）

未承諾だと後続の `addFirebase` が `403 PERMISSION_DENIED` で落ちます。**先に済ませてください。** 公式ドキュメントに明記された仕様上の制約です。

> "Accepting the Firebase Terms is not possible using the Firebase CLI, REST API, or Terraform. It can only be done using the Firebase console."
> — [Get started with Firebase using an existing Google Cloud project](https://firebase.google.com/docs/projects/use-firebase-with-existing-cloud-project)

https://console.firebase.google.com/ を開き、任意のプロジェクトを 1 つ作るか既存プロジェクトへ Firebase を追加して規約に同意します。

**この 403 は IAM 権限不足と同じメッセージ（`The caller does not have permission`）を返すため区別がつきません。** 切り分けは次で行えます。

```bash
curl -sS -X POST "https://cloudresourcemanager.googleapis.com/v1/projects/<PROJECT_ID>:testIamPermissions" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: <PROJECT_ID>" -H "Content-Type: application/json" \
  -d '{"permissions":["firebase.projects.update","resourcemanager.projects.get","serviceusage.services.enable","serviceusage.services.get"]}'
```

4 つすべてが返るのに `addFirebase` が 403 なら、原因は規約未承諾です。

### 2. プラン（Spark / Blaze）

既定は **Spark**。「勝手に課金されない」ことを最優先するなら唯一の選択肢です。

| | Spark | Blaze |
|---|---|---|
| 課金 | 請求手段が存在しない（構造的に 0 円） | 無料枠超過分を従量課金（$0.15/GB） |
| 無料枠 | ストレージ 10 GB・転送 10 GB/月 | 同じ |
| 枠を超えたら | 短い猶予後にサイト無効化、**翌月まで復旧しない** | 停止しないが**請求額に上限がない** |

**Blaze には上限を強制する手段がありません。** 3 つとも使えないことを確認済みです。

1. 予算アラートは止めない — 公式に *"budgets and budget alerts do **not** cap your usage or charges"*
2. Cloud Spend Caps（ハードキャップ）は Gemini API / Gemini Enterprise Agent Platform / Cloud Run / Cloud Run functions のみ対応で、**Firebase Hosting は対象外**
3. 予算通知 → Pub/Sub → Cloud Functions で請求無効化する定番の回避策は、無効化すると Spark 相当に戻る = **結局サイトが停止**し、検知ラグ分は課金される

悪意ある大量アクセス（denial of wallet）でも被害は非対称です。Spark は金銭被害 0 円で「その月止まる」に限定（損害上限が確定）、Blaze は課金が続くうえサイトは止まらず攻撃者に配信し続けます。

### 3. サイト ID

**公開 URL は Hosting サイト ID から決まります（プロジェクト ID ではありません）。** 1 プロジェクトに複数サイトを置けるため両者は独立です。汎用プロジェクト配下にアイデア名のサイトを置く運用ができます。

- プロジェクト `myorg-notes` + サイト `notes` → `https://notes.web.app`

サイト ID は全 Firebase で一意です。使用済みなら別の ID を選びます。

### 4. 独自ドメインを使うか

`<site>.web.app` なら完全に 0 円で DNS 操作も不要です。独自ドメインを使う場合、**DNS レコード登録がレジストラ側の UI 操作として残ります**。Cloud DNS を使えばコード管理できますが、$0.20/ゾーン/月の有料サービスで請求先アカウントが必須になり、**Spark の保証が失われます**。

SEO を積む予定があるなら早めに決めてください。ドメイン移行でコード変更は不要（後述の環境変数化）ですが、検索エンジンに蓄積した評価はリセットされます。

## 手順

### Step 1: bootstrap スクリプトを配置して実行する

`scripts/bootstrap-firebase.sh` を対象リポジトリの `tools/bootstrap-firebase.sh` へコピーし、冒頭のプレースホルダを書き換えます。デプロイワークフローと再実行がこのパスを前提にします。

```bash
PROJECT_ID=__PROJECT_ID__      # 例: myorg-<project>
SITE_ID=__SITE_ID__            # 例: <idea>。公開 URL は https://<SITE_ID>.web.app
GITHUB_REPO=__OWNER__/__REPO__ # Secret / 変数の登録先
```

**書き換えないまま実行すると先頭の安全弁で止まります。** `PROJECT_ID` のプロジェクトが存在しなければ**新規作成する**挙動のため、プレースホルダのまま走らせると意図しないプロジェクトができるためです（実際にやりました）。

```bash
gcloud auth login                 # ブラウザ認証（初回のみ・自動化不可）
bash tools/bootstrap-firebase.sh  # 冪等。再実行しても安全
```

スクリプトが行うこと:

1. GCP プロジェクトを確認・作成（**請求先アカウントを紐付けない = Spark 固定**）し、`billingEnabled` が `False` と判定できなければ **fail-closed で停止**する（未紐付けと決めつけない）。意図的に Blaze で進める場合のみ `ALLOW_BLAZE=true` を付けて明示的に承認する
2. `firebase` / `firebasehosting` / `cloudresourcemanager` / `serviceusage` / `iam` の API を有効化
3. Firebase Management API で Firebase を追加、Hosting API でサイトを作成
4. CI 用サービスアカウントを作成し**最小ロール**を付与（`roles/firebasehosting.admin` + `roles/serviceusage.apiKeysViewer`）
5. 新規鍵を発行 → `gh secret set FIREBASE_SERVICE_ACCOUNT` → 登録成功後、**サービスアカウントを今回の実行で新規作成した場合のみ**旧 USER_MANAGED 鍵を自動削除（10 個上限対策の世代交代。登録前に削除すると失敗時に有効な鍵が残らないため、必ず登録成功後に削除する）。**サービスアカウントが実行前から存在していた場合は自動削除しません**（`displayName` のような書き換え可能な情報だけを根拠に「本スクリプト専用アカウントだ」と推測すると、同名の別用途アカウントの認証を誤って壊しかねないため）。2 回目以降の再実行で鍵の世代交代をしたい場合は、内容を確認したうえで `ROTATE_EXISTING_KEYS=true` を明示的に指定してください。指定しない場合、鍵は自動削除されず手動での整理が必要になります。最後に**手元の鍵ファイルを削除**（trap で異常終了時も）
6. `gh variable set FIREBASE_PROJECT_ID` / `FIREBASE_SITE_ID`、`.firebaserc` を生成

**Firebase の追加とサイト作成は firebase CLI ではなく REST API を gcloud のトークンで直接叩きます。** firebase CLI は gcloud と別の認証情報を持つため、CLI を使うとブラウザ認証がもう 1 回増えるためです。API 呼び出しには `x-goog-user-project: <PROJECT_ID>` ヘッダが必須です。gcloud のユーザー認証情報はクォータ課金先を持たず、これがないと gcloud 自身のクライアントプロジェクトが consumer とみなされて `403 SERVICE_DISABLED` になります。

付けないロールにも意味があります。Auth も Cloud Run rewrites も使わない前提なので `roles/firebaseauth.admin` / `roles/run.viewer` は付けません。その結果デプロイ時に `Unable to add channel domain to Firebase Auth` という警告が出ますが**無害**です。

### Step 2: ベース URL をビルド時の環境変数にする

canonical・OGP・sitemap・JSON-LD の絶対 URL は 1 箇所から生成し、**固定値を書かない**でください。独自ドメインへ移行してもコード変更が不要になります。

Rust の例:

```rust
pub const BASE_URL: &str = match option_env!("SITE_BASE_URL") {
    Some(url) => url,
    None => "https://<site-id>.web.app",
};
```

```rust
// build.rs — これがないと target/ を再利用する self-hosted ランナーで
// 「環境変数を変えたのに古い canonical が出力され続ける」状態になる
fn main() {
    println!("cargo:rerun-if-env-changed=SITE_BASE_URL");
}
```

他のスタックでも同様に、**ビルドキャッシュが環境変数の変更を検知する**ことを確認してください。

### Step 3: firebase.json を作る

```json
{
  "hosting": {
    "site": "<site-id>",
    "public": "dist",
    "trailingSlash": false,
    "cleanUrls": false,
    "ignore": ["firebase.json", "**/.*"],
    "headers": [
      {
        "source": "**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=3600" }]
      },
      {
        "source": "/sw.js",
        "headers": [{ "key": "Cache-Control", "value": "no-cache" }]
      },
      {
        "source": "/static/**",
        "headers": [
          { "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }
        ]
      }
    ]
  },
  "emulators": {
    "hosting": { "port": 5002 },
    "singleProjectMode": true
  }
}
```

守るべき点:

- **`trailingSlash: false`** — canonical を末尾スラッシュなしで出しているなら必須。既定は `/about/` に正規化するため、放置すると全ページで canonical と実 URL が 301 1 回分ずれます。逆に canonical が末尾スラッシュありなら指定不要です
- **`headers` は後方のエントリが勝ちます。** catch-all `**` を先頭に置き、個別指定を後ろに並べます。また **HTML ページのリクエストパスは拡張子なし**（`/about`）なので `**/*.html` ではマッチしません。catch-all で拾ってください
- **ファイル名にコンテンツハッシュがないアセットに `immutable` を付けない。** 更新が永久に届かなくなります。`max-age=0, must-revalidate` なら 304 で済み転送量もほぼ消費しません
- **Service Worker を使うなら `/sw.js` は `no-cache`。** SW スクリプト本体がキャッシュされるとキャッシュ世代管理が機能せず、利用者が古いビルドに固定されます
- **`trailingSlash: false` の既知の無限リダイレクト**（[superstatic#235](https://github.com/firebase/superstatic/issues/235)）— `X.html` と `X/index.html` が共存すると発生します。出力に衝突がないか確認してください
- macOS では 5000 番を ControlCenter（AirPlay Receiver）が占有するため、エミュレータのポートを変えておきます

### Step 4: ローカルで配信設定を検証する（GCP アカウント不要）

`firebase emulators:start` は**本番と同じ superstatic エンジン**で `firebase.json` を解釈します。デプロイ前にここで確定できます。

```bash
npx firebase-tools emulators:start --only hosting --project demo-<name>
```

`curl` で確認する項目:

```bash
B=http://127.0.0.1:5002
curl -s -o /dev/null -w '%{http_code}\n' "$B/about"            # 200（リダイレクトなし）
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$B/about/"  # 301 → /about
curl -sI "$B/sw.js" | grep -i cache-control                     # no-cache
curl -s -o /dev/null -w '%{content_type}\n' "$B/*.wasm"         # application/wasm
curl -s -o /dev/null -w '%{http_code} redirects=%{num_redirects}\n' -L "$B/about/"  # 無限リダイレクトがないこと
```

### Step 5: デプロイワークフローを置く

`.github/workflows/deploy.yml`。以下は Rust + wasm の例です。**ビルド部分は対象プロジェクトに合わせて差し替えてください。**

**runner は組織の runner-policy（[Fandhe-AI/actions](https://github.com/Fandhe-AI/actions) の `docs/runner-policy.md`）に従います。public リポジトリは GitHub ホステッド runner（`ubuntu-latest` 等）を使い、`pull_request` で未信頼コードを self-hosted 上で実行しません。** private リポジトリで self-hosted を使う場合も、`pull_request_target` の使用や secret を扱う job との信頼境界には注意し、runner-policy.md の手順に従ってください。

**`build` job と `deploy` job を分離しています。** `pull_request` では PR 側の未信頼コード（`cargo run` / `cargo test`）が実行されるため、この job には write 権限のトークンも Firebase の secret も渡しません（`persist-credentials: false` で `actions/checkout` の資格情報も残しません）。ビルド成果物だけを `deploy` job へ artifact 経由で渡し、`pull-requests: write` / `checks: write` や `FIREBASE_SERVICE_ACCOUNT` を扱うのは信頼済みコードだけが動く `deploy` job に限定します。同一 job で未信頼コードと書き込み権限トークンを同居させると、悪意ある PR がビルド中に `GITHUB_TOKEN` や secret を窃取・悪用できてしまうためです。

**`deploy` job は PR でも常に base 側（`github.event.pull_request.base.sha`）の `firebase.json` を checkout します。** PR 側の revision を使うと、悪意ある PR が `firebase.json` の predeploy hook 等を通じて write 権限トークンや Firebase secret を窃取できるためです。この結果、**PR で `firebase.json` 等のデプロイ設定を変更してもプレビューには反映されず、マージ後の本番デプロイから反映されます**（セキュア・バイ・デフォルトを優先した意図的な制約です）。

```yaml
name: デプロイ

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true

env:
  SITE_BASE_URL: https://${{ vars.FIREBASE_SITE_ID || '<site-id>' }}.web.app

jobs:
  # 未信頼な PR コードをビルド・テストする job。write 権限のトークンも
  # Firebase の secret も渡さない（persist-credentials: false で checkout の
  # 資格情報も残さない）。
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false

      - name: 前提の確認（fail-closed）
        run: |
          test -n "${{ vars.FIREBASE_PROJECT_ID }}" \
            || { echo "FIREBASE_PROJECT_ID が未設定です。tools/bootstrap-firebase.sh を実行してください。"; exit 1; }
          test -n "${{ vars.FIREBASE_SITE_ID }}" \
            || { echo "FIREBASE_SITE_ID が未設定です。"; exit 1; }

      # GitHub ホステッド runner は毎回まっさらな環境のため ~/.cargo/bin が PATH に無い
      - name: ツールチェーンを用意
        run: |
          echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"
          export PATH="$HOME/.cargo/bin:$PATH"
          # 例: rustup target add wasm32-unknown-unknown / cargo install ...

      - name: ビルド
        run: cargo run --release   # ← プロジェクトに合わせる

      - name: テスト
        run: cargo test --release  # ← プロジェクトに合わせる

      - name: 出力の検証
        run: |
          # ドメインは「リポジトリ変数」と突き合わせる。出力から推定した値と
          # 比べる検証（sitemap 自身からベース URL を読む等）は、値が誤って
          # いても必ず PASS するため意味がない
          grep -q "${SITE_BASE_URL}" dist/sitemap.xml \
            || { echo "sitemap.xml に ${SITE_BASE_URL} がありません（ビルドキャッシュが古い可能性）"; exit 1; }
          ! grep -q "example.com" dist/sitemap.xml \
            || { echo "プレースホルダのドメインが残っています"; exit 1; }
          # 別ステップで生成する成果物（wasm 等）の欠落は静的チェックでは
          # 検出できないことが多い。存在を明示的に確認する
          # test -f dist/static/wasm/<name>_bg.wasm || { echo "wasm がありません"; exit 1; }

      - name: 成果物をアップロード
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: dist
          path: dist/
          retention-days: 1

  # secret と書き込み権限トークンを扱う job。未信頼コードは一切実行せず、
  # build job が作った成果物を配信するだけに限定する。
  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      # action-hosting-deploy は結果を check-run として作成する。permissions を
      # 明示すると未列挙のスコープは none になるため、checks を落とすと 403
      # （Resource not accessible by integration）でデプロイ前に落ちる。
      checks: write
    steps:
      # firebase.json（Step 3 で作成）を読み込むためリポジトリを checkout する。
      # PR 側の checkout はデフォルトで PR のマージコミット（未信頼コードを含む）を
      # 取得してしまう。PR で firebase.json に predeploy hook 等を仕込まれると、
      # write 権限トークンと Firebase secret を持つこの job で任意コマンドが実行
      # されてしまうため、必ず base（信頼済み revision）を checkout する。
      # これにより「PR で firebase.json を変更してもプレビューには反映されず、
      # マージ後の本番デプロイから反映される」という制約を受け入れる
      # （セキュア・バイ・デフォルトを優先）。
      # checkout はデフォルトで作業ディレクトリをクリーンにするので、必ず
      # download-artifact より前に実行する。
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.sha }}
          persist-credentials: false

      - name: 成果物をダウンロード
        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
        with:
          name: dist
          path: dist/

      - name: プレビューチャンネルへデプロイ（PR）
        if: github.event_name == 'pull_request'
        uses: FirebaseExtended/action-hosting-deploy@500ac625ca2dd40cbd15f7659af953801858032a # v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
          projectId: ${{ vars.FIREBASE_PROJECT_ID }}
          expires: 7d

      - name: 本番チャンネルへデプロイ（main）
        if: github.event_name != 'pull_request'
        uses: FirebaseExtended/action-hosting-deploy@500ac625ca2dd40cbd15f7659af953801858032a # v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
          projectId: ${{ vars.FIREBASE_PROJECT_ID }}
          channelId: live
```

設計上の要点:

- **デプロイ先が未設定なら落とす（スキップしない）。** スキップすると「CI は緑なのにサイトが更新されない」状態を検知できません
- **ドメイン検証は独立した情報源（リポジトリ変数）と突き合わせる。** ビルド出力から期待値を導く検証は、値が誤っていても必ず PASS します。このセッションで唯一「静かに壊れる」性質のバグでした
- 実装専用リポジトリならパスフィルタは不要。モノレポに置くなら `paths:` で絞ります

### Step 6: CI 経由で実際にデプロイされることを確認する

**ローカルからの `firebase deploy` が通っても、CI 経路が通る証明にはなりません。** PR を 1 本作り、プレビュー URL が PR にコメントされるところまで見てください。そのうえでマージし、本番チャンネルが更新されることを確認します。

```bash
npx firebase-tools hosting:channel:list --project <project-id> --site <site-id>
```

`live` の Last Release Time が CI 実行時刻に更新されていれば完了です。

## よくある失敗と原因

| 症状 | 原因 |
|------|------|
| `addFirebase` が `403 The caller does not have permission` | Firebase 利用規約が未承諾（IAM 不足と同じ文言。`testIamPermissions` で切り分け） |
| `403 SERVICE_DISABLED` / `requires a quota project` | API 呼び出しに `x-goog-user-project` ヘッダがない |
| デプロイ step が `403 Resource not accessible by integration` | `permissions` に `checks: write` がない |
| CI だけ `command not found`（ローカルは通る） | self-hosted ランナーの PATH に `~/.cargo/bin` がない |
| CI は緑なのにサイトが更新されない | デプロイ step がスキップされている（変数未設定を fail にしていない） |
| canonical と実 URL が 301 ずれる | `trailingSlash` の設定が canonical の形式と食い違っている |
| 更新したのに古い JS/CSS/wasm が配信され続ける | コンテンツハッシュのないファイル名に `immutable` を付けている |
| デプロイ時に `Unable to add channel domain to Firebase Auth` | Auth 用ロールを付けていないため。Auth を使わないなら無害 |

## 他の GCP サービスを選ばない理由

日本向けサービスの場合、いずれも**コストではなく地理的制約**で不適合です。

| サービス | 不適合の理由 |
|---------|-------------|
| Cloud Storage 静的ホスティング | 無料枠が `us-east1` / `us-west1` / `us-central1` 限定。HTTPS には Cloud Load Balancing（月 $18 前後）が必須で無料にならない |
| Cloud Run | 無料の下り転送が**北米からの 1 GB/月のみ**。東京リージョン配信は 1 リクエスト目から課金対象 |
| App Engine スタンダード | 下り転送が **1 GB/日**で Firebase Hosting より厳しく、静的配信にインスタンス時間を消費する |

## 自動化できない操作

| 操作 | 理由 |
|------|------|
| `gcloud auth login` | ブラウザ同意。Google アカウントにつき 1 回 |
| Firebase 利用規約の承諾 | **コンソール専用**（公式ドキュメントに明記） |
| 独自ドメインの DNS レコード登録 | レジストラ側の操作。Cloud DNS は有料で Spark の保証が失われる |

## 関連

- 構築後の運用（データ鮮度チェック等の週次 CI）は各プロジェクトで用意する
- コミット・PR は `create-commit` / `create-pr` を使う
