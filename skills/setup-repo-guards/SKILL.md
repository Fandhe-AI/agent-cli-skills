---
name: setup-repo-guards
description: >
  Fandhe-AI 組織標準の CI ガード一式（ai-review 導入 / AGENTS.md レビュー観点集 / 必須チェック集約ジョブ /
  branch protection ruleset・追加ガード）を対象リポジトリへ導入する。「リポジトリガード入れて」「CI ガード導入して」
  「branch protection セットアップ」「ai-review 導入して」「AGENTS.md 整備して」などで使用。
  複数リポジトリへの一括適用にも対応。.claude/ 体系の初期セットアップは init-claude、既存体系の充実は update-claude を参照。
model: opus
user-invocable: true
argument-hint: "<対象リポジトリ名 (owner/repo)> <public|private> [追加のリポジトリ...]"
---

# setup-repo-guards

対象リポジトリへ組織標準の CI ガード一式を導入する。導入するのは次の 4 点で、
Step 1 → 4 の順に、各 Step を PR → CI 全 pass → レビュースレッド resolve → squash merge で確定させてから次へ進む。

1. ai-review（PR 自動レビュー workflow の wrapper）
2. AGENTS.md（AI レビューが読むレビュー観点集）
3. CI 必須チェックの集約ジョブ（`ci-complete` 等）
4. branch protection ruleset・リポジトリ追加ガード（GitHub API のみ、コミット不要。適用前に退避・差分提示・明示承認を必須とする）

この順序を守る理由: 「必須チェックに入れる集約ジョブが先に存在する」「AGENTS.md は PR の base コミット参照のため
マージ後の次の PR から実効」という依存関係が、この順で自然に満たされる。

## 使い方

```
setup-repo-guards Fandhe-AI/my-repo public
setup-repo-guards Fandhe-AI/repo-a public Fandhe-AI/repo-b private
```

- 第 1 引数: 対象リポジトリ名（`owner/repo`）。許容形式は `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$` のみ（Step 0 で検証する）
- 第 2 引数: visibility（`public` / `private` の完全一致のみ。Step 0 で検証する）。runner 方針の分岐に使う（public は ubuntu ホステッド、private は self-hosted。ai-review の review ジョブのみ self-hosted の専用 runner の例外）
- 複数リポジトリへ一括適用する場合はリポジトリと visibility の組を列挙する。各リポジトリのセッション（または並列 agent）で順次消化する

## 前提条件

- `gh` CLI がインストールされ、対象リポジトリの admin 権限で認証済みであること（`command -v gh && gh auth status` で確認）
- `jq` がインストールされていること（`command -v jq` で確認）
- Fandhe-AI/actions（reusable workflow の提供元）への参照権限があること
- 対象リポジトリを clone 済みで、CLAUDE.md・既存 workflow を読める状態であること
- Step 4 の適用可否に利用者が応答できること（対話可能であること）。応答できない自動運転環境では Step 4 の書き込みを実行せず、差分と退避先を報告して停止する
- 退避先（`mktemp -d` が作る作業ツリー外のディレクトリ）に書き込めること

## フロー

### Step 0: 引数の検証（最初に実行）

引数の値は `gh api` のパスや runner 方針の分岐にそのまま入るため、`gh` を含むコマンドを実行する前に
許可リストで検証する（A03 インジェクション・パス注入の防止）。複数リポジトリの一括適用では組ごとに検証し、
不正な組は処理せず完了報告に載せて、他の組は続行する。

**束縛の安全性（検証より前に生の入力をシェルへ入れない）**: 引数値を `repo="<入力>"` のように
ダブルクォートへ直接展開してコマンド文字列に埋め込まない（`"; cmd; "` や `$(...)` を含む入力が検証前に
実行される）。クォート付き HEREDOC も、入力が区切り語の単独行とそれに続くコマンドを含むと HEREDOC を抜けて
後続行が実行されるため、それだけでは安全ではない。次の手順で束縛する。

1. 先に文字列として照合する（シェルへ渡す前）: 入力が単一行で、改行・CR・区切り語（下記 `ARG_EOF_` 接頭辞の行）を
   含まず、`^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`（visibility は `public` / `private`）に一致することを確かめる。
   一致しない、または改行を含むと判断した時点で、シェルコマンドを組み立てずに中止する
2. 一致した値だけを、推測されにくい区切り語のクォート付き HEREDOC（展開が起きない）で束縛する。
   区切り語は実行ごとにランダムな値にし、入力に含まれないことを手順 1 で確認済みの前提で使う
3. 束縛と同時に、入力が 1 行だけであることを検査する。`read -r` は先頭行しか取らず残りを黙って捨てるため、
   束縛後の値に改行は残らず、値に対する改行の検査は常に素通りする（検査として機能しない）。
   そこで 1 行目を読んだ後に 2 行目を読もうとし、読めた（= 2 行以上ある、空の 2 行目を含む）場合は
   `bind_ok=0` にして検証へ進まない。CR は `read -r` が除去しないため、束縛後の値に対する検査が有効に働く

```bash
# bash 3.2（macOS）と zsh の両方で動く。正規表現は変数に入れて unquoted で使う
# 束縛: クォート付き HEREDOC は展開を行わない（値に $ や ` や " があっても実行されない）
# 区切り語 ARG_EOF_7f3a9c は例。実行ごとに別のランダム値にし、入力に現れないことを事前に確かめる
# 2 行目が読めたら複数行入力として bind_ok=0 にする（1 行目しか束縛されず残りが捨てられるのを防ぐ）
bind_ok=1
{ IFS= read -r repo && ! IFS= read -r _extra; } <<'ARG_EOF_7f3a9c' || bind_ok=0
Fandhe-AI/my-repo
ARG_EOF_7f3a9c
{ IFS= read -r visibility && ! IFS= read -r _extra; } <<'ARG_EOF_7f3a9c' || bind_ok=0
public
ARG_EOF_7f3a9c

# 単一の組の検証。一括適用では組ごとに関数として呼ぶ。不正なら return 1 で当該組だけ除外して
# 次の組へ進む（exit 1 はシェルごと終了するため使わない）
validate_pair() {
  local repo="$1" visibility="$2" name
  local repo_re='^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'
  # CR は read -r が除去しないため、束縛後の値で検出できる（改行は束縛時の bind_ok で検査済み）
  case "${repo}${visibility}" in *$'\r'*) echo "不正な入力: CR を含む"; return 1 ;; esac
  if ! [[ "${repo}" =~ ${repo_re} ]]; then echo "不正な repo: 形式外"; return 1; fi
  name="${repo#*/}"
  case "${repo}" in -*) echo "不正な repo: 先頭が -"; return 1 ;; esac
  case "${name}" in .|..) echo "不正な repo: . / .. は不可"; return 1 ;; esac
  case "${visibility}" in public|private) ;; *) echo "不正な visibility"; return 1 ;; esac
}
# 一括適用の例: 組ごとに呼び、失敗した組だけ完了報告へ回して次へ進む
if [ "${bind_ok}" -ne 1 ]; then echo "除外: 複数行または空の入力"
elif ! validate_pair "${repo}" "${visibility}"; then echo "除外: 検証失敗"; fi
```

- 拒否する値: 余分な `/` を含む値、先頭が `-` の値（`gh` のオプションと取り違えられる）、
  リポジトリ名が `.` / `..` だけの値、空文字、空白・改行・`;` 等を含む値
- 大文字小文字の違いや末尾の空白・改行を暗黙に補正しない（補正せず拒否する）
- 実在確認: 形式検証を通った後に読み取りのみで確かめる

  ```bash
  gh api "repos/${repo}" --jq '{full_name, private, archived, admin: .permissions.admin}'
  ```

  - `full_name` が入力と一致すること
  - `private` が引数の visibility と整合すること（`public` なら false、`private` なら true）。
    不一致なら中止して報告し、勝手に補正しない
  - `admin == true` かつ `archived == false` であること（ruleset の作成・更新には admin 権限が必要で、
    archived は読み取り専用で変更できないため。満たさなければ後続 Step が必ず失敗する）
  - 取得失敗時は `gh api` のエラーが stdout に出るため終了コードだけで判断せず、
    HTTP status（403 / 404 等）を確認して「判定不能」として中止する。通過に倒さない
- 以降の Step で使う `repo` / `visibility` は、この検証を通った値だけにする。
  検証に失敗した場合は `gh` を含むコマンドを一切実行せず中止し、理由を報告する

### Step 1: ai-review の導入（未導入の場合のみ）

`.github/workflows/ai-review.yml` を wrapper として追加し、Fandhe-AI/actions の reusable workflow
`ai-review.yml` を **可変タグ `@latest`** で参照する（Fandhe-AI/actions の利用側規約。`latest` は main へ
自動追従するため、参照の更新作業は不要。commit SHA 固定・`@main` は使わない）。
旧 `codex-review.yml` は Fandhe-AI/actions から削除済みのため、新規導入では使わない。

- 既に `.github/workflows/ai-review.yml` がある場合はこの Step をスキップする
- 旧 `.github/workflows/codex-review.yml` が残っている場合は、`codex-review.yml@latest` が解決できず
  レビューが動かない状態になっている。Fandhe-AI/actions の `ai-review/README.md`「codex-review からの移行」の
  手順（入力名の対応表・required check 名の差し替え順序）に従って置き換える

wrapper は単一 provider テンプレートをコピーして作る（既定は `provider: codex`、ジョブ ID `codex`）。
取得元を commit SHA に固定し、配置前に構造検査を通す。テンプレートを ref 指定なし・無検証で配置すると、
取得元の改ざん・誤更新がそのまま対象リポジトリの workflow になるため。

- `@latest` を wrapper に残すのは Fandhe-AI/actions の組織規約として受容した残留リスクである
  （実行時の reusable workflow の内容は wrapper 側で固定しない）。本手順の固定取得と検査が塞ぐのは
  「wrapper ファイル自体の改ざん・誤配置」だけで、`latest` タグ自体の改ざんは検査と目視で補う限界がある
- 検査スクリプト（`scripts/verify-ai-review-wrapper.sh`）は allow-list 方式で、`uses:` が期待値と完全一致で
  ちょうど 1 件・特権トリガー無し・`run:` / `steps:` / `env:` 無し・`secrets: inherit` 無し・権限が
  `contents: read`（ジョブ側のみ加えて `pull-requests: write`）に限られ、両 permissions が欠落していないこと、
  `on:` 配下が `pull_request` のみであることを確かめる（親キーを追跡し、任意のジョブ名は `jobs:` 直下だけ許可）。
  構造は行の位置に依存しない状態機械で追い、ジョブの設定はジョブ ID の行より後ろ（現在のジョブ）でだけ受理して、そのジョブ自身が `uses`・権限・`with.provider` を揃えていることを確かめる（ジョブ ID を末尾へ移す等の並べ替えは不可）。
  値はキーごとに許可する文法へ完全一致させる（`with` の値は 1 行の plain scalar か全体を引用符で囲んだ文字列で、`: `・`#`・anchor・tag・flow 記法は不可。
  `types` / `branches` は `[a, b]` を要素に分割し、各要素の前後の空白だけを除いて許可語と完全一致、`types` は `opened` / `synchronize` / `reopened` が要素として揃うこと。空要素・要素内部の空白・重複は不可）。
  文字列が必要な位置（`name`・ジョブ ID・`concurrency.group`・`with` の文字列キー・`branches` の要素）では、引用符なしで書くと YAML が null・真偽値・数値・日付に解決する値（`null`・`~`・`true`・`yes`・`on`・`1`・`1_000`・`0x1F`・`1.5`・`.inf`・`2026-10-24` 等。YAML 1.1 と 1.2 の和集合）を拒否する。
  `with` の値は引用符で囲めば文字列として許可する（`runner: "yes"`）。`branches` の要素は引用符つきに未対応のため、数字だけ・日付形のブランチ名は許可リスト更新の対象にする。
  `concurrency` は任意だが、あるときは `group` を必須とする。ファイル内容は出力しない

```bash
tmp="$(mktemp -d)" || exit 1
trap 'rm -rf "${tmp}"' EXIT
# latest を commit SHA に解決（取得中にタグが動いても同じ commit を使う）
sha="$(gh api repos/Fandhe-AI/actions/commits/latest --jq .sha)" || exit 1
printf '%s' "${sha}" | grep -Eq '^[0-9a-f]{40}$' || { echo "SHA の形式が不正のため中止"; exit 1; }
# gh api はエラー本文も stdout へ出すため、成否は終了コードで判定する
gh api --method GET -H 'Accept: application/vnd.github.raw' -f ref="${sha}" \
  repos/Fandhe-AI/actions/contents/ai-review/templates/ai-review.single.yml \
  > "${tmp}/ai-review.yml" || { echo "取得失敗のため中止"; exit 1; }
# 構造検査（不合格なら配置しない。<skill-dir> はこのスキルのディレクトリ）
bash <skill-dir>/scripts/verify-ai-review-wrapper.sh "${tmp}/ai-review.yml" || exit 1
mkdir -p .github/workflows
cp "${tmp}/ai-review.yml" .github/workflows/ai-review.yml
echo "取得元: Fandhe-AI/actions@${sha}"
```

- 配置後は `cat .github/workflows/ai-review.yml` で全文を目視確認し、コミット本文に
  `取得元: Fandhe-AI/actions@<上で出力した SHA>` を記録する
- 検査が不合格のときは配置せず、取得内容を目視で確かめる。上流の正当な変更なら、先に
  `verify-ai-review-wrapper.sh` の許可リストを更新する PR を出す（検査を緩めて通さない）

- 書き方・適用条件（fork PR 拒否・sudo なし runner 等）は Fandhe-AI/actions の `ai-review/README.md` と
  `ai-review/docs/runner-exception.md`、既存導入リポジトリ（fandhe-frontend 等）の wrapper を参照して揃える
- runner 方針: CI ジョブは public なら ubuntu ホステッド、private なら self-hosted。
  ai-review の review ジョブ（`runner`。codex の既定は self-hosted の `codex` ラベル）のみ専用 runner の例外。
  `preflight` / `post_feedback`（`post-feedback-runner`）は資格情報に触れず、既定で可視性に応じて
  自動切替する（public は `ubuntu-latest`、private は `self-hosted`）ため、明示指定は不要
- 資格情報: `CODEX_HOME_DIR` は org 単位の Actions variable（visibility: all）として設定済みのため、リポジトリには設定しない。
  `gh api orgs/Fandhe-AI/actions/variables --jq '.variables[].name'` で存在を確認し、無い場合（他 org 等）は
  `ai-review/README.md`「セットアップ」手順 3 に従ってリポジトリへ設定する
- `update-external` の日次同期 PR（`chore/skills-update-*` / `chore/submodule-update-*`）がある場合は
  `skip-branch-prefixes: chore/skills-update-,chore/submodule-update-` を指定する。push できる主体は
  ブランチ名で gate を回避できる受容済み残留リスクがある（`ai-review/README.md`
  「`skip-branch-prefixes` の受容済み残留リスク」）ため、**指定する前に受容条件を確認する**:
  - 確認手順（読み取りのみ。`permission` で絞らず全件取得し、各主体の `role_name` / `permissions` で判定する）:
    - 個人: `gh api "repos/${repo}/collaborators?affiliation=all" --paginate --jq '.[] | {login, role_name, permissions}'`
      で全件取得し、`role_name` が `write` / `maintain` / `admin`（または `permissions.push == true`）の主体を write 以上とみなす。
      `affiliation=all` は組織メンバー・チーム経由の権限も返すため、outside collaborator は
      `affiliation=outside` で別途列挙して第三者の有無を確認する
    - チーム: `gh api "repos/${repo}/teams" --paginate --jq '.[] | {slug, permission}'` で、
      `permission` が `push` / `maintain` / `admin` のチームを列挙し、メンバーが信頼済み主体だけか確認する
    - fork 経路: `gh api "repos/${repo}" --jq '{fork, allow_forking}'` と
      `gh api "repos/${repo}/forks" --paginate --jq '.[].full_name'` で外部 fork の有無を確認する
  - 受容してよい条件（すべて満たすこと）: write 以上の権限者が org 内の信頼済み主体に限られる／
    skip 対象の prefix が `chore/skills-update-` と `chore/submodule-update-` に限られる／
    該当ブランチの PR が update-external の自動生成に限られる
  - 受容しない条件（1 つでも当たれば指定しない）: 第三者の write コラボレーターや outside collaborator がいる／
    fork からの外部 push 経路がある／確認結果を取得できない（判定不能は受容に倒さない）
  - 受容しない場合の代替: `skip-branch-prefixes` を指定せず、同期 PR にも通常どおり ai-review を走らせる。
    同期 PR の負荷が問題なら別対策として Issue 化をユーザーに提案する（ruleset のブランチ名ルール制限は
    本スキルの範囲外。提案にとどめる）
  - 確認結果と判断（受容した／しなかった、根拠）を完了報告に 1 行で記録する
- `collaborators-only`（write 未満の actor のイベントでは `preflight` を失敗させる）は既定の `true` のまま使う
- 資格情報が使えない間は review ジョブが `skipped` になり、workflow 全体では成功に見える。
  導入 PR では必ずジョブ単位で `review` が実行されたことを確認する（下記「検証」）

### Step 2: AGENTS.md（AI レビューの観点集）の追加

ai-review は **PR の base コミットの AGENTS.md** をリポジトリ固有のレビュー基準として読む。
リポジトリルートに日本語で新規作成する（既存があれば基準を弱めず不足観点を追記する）。

必須 3 観点を、必ず**対象リポジトリ固有の具体項目**に落とし込んで書く（別リポジトリ用の記述を流用しない）:

1. **セキュリティ観点**: 秘密情報混入・インジェクション・依存監査・権限最小化など、リポジトリの実態に即して
2. **アーキテクチャ・設計整合の観点**: CLAUDE.md・設計文書の責務境界・規約整合
3. **再利用・アセット化の観点**: 汎用実装の分離・ハードコード回避・転用容易性・ドキュメント整備

加えて:

- CLAUDE.md / `.claude/rules/` / 設計文書から抽出したリポジトリ固有観点を整理する
- 重大度区分 P0（マージブロック）/ P1（強く推奨）/ P2（提案）を付け、**P1 の定義は CI ゲートの実挙動
  （ai-review の `block-priorities` 既定 `P0,P1` により review ジョブは P1 でも fail する）と矛盾させない**
- カスタム prompt（`.github/ai-review/prompts/review.md`）が既にある場合は二重管理を避ける:
  観点の正は AGENTS.md、enforcement（完了判定・機械格上げ）の正は review.md という役割分担にし、
  review.md へは AGENTS.md 読み取りの最小追記のみ行う。旧パス `.github/codex/prompts/review.md` に
  置いたままの場合は `.github/ai-review/prompts/review.md` へ移す（または `prompt-path` で旧パスを明示する）
- 参考実例: fandhe-backend / fandhe-frontend / Fandhe-AI/actions / agent-cli-skills の AGENTS.md
- 注意: 新基準はマージ後の**次の PR から**実効（base 参照仕様）

### Step 3: CI 必須チェックの集約ジョブ整備

複数ジョブを持つ workflow には集約ジョブ（`ci-complete` 等）を追加する:
全ジョブを `needs:` に列挙し、`if: always()` を付け、`toJSON(needs)` を jq で判定する。

- **fail-closed を厳守**: `skipped` の許容は「条件付きジョブ（`if:` を持つジョブ）」の**明示リストに限定**し、
  他ジョブは success のみ受理する（skipped 全許容は fail-open として AI レビューに P1 指摘される）。
  change detection ゲートがある場合はゲート出力に基づき「skip が正しい状況」でのみ skipped を受理する
- 集約ジョブには `permissions: {}` を付け、「ジョブ追加時は needs への追加が必要」のコメントを書く
- Fandhe-AI/actions の reusable workflow（lint-docs 等）を使っている場合、集約ジョブ
  （`lint-docs / lint-docs-complete` 等）が入った SHA まで参照をバンプすればチェック 1 件に集約できる
- YAML の `name:` に ` #` や「: 」を含む場合は必ずクォートする（未クォートだと API 報告名が途中で切れ、
  必須チェック名として不安定になる）

### Step 4: branch protection / リポジトリ設定（GitHub API のみ、コミット不要）

Step 4 の書き込み系呼び出し（PATCH / PUT / POST / DELETE）は、**4.1 退避 → 4.2 差分提示と明示承認 → 4.3 適用**
の順を必ず踏む。承認が得られない場合は何も変更せず中止する（fail-closed）。誤適用したときは 4.4 で戻す。
`PUT /rulesets/{id}` は `required_status_checks.parameters` を丸ごと置換し、`integration_id` 束縛などが
黙って脱落し得るため、現在値の保存と差分の確認なしに送らない。

#### 4.1 退避（変更前の現在値を作業ツリーの外へ保存）

- 保存先は `mktemp -d` が返す絶対パスのディレクトリにする。対象リポジトリの作業ツリー内・`.claude/` 配下には
  置かない（誤コミット防止）。`chmod 700` を付け、パスを利用者へ表示して復旧まで保持する旨を伝える。
  複数リポジトリの一括適用ではリポジトリごとに別ディレクトリにする
- リポジトリ名は `owner/repo` 形式を検証してから使う
- 退避対象（取得は 1 件ごとに成否を確認し、存在判定は終了コードではなく HTTP status で行う。`gh api` のエラー本文は stdout に出る）:
  - 全 branch ruleset: 一覧と、各 ruleset の詳細 JSON（`Repository` は `repos/{repo}/rulesets/{id}`、`Organization` は
    読み取りのみ。org 継承 ruleset はリポジトリ側 API で変更しない）。tag ruleset を扱う場合はその一覧と詳細も
  - リポジトリ本体: `GET repos/{repo}` の `allow_squash_merge` / `allow_merge_commit` / `allow_rebase_merge` /
    `delete_branch_on_merge` / `allow_auto_merge` / `squash_merge_commit_title` / `squash_merge_commit_message` /
    `has_wiki` / `has_projects` / `allow_forking` / `security_and_analysis`
  - Actions 権限: `GET repos/{repo}/actions/permissions` と `GET repos/{repo}/actions/permissions/workflow`
  - Dependabot alerts（`vulnerability-alerts`）: HTTP status で有効 / 無効を記録する（204 = 有効 / 404 = 無効）
  - automated security fixes・private vulnerability reporting: 有効でも無効でも 200 と `{"enabled": bool}` を返すため、
    status では判別できない。本文の `enabled` を JSON として退避する
- 取得失敗（403 / 404 以外の異常を含む）は「未取得」と明示し、未取得の項目は変更しない。取得失敗を「現在値なし」に倒して
  新規作成・上書きしない（判定不能を green に倒さない方針と同じ）
- 退避の完了条件は「ruleset 一覧を全ページ取得（`--paginate --slurp` + `jq 'add'`）して単一配列に統合できた」かつ「取得に成功した全 `*.json` が `jq -e .` で JSON として妥当」かつ「ruleset 一覧にある Repository ruleset の全 id の詳細が退避済み」であること。未取得 id が 1 件でもあれば列挙して 4.2 へ進まない（ゲート。その ruleset は変更しない）。取得失敗時は壊れたファイル（空・エラー本文）を残さず、そのファイルは「未取得」として扱う（4.2 の差分・4.4 の復旧の入力に使わない）
- Bash ツールは呼び出しをまたいでシェル変数を保持しない。4.1 から 4.4 を複数回の呼び出しに分けるときは、各呼び出しの先頭で `repo` と `backup`（4.1 で表示した絶対パス）を再束縛し、`[ -d "${backup}" ]` を確認してから使う（空の変数のまま実行しない）
- 退避した JSON の件数と sha256 を表示し、保存を確認してから 4.2 へ進む。保存先のパスと内容は PR 本文・コミット・ログへ貼らない（要約のみ）

```bash
repo="Fandhe-AI/<REPO>"
case "${repo}" in */*) ;; *) echo "repo は owner/repo 形式" >&2; exit 1 ;; esac
backup="$(mktemp -d)" && chmod 700 "${backup}" && echo "退避先: ${backup}"
# gh api は HTTP エラー本文を stdout に出すため、直接リダイレクトせず一時ファイルへ書く。
# 成功（終了コード 0）かつ jq -e . で JSON として妥当なときだけ mv し、失敗時は一時ファイルを消して退避ファイルを残さない
fetch_json() {  # fetch_json <出力ファイル名> <gh api の引数...>
  out="${backup}/$1"; shift
  if gh api "$@" > "${out}.tmp" 2>/dev/null && jq -e . "${out}.tmp" > /dev/null 2>&1; then
    mv "${out}.tmp" "${out}"
  else
    rm -f "${out}.tmp"; echo "未取得: ${out##*/}（変更しない）" >&2; return 1
  fi
}
# ruleset 一覧は既定では最初のページしか返らない。--paginate --slurp で全ページを配列の配列として取り、jq 'add' で単一配列へ統合する。
# gh の終了コードは jq と切り離して独立に確認する（パイプだと pipefail 無しでは末尾の jq の終了コードしか見えず、gh が失敗して無出力でも空の一覧が保存される）。
# 1) gh の出力を一時ファイルへ取得し、gh が 0 以外・空出力なら未取得として止める
# 2) 取得した JSON を統合し、配列であることを検証できたときだけ rulesets.json として確定する
# 後段の詳細取得と完了判定は、この統合済みの rulesets.json だけを使う
raw="${backup}/rulesets.raw.tmp"
if gh api --paginate --slurp "repos/${repo}/rulesets" > "${raw}" 2>/dev/null \
   && [ -s "${raw}" ] \
   && jq -e 'add // [] | if type == "array" then . else error("not array") end' "${raw}" > "${backup}/rulesets.json.tmp" 2>/dev/null; then
  mv "${backup}/rulesets.json.tmp" "${backup}/rulesets.json"
  rm -f "${raw}"
else
  rm -f "${raw}" "${backup}/rulesets.json.tmp"; echo "退避失敗: ruleset 一覧（全ページ取得不可）" >&2; exit 1
fi
echo "ruleset 一覧: $(jq 'length' "${backup}/rulesets.json") 件（0 件なら新規作成のみ。既存を変更する前提にしない）"
jq -r '.[] | select(.source_type == "Repository") | .id' "${backup}/rulesets.json" |
while read -r id; do
  fetch_json "ruleset-${id}.json" "repos/${repo}/rulesets/${id}"
done
# ゲート: 一覧にある Repository ruleset の詳細が全件退避されたこと（未取得 id があれば 4.2 へ進まない）
missing=0
for id in $(jq -r '.[] | select(.source_type == "Repository") | .id' "${backup}/rulesets.json"); do
  [ -s "${backup}/ruleset-${id}.json" ] || { echo "未退避の ruleset id: ${id}（変更しない）" >&2; missing=1; }
done
[ "${missing}" -eq 0 ] || { echo "退避未完了: 4.2 へ進まない" >&2; exit 1; }
fetch_json repo.json "repos/${repo}" --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge, allow_auto_merge, squash_merge_commit_title, squash_merge_commit_message, has_wiki, has_projects, allow_forking, security_and_analysis}'
fetch_json actions-workflow.json "repos/${repo}/actions/permissions/workflow"
fetch_json actions.json "repos/${repo}/actions/permissions"
code="$(gh api -i "repos/${repo}/vulnerability-alerts" 2>/dev/null | awk 'NR==1{print $2}')"
printf '%s\n' "${code:-unknown}" > "${backup}/vulnerability-alerts.status"   # 204 = 有効 / 404 = 無効 / 他 = 判定不能（変更しない）
# この 2 つは status ではなく本文の {"enabled": bool} で判別する
fetch_json automated-security-fixes.json "repos/${repo}/automated-security-fixes"
fetch_json private-vulnerability-reporting.json "repos/${repo}/private-vulnerability-reporting"
# 完了条件: 退避された *.json がすべて JSON として妥当であること
for f in "${backup}"/*.json; do jq -e . "${f}" > /dev/null || echo "不正な退避: ${f##*/}（変更しない）" >&2; done
(cd "${backup}" && ls -1 && shasum -a 256 -- * )
```

#### 4.2 差分提示と明示承認

- 適用予定の本文（PUT / PATCH / POST の body）を退避先と同じディレクトリの一時ファイルに作り、現在値との差分を
  `jq -S` で正規化した JSON 同士の `diff` で提示する（キー順の差を無視する）
- 最低限、次の増減を明示する: `required_status_checks` の `context` 一覧と各エントリの `integration_id` の有無（脱落）/
  `strict_required_status_checks_policy` / `bypass_actors` の件数 / `enforcement` / `required_review_thread_resolution` /
  `allowed_merge_methods`
- 新規作成（POST）で現在値が無い場合は「新規作成」と明記し、復旧は DELETE であることを併記する

```bash
diff <(jq -S . "${backup}/ruleset-<ID>.json") <(jq -S . "${backup}/ruleset-<ID>.new.json")
# integration_id の脱落を直接確認（現在値で束縛済みの context のうち、新 body で束縛が無くなったものを列挙）
jq -rn --slurpfile a "${backup}/ruleset-<ID>.json" --slurpfile b "${backup}/ruleset-<ID>.new.json" '
  def bound($x): [$x.rules[]? | select(.type=="required_status_checks") | .parameters.required_status_checks[]? | select(.integration_id != null) | .context];
  (bound($a[0]) - bound($b[0]))[]'
```

- 利用者へ「適用してよいか」を尋ね、肯定の明示返答を得てから 4.3 へ進む。無返答・曖昧な返答・質問できない自動運転環境では
  適用せず、差分と退避先を報告して停止する
- 承認はそのリポジトリの、その差分 1 回分に限る。差分が変わったら再提示して再承認を得る。一括適用でもリポジトリごとに承認を取る
- 承認を事実以上に記述しない。得ていない承認を完了報告・PR 本文に「承認済み」と書かない

#### 4.3 適用（4.2 で承認された差分の範囲でのみ実行）

ruleset を更新する PUT は、4.1 で退避した JSON の `required_status_checks` 等の必要箇所だけを差し替えた body を
`--input <file>` で送る（丸ごと新規構築しない・本文を文字列連結しない）。適用後は直ちに下記「検証」の
Step 4-a / 4-b スイープを実行し、崩れていたら 4.4 で戻す。新規作成した ruleset の id・変更項目一覧・退避先パスを
完了報告に記録する。

- マージ設定（`gh api -X PATCH repos/...`）: squash のみ（merge commit / rebase 禁止）、
  マージ後ブランチ自動削除、auto-merge 許可、squash タイトル = PR_TITLE / 本文 = PR_BODY
- ruleset `main-protection`（target: branch、`~DEFAULT_BRANCH`、enforcement: active、bypass_actors 空）:
  - deletion 禁止 / non_fast_forward（force push 禁止）
  - pull_request: required_approving_review_count 0（人間 approver 不在の AI 運用。レビューゲートは
    ai-review の必須チェックで担保）・required_review_thread_resolution true・allowed_merge_methods ["squash"]
    - **0 承認では ai-review の必須チェックが唯一のレビューゲートになる**。これは設計上の受容事項であり、
      次の条件をすべて満たすリポジトリでのみ適用する（strict false の規定とは独立の論点）:
      人間 approver 不在の運用を意図している／必須チェックに `preflight`・`review`・`post_feedback`
      （または `ai-review-gate`）が入っている／`collaborators-only` が既定の `true`／bypass_actors が空
    - 適用後（下記「検証」）に `review` ジョブが実際に実行されたことを確認する（適用前には確認できないため、
      条件ではなく適用後の事後確認として扱う）。確認できない、または skipped のままなら、受容条件を満たさない
      ものとして `required_approving_review_count` を 1 以上へ是正する。**この是正も ruleset の書き込みであり、
      4.4（復旧）とは別物**（4.4 は退避した元の値へ戻す操作で、既存の 0 承認 ruleset では 0 に戻るだけで是正にならない）。
      したがって 4.1（是正前の現在値を再度退避）→ 4.2（`jq -S` 差分の提示と明示承認）→ 4.3（GET した ruleset JSON の
      `pull_request` ルールの `required_approving_review_count` だけを差し替えて `--input <file>` で PUT する。
      `required_status_checks` の `integration_id` 束縛を含む他フィールドを保持し、素朴な PUT をしない）の順に通し、
      適用後に `.claude/rules/ruleset-policy.md` の 3 軸 + classic BP 検証（下記 Step 4-a / 4-b）を実行する。
      承認が得られない場合は書き込まず、受容不可として完了報告に記録して停止する
      適用から確認までの間は `review` ジョブがまだ動いておらず、レビューゲートなしでマージできる窓が残る。
      この間は PR をマージしない（確認を済ませるまで自動マージも走らせない）
    - 条件を満たさない場合の代替: `required_approving_review_count` を 1 以上にする（可能なら CODEOWNERS と併用）。
      approver がいない単独運用ではマージが止まり、人間 approve を前提としない `implement-issue-tree` の
      自動マージも止まり得るため、運用者に確認してから設定する
  - required_status_checks（**strict false は必須**。true にすると 1 件マージするたびに他の open PR の
    base が陳腐化し、implement-issue-tree の並列ランが収束しなくなる。strict は鮮度制御であって
    bypass 不能性の制御ではないため、false でもクライアント側自動マージの G0 は通過する。
    実行環境に `.claude/rules/ruleset-policy.md` が存在する場合はそちらの詳細に従う）: 必須集合は
    `autoMerge` を使うかどうかで変わる（下記「必須チェック選定の注意」参照）。使わない場合は
    **[<集約ジョブ>, （集約できない別 workflow の常時チェック）, ai-review の 3 チェック]** の最小集合、
    使う場合は PR HEAD へ報告される全 context。ai-review の 3 チェックはジョブ ID が先頭になる
    `<job> / preflight`・`<job> / review`・`<job> / post_feedback`（テンプレート既定なら `codex / preflight` 等。
    複数モデル構成ではテンプレート同梱の集約 gate `ai-review-gate` 1 件でもよい）。個別ジョブを登録する場合は
    **`preflight` を必ず含める**: actor 判定等で `preflight` が失敗すると後続が skipped になり、skipped は
    required check を満たしてしまう（`ai-review-gate` は reviewer の `preflight` 失敗で自身も失敗するため、
    gate 1 件で登録する場合は個別の `preflight` を追加しなくてよい）
  - 自動マージ（implement-issue-tree の `autoMerge: true`）を使う場合、required_status_checks の
    各エントリに発行元 App の `integration_id` を束縛する（未束縛だと G0 が `issuer-unbound` で辞退する）。
    **ruleset を PUT で更新した後は必ず下記「検証」の 3 軸スイープを実行する**（`PUT` は
    `required_status_checks.parameters` を丸ごと置換するため束縛が落ち得る。複数リポへ一括適用する
    場合は全リポで実行する）
- 必須チェック選定の注意（重要な落とし穴）:
  - 直近 PR の check runs で「**常に報告される**」チェックのみ選ぶ。workflow レベル paths フィルタで
    実行されないことがあるチェックは入れない（マージが永久ブロックされる）。ジョブレベル条件の skipped は可
  - **autoMerge を使わない場合**: Cursor Bugbot 等の外部アプリは必須にしない。
  - **`autoMerge: true`（implement-issue-tree）を使う場合**: 上記の除外は適用しない。
    `implement-issue-tree` の autoMerge G0 は「PR HEAD 上の check-run / commit status のうち
    required_status_checks に含まれない context が 0 件であること」を合格条件にする
    （`skills/implement-issue-tree/references/automerge-design.md` の G0 (d)/(f)/(g)）。
    外部アプリを required から外すと、その context が G0 (f) に「required でない context」として
    検出され `server-enforcement-missing` で辞退し、自動マージが構造的に成立しない。
    `args.externalChecks` で宣言した外部 App の context と ai-review workflow の全ジョブ
    （`preflight` / `review` / `post_feedback`）を含め、**PR HEAD へ報告される全 context**
    を required に列挙し、外部 App の required エントリは発行元 App の ID（ruleset は
    `integration_id`）で束縛する。commit status は App 束縛（`integration_id`）を持てないため、
    束縛不能な commit-status 専用チェックしか発行しない外部プロバイダは autoMerge と併用できない
    （G0 (g) の帰結）。paths フィルタで実行されないことがあるチェックを必須化できない制約と
    両立させるには、条件は workflow の `on.pull_request.paths` ではなくジョブレベル `if:` に寄せ、
    check-run 自体は常に報告させる（skipped も可）実装パターンを使う（実例:
    `Fandhe-AI/fandhe-frontend` の `musl-smoke.yml` / `image-size.yml` の「Detect relevant changes」
    ステップ。同リポの `.claude/rules/ci.md`「`ci-complete` 集約ジョブと ruleset 必須チェック」節
    〔イシュー #2325〕も、外部チェックを required から外さない運用を採用している）。
  - **チェック名が変わる PR をマージするときは、マージ前に ruleset を新チェック名へ PUT で置換する**
    （旧名のままだと CI 全 pass でも「Expected」のまま BLOCKED になる）。PUT は GET した JSON の
    required_status_checks のみ差し替えて送る
- 追加ガード: secret scanning + push protection / Dependabot alerts + automated security fixes /
  （public なら）private vulnerability reporting / タグ運用があれば tag ruleset（deletion・non_fast_forward）/
  GITHUB_TOKEN 既定権限 read 化（**全 workflow の permissions: 明示を確認してから**）/
  Actions の PR 作成・承認許可は自動 PR 運用（update-external 等）が無ければ false /
  （private なら）forking 禁止 / 未使用の wiki・projects 無効化
- プラン制限（403/422）に当たった項目は「ユーザー操作が必要」として記録し、他を続行する

#### 4.4 復旧（退避した JSON で元に戻す）

復旧自体も書き込みなので、実行前に復旧内容を利用者へ提示して承認を得る。復旧に失敗した項目は握りつぶさず報告する。

- 既存 ruleset の復旧: 退避した詳細 JSON から PUT 可能なフィールド（`name` / `target` / `enforcement` / `bypass_actors` /
  `conditions` / `rules`）だけを抽出し、`PUT repos/{repo}/rulesets/{id}` へ `--input` で送る。読み取り専用フィールド
  （`id` / `source` / `source_type` / `node_id` / `_links` / `created_at` / `updated_at` / `current_user_can_bypass`）は送らない。
  復旧後は 3 軸スイープで退避時点と同じ値（strict / bypass / `integration_id` / total）に戻ったことを実測する
- 新規作成した ruleset の復旧: 記録した id のみ `DELETE repos/{repo}/rulesets/{id}`（他の ruleset は触らない）
- リポジトリ本体: 退避した値のうち変更した項目だけを `PATCH repos/{repo}` で戻す
- 追加ガード: 退避時の状態へ対応する API で戻す（Dependabot alerts / automated security fixes / private vulnerability
  reporting は `PUT` / `DELETE`、Actions 権限は `PUT actions/permissions/workflow`、secret scanning / push protection は
  `security_and_analysis` の PATCH）
- 退避ディレクトリは復旧不要と確認できるまで削除しない。削除は自分が `mktemp -d` で作ったものだけに限る

```bash
jq '{name, target, enforcement, bypass_actors, conditions, rules}' "${backup}/ruleset-<ID>.json" > "${backup}/ruleset-<ID>.restore.json" \
  && gh api -X PUT "repos/${repo}/rulesets/<ID>" --input "${backup}/ruleset-<ID>.restore.json"
```

## 検証

各 Step の完了は以下で確認する:

```bash
repo="Fandhe-AI/<REPO>"   # Step 0 の検証を通過した値のみ
# Step 1: wrapper の存在と @latest 参照（@main・旧 codex-review.yml が残っていないこと）
grep -n "uses: Fandhe-AI/actions" .github/workflows/ai-review.yml
# Step 1: 配置済み wrapper が構造検査（uses 1 件・特権トリガー無し・権限最小）に合格すること
bash <skill-dir>/scripts/verify-ai-review-wrapper.sh .github/workflows/ai-review.yml
test ! -e .github/workflows/codex-review.yml && echo "旧 wrapper なし"
# Step 1: 直近 run でジョブ単位に review が実行されたこと（skipped は「workflow 成功」に見える）
# head_branch は検証対象の PR（導入 PR 等）の head ブランチ名
run_id=$(gh run list --repo "${repo}" --workflow "AI PR review" --event pull_request --branch "${head_branch}" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "${run_id}" --repo "${repo}" --json jobs --jq '.jobs[] | {name, status, conclusion}'
# Step 2: AGENTS.md の存在と P0/P1/P2 定義
grep -n "P0\|P1\|P2" AGENTS.md | head
# Step 3: 直近 PR の check runs で集約ジョブが報告されること
gh pr checks "$(gh pr list --repo "${repo}" --state merged --limit 1 --json number --jq '.[0].number')" --repo "${repo}"
# Step 4: 退避ファイルの存在と件数（4.1）
ls -1 "${backup}" | wc -l
# Step 4: 適用後の ruleset が承認済みの差分と一致すること（4.2 の新 body と現在値を jq -S で比較し、差分が空であること）
# Step 4: ruleset とマージ設定
gh api "repos/${repo}/rulesets" --jq '.[] | {id, name, enforcement}'
gh api "repos/${repo}" --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge, allow_auto_merge}'

# Step 4-a: 一括更新後の 3 軸スイープ（strict / bypass_actors / integration_id 残存）
# PUT した ruleset 単体ではなく branch target の全 ruleset を掃く（org 継承は source_type でルーティング）。
# コマンド全文・判定表は実行環境に .claude/rules/ruleset-policy.md があれば「一括更新後の検証」節を参照。
# 無ければ下記 Step 4-a/4-b のコマンド・判定表をそのまま用いる
org="${repo%%/*}"
gh api --paginate --slurp "repos/${repo}/rulesets" |
  jq -r 'add // [] | .[] | select(.target == "branch") | [(.id|tostring), .name, (.source_type // "unknown")] | @tsv' |
while IFS=$'\t' read -r id name src; do
  case "${src}" in
    Repository)   path="repos/${repo}/rulesets/${id}" ;;
    Organization) path="orgs/${org}/rulesets/${id}" ;;
    *)            echo "UNKNOWN source_type: ${name} (${src}) — 手動確認"; continue ;;
  esac
  gh api "${path}" --jq '{
    name: .name, enforcement: .enforcement, bypass: (.bypass_actors | length),
    strict: ([.rules[]? | select(.type=="required_status_checks") | .parameters.strict_required_status_checks_policy] | first),
    total:   ([.rules[]? | select(.type=="required_status_checks") | .parameters.required_status_checks[]?] | length),
    unbound: [.rules[]? | select(.type=="required_status_checks") | .parameters.required_status_checks[]? | select(.integration_id == null) | .context]
  }'
done

# Step 4-b: classic branch protection を別枠で掃く（defaultBranchRef 解決・@uri エンコード・HTTP status 分岐）
db=$(gh repo view "${repo}" --json defaultBranchRef --jq '.defaultBranchRef.name')
db_enc=$(printf '%s' "${db}" | jq -sRr '@uri')
code=$(gh api -i "repos/${repo}/branches/${db_enc}/protection" 2>/dev/null | awk 'NR==1{print $2}')
case "${code}" in
  200) gh api "repos/${repo}/branches/${db_enc}/protection" --jq \
         '{strict: (.required_status_checks.strict // "none"), unbound: [.required_status_checks.checks[]? | select(.app_id == null) | .context]}' ;;
  404) echo "classic BP なし（${db}）" ;;
  *)   echo "判定不能 (HTTP ${code:-?}) — Administration: read 権限を確認。green と扱わない" ;;
esac
```

最終確認として、導入後に小さな PR を 1 件流し、ai-review の実行・必須チェックの報告・
squash merge のみ許可・スレッド resolve 必須が実際に効いていることを観察する。

## 完了報告

Step ごとの PR 番号、AGENTS.md の観点構成、ruleset の最終必須チェック一覧、適用できなかった項目
（理由付き）、退避先パス（内容は貼らない）、承認の有無（得た場合のみ事実どおりに記載）を表でまとめて報告する。
受容判断の記録欄として、`skip-branch-prefixes`（指定した／しなかった、write 権限者の確認結果）と
`required_approving_review_count 0`（受容した／1 以上にした、根拠）を各 1 行で含める。
Step 0 で拒否した引数があれば理由付きで載せる。

## よくある失敗

| 問題 | 回避策 |
|------|--------|
| 集約ジョブの skipped 全許容が fail-open として AI レビューに P1 指摘される | Step 3: skipped 許容を条件付きジョブの明示リストに限定する |
| チェック名変更 PR が CI 全 pass でも BLOCKED（ruleset が旧名のまま「Expected」待ち） | Step 4: マージ前に ruleset を新チェック名へ PUT で置換する |
| 未クォート `name:` の ` #` 以降が切れて API 報告名が不安定になる | Step 3: name に ` #` や「: 」を含む場合はクォート必須 |
| paths フィルタ付き workflow のチェックを必須にするとマージが永久ブロックされる | Step 4: 常に報告されるチェックのみ必須化する |
| 参考ファイルの取り違え（別リポジトリ用 AGENTS.md の混入）を AI レビューが検出 | Step 2: 対象リポジトリ固有の具体項目に落とし込む |
| AGENTS.md の P1 定義と CI ゲート実挙動（P1 でも fail）の矛盾を AI レビューが指摘 | Step 2: P1 定義をゲート実挙動と矛盾させない |
| GITHUB_TOKEN read 化で暗黙 write 依存の workflow が壊れる | Step 4: 全 workflow の permissions 明示を確認してから適用する |
| ruleset を PUT したら `integration_id` 束縛が落ち、自動マージが静かに止まる（strict と bypass だけ見ると全 green に見える） | Step 4-a: PUT 後に 3 軸スイープ（`select(.integration_id==null)`）を実行する |
| 旧 ruleset / classic BP の掃き漏らしで未束縛・strict=true が残る | Step 4-a/4-b: 全 branch ruleset を列挙して掃き、classic BP は `defaultBranchRef` 解決 + status 分岐で別枠確認する |
| AGENTS.md に自動マージの G0 契約を書く際 strict を要件として列挙し、実装より強い契約が AI レビューの P0 の根拠になる | Step 2: G0 契約を書くなら strict は「意図的な非要件」と明記する（実行環境に `.claude/rules/ruleset-policy.md` があれば参照） |
| autoMerge 運用で外部アプリ・post_feedback 等を required から外すと G0 (f) が server-enforcement-missing で辞退し自動マージが静かに恒久停止する | Step 4: autoMerge を使う場合は PR HEAD の全 context を required に列挙する（外部アプリ・ai-review の全ジョブを含む） |
| ai-review テンプレートを ref 指定なし・無検証で配置し、取得元の改ざん・誤更新がそのまま workflow になる | Step 1: `latest` を commit SHA に解決して固定取得し、`verify-ai-review-wrapper.sh` と `cat` の目視を通してから配置する |
| 旧 `codex-review.yml` wrapper を新規導入する・残したままにする（Fandhe-AI/actions から削除済みで workflow を解決できない） | Step 1: `ai-review/templates/ai-review.single.yml` から導入し、旧 wrapper は「codex-review からの移行」で置き換える |
| ai-review の `preflight` を required から外し、actor 判定の失敗で review が skipped のまま必須チェックを満たす | Step 4: `<job> / preflight` を必ず required に含める |
| 資格情報未設定で review が skipped なのに workflow 全体の成功を見て導入完了とする | 検証: `gh run view --json jobs` でジョブ単位に `review` の実行を確認する |
| 引数を検証せず `gh api` のパスや分岐に渡す | Step 0: 許可リスト検証と実在確認を `gh` 実行前に行う |
| 第三者 write ありのリポジトリで `skip-branch-prefixes` を指定し、ブランチ名でレビューを回避される | Step 1: write 権限者を列挙して受容条件を確認し、満たさなければ指定しない |
| 0 承認の受容条件を確認せずに適用し、ai-review が唯一のゲートなのに `review` が動いていない | Step 4.3: 受容条件を確認し、満たさなければ 1 以上にする。適用後に `review` が動かなければ 4.1 → 4.2 → 4.3 を通して是正する（4.4 の復旧では是正にならない） |
| 現在値を保存せずに PUT し、`integration_id` の脱落・設定項目の消失に気づけず復旧できない | Step 4.1: 変更前に作業ツリー外へ退避する |
| 差分を示さず承認なしで適用する | Step 4.2: 差分提示と明示承認を取り、得られなければ停止する |
| 退避ファイルを作業ツリー内に置いてコミットしてしまう | Step 4.1: 作業ツリー外の `mktemp -d` に保存する |
| 取得失敗を「現在値なし」として扱い、誤って新規作成・上書きする | Step 4.1: 取得失敗は未取得とし、その項目は変更しない |

## 注意事項

- コミットは日本語 Conventional Commits 形式で作成し、対象リポジトリのコミット規約・フッター運用に従う。`--no-verify` は使用しない
- シェル変数は `"${var}"` 形式でクォートする
- Step 0 の検証を通っていない値を `gh` に渡さない
- 承認を得るまで Step 4 の書き込み系 API を実行しない。自動運転などで承認を取れない場合は適用せず停止する
- AI レビューの指摘が正当なら修正で応える（テスト・ゲートの弱体化やスキップでごまかさない）。
  スレッドへ対応内容を返信して resolve してからマージする
- スコープ外の発見は Issue 化をユーザーに提案する（勝手に起票しない）
- このスキルはネットワーク越しの GitHub 操作（ruleset の PUT・workflow の配布）を必須とする。該当コマンドはコマンド単位で sandbox 無効にして実行する。ネットワーク遮断を解除できない環境では実行できない
