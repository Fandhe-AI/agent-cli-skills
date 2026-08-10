#!/usr/bin/env bash
# tools/bootstrap-firebase.sh — Firebase Hosting（Spark プラン）への公開環境を
# コードから一括構築する。GCP コンソールでの UI 操作を発生させないことが目的。
#
# 実行するのは 1 回だけ（何度実行しても同じ結果になるよう冪等に書いてある）。
#
# ## このスクリプトがやること
#   1. GCP プロジェクトを確認・作成する（請求先アカウントは紐付けない = Spark 固定）
#   2. 必要な API を有効化する
#   3. プロジェクトへ Firebase を追加し、Hosting サイトを作成する
#   4. CI 用サービスアカウントを作り、Hosting デプロイに必要な最小ロールを付与する
#   5. サービスアカウント鍵を発行し、GitHub Secret へ登録して手元から消す
#   6. .firebaserc を生成する
#
# ## 意図的にやらないこと
#   - 請求先アカウントの紐付け（紐付けた時点で Spark の「課金され得ない」保証が消える）
#   - 独自ドメインの設定（DNS レコード登録はレジストラ側の操作になるため）
#
# ## 前提
#   - gcloud CLI / Node.js（npx 経由で firebase-tools を使う）/ gh CLI
#   - `gcloud auth login` 済みであること（ブラウザ認証。ここだけは自動化できない）
#
#   Firebase の追加と Hosting サイト作成は firebase CLI ではなく Firebase
#   Management API / Hosting API を gcloud のアクセストークンで直接呼ぶ。
#   firebase CLI は gcloud とは別の認証情報を持つため、CLI を使うと
#   `firebase login` というブラウザ認証がもう 1 回必要になるのを避けている。
#
#   ただし Firebase 利用規約が未承諾の Google アカウントでは addFirebase が
#   403 を返す（Owner 権限があっても）。規約の承諾は Firebase コンソールで
#   しかできない仕様のため、その場合は案内して停止する。
#
# ## 注意
#   PROJECT_ID のプロジェクトが存在しない場合は**新規作成する**。設定を
#   書き換えずに実行すると意図しないプロジェクトができるため、冒頭に
#   プレースホルダ検出の安全弁を置いてある。
#
# ## 使い方
#   bash tools/bootstrap-firebase.sh
#   PROJECT_ID=xxx SITE_ID=yyy GITHUB_REPO=owner/repo bash tools/bootstrap-firebase.sh
set -euo pipefail

# ---- プロジェクト固有の設定（対象リポジトリへコピーしたら書き換える）----
# GCP プロジェクト。既存ならそのまま使い、無ければ作成する。
PROJECT_ID="${PROJECT_ID:-__PROJECT_ID__}"
# Hosting サイト ID。公開 URL は https://<SITE_ID>.web.app になる。
# 1 プロジェクトに複数サイトを置けるため、プロジェクト ID とは独立に決める。
SITE_ID="${SITE_ID:-__SITE_ID__}"
# Secret / 変数の登録先リポジトリ（owner/repo）。
GITHUB_REPO="${GITHUB_REPO:-__OWNER__/__REPO__}"
DISPLAY_NAME="${DISPLAY_NAME:-${SITE_ID}}"
SA_ID="${SA_ID:-github-actions-hosting}"
SECRET_NAME="FIREBASE_SERVICE_ACCOUNT"

# 安全弁: 書き換え忘れのまま実行すると、意図しない GCP プロジェクトを
# 新規作成してしまう（実際にやらかしたので必ず先頭で止める）。
case "${PROJECT_ID}${SITE_ID}${GITHUB_REPO}" in
  *__*)
    echo "error: スクリプト冒頭のプレースホルダを実際の値へ書き換えてください。" >&2
    echo "       __PROJECT_ID__ / __SITE_ID__ / __OWNER__/__REPO__" >&2
    echo "       環境変数で渡すこともできます:" >&2
    echo "         PROJECT_ID=xxx SITE_ID=yyy GITHUB_REPO=owner/repo bash $0" >&2
    exit 1
    ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
project_root="$(cd -- "${script_dir}/.." >/dev/null 2>&1 && pwd)"

sa_email="${SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
# 本スクリプトが作成するサービスアカウントの displayName。鍵の自動削除
# 対象を「このスクリプト専用のサービスアカウント」に限定するための目印
# として使う（後述）。
sa_display_name="GitHub Actions (Firebase Hosting deploy)"

log() { printf '\n==> %s\n' "$1"; }
die() { printf '\nerror: %s\n' "$1" >&2; exit 1; }

# Google API を gcloud のアクセストークンで呼ぶ。
# 出力は呼び出し側で判定する（HTTP ステータスを末尾行に付ける）。
#
# x-goog-user-project は必須。gcloud のユーザー認証情報（ADC）はクォータ
# 課金先プロジェクトを持たないため、これがないと firebase.googleapis.com は
# gcloud 自身のクライアントプロジェクトを consumer とみなして 403
# （SERVICE_DISABLED）を返す。
api_post() {
  local url="$1" body="${2:-}"
  curl -sS -X POST "${url}" \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "x-goog-user-project: ${PROJECT_ID}" \
    -H "Content-Type: application/json" \
    -w '\nHTTP_STATUS:%{http_code}' \
    ${body:+-d "${body}"}
}

# Firebase Management API の long-running Operation が完了するまで待つ。
# addFirebase は HTTP 200 を返した時点ではまだプロジェクトへの Firebase
# 追加が終わっておらず、`done: true` になるまでは後続の Hosting
# sites.create がプロジェクト未整備のまま呼ばれて失敗し得る。
# タイムアウト（既定 180 秒）に達したら停止し、再実行を促す。
wait_for_operation() {
  local op_name="$1" timeout_sec="${2:-180}" interval_sec="${3:-5}" elapsed=0
  while (( elapsed < timeout_sec )); do
    local op_result op_status op_body
    op_result="$(curl -sS -X GET "https://firebase.googleapis.com/v1beta1/${op_name}" \
      -H "Authorization: Bearer $(gcloud auth print-access-token)" \
      -H "x-goog-user-project: ${PROJECT_ID}" \
      -w '\nHTTP_STATUS:%{http_code}')"
    op_status="$(printf '%s' "${op_result}" | sed -n 's/^HTTP_STATUS://p')"
    op_body="$(printf '%s' "${op_result}" | sed '$d')"
    if [ "${op_status}" = "200" ]; then
      if printf '%s' "${op_body}" | grep -q '"error"'; then
        die "operation ${op_name} がエラーで終了しました:
${op_body}"
      fi
      if printf '%s' "${op_body}" | grep -Eq '"done"[[:space:]]*:[[:space:]]*true'; then
        return 0
      fi
    fi
    sleep "${interval_sec}"
    elapsed=$((elapsed + interval_sec))
  done
  die "operation ${op_name} が ${timeout_sec} 秒以内に完了しませんでした。
GCP 側の処理が続いている可能性があります。しばらくしてから再実行してください。"
}

# --- (0) 前提ツール ---
command -v gcloud >/dev/null 2>&1 || die "gcloud が見つかりません。https://cloud.google.com/sdk/docs/install からインストールし、PATH を通してください。"
command -v gh >/dev/null 2>&1 || die "gh が見つかりません（GitHub Secret の登録に使います）。"
command -v curl >/dev/null 2>&1 || die "curl が見つかりません。"

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  die "gcloud にログインしていません。先に \`gcloud auth login\` を実行してください。"
fi

# --- (1) プロジェクト（請求先アカウントは紐付けない） ---
log "GCP プロジェクト ${PROJECT_ID} を確認します"
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "既に存在するため作成をスキップします"
else
  echo "新規作成します"
  if ! gcloud projects create "${PROJECT_ID}" --name="${DISPLAY_NAME}"; then
    die "プロジェクト ID ${PROJECT_ID} を作成できませんでした。ID は全 GCP で一意である必要があります。
別の ID で再実行してください: PROJECT_ID=<別の一意な ID> bash tools/bootstrap-firebase.sh"
  fi
fi

# 請求先アカウントが紐付いていないことを確認する（Spark 前提の生命線）。
# billingEnabled が取得できない（unknown）場合も、紐付いていないと決めつけず
# fail-closed で停止する。「課金され得ない」という本スクリプトの中核の安全
# 保証は、判定不能な状態のまま進めた時点で崩れるため。
billing_enabled="$(gcloud billing projects describe "${PROJECT_ID}" \
  --format="value(billingEnabled)" 2>/dev/null || echo "unknown")"
if [ "${billing_enabled}" != "False" ]; then
  if [ "${ALLOW_BLAZE:-false}" = "true" ]; then
    echo "警告: 請求先アカウントの状態が Spark 確定ではありません（billingEnabled=${billing_enabled}）。"
    echo "      ALLOW_BLAZE=true が指定されているため、明示的な承認とみなし続行します。"
  else
    die "請求先アカウントの状態が Spark 確定ではありません（billingEnabled=${billing_enabled}）。

このプロジェクトには請求先アカウントが紐付いているか、状態を判定できません
でした。Spark プランの『課金され得ない』保証は billingEnabled=False の場合
にしか成立しないため、既定では停止します。

意図的に Blaze（従量課金）で進める場合のみ、明示的に承認したことを示す
環境変数を付けて再実行してください:
  ALLOW_BLAZE=true PROJECT_ID=${PROJECT_ID} SITE_ID=${SITE_ID} GITHUB_REPO=${GITHUB_REPO} bash $0"
  fi
else
  echo "請求先アカウントは未紐付け（Spark プラン）です"
fi

# --- (2) API 有効化 ---
log "必要な API を有効化します"
# iam.googleapis.com が無いと、新規プロジェクトでは (4) のサービスアカウント
# 作成・鍵発行が失敗するか、gcloud が対話的な有効化プロンプトを出して
# 非対話実行（CI 等）を止めてしまう。
gcloud services enable \
  firebase.googleapis.com \
  firebasehosting.googleapis.com \
  cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com \
  iam.googleapis.com \
  --project="${PROJECT_ID}"

# --- (3) Firebase の追加と Hosting サイト作成 ---
log "プロジェクトへ Firebase を追加します"
add_result="$(api_post "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}:addFirebase" || true)"
add_status="$(printf '%s' "${add_result}" | sed -n 's/^HTTP_STATUS://p')"
case "${add_status}" in
  200)
    # addFirebase は Operation（`{"name": "operations/..."}`）を返すのみで、
    # この時点ではまだ追加が完了していない。done: true になるまで待つ。
    add_body="$(printf '%s' "${add_result}" | sed '$d')"
    add_op_name="$(printf '%s' "${add_body}" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"
    if [ -z "${add_op_name}" ]; then
      die "addFirebase のレスポンスから operation 名を取得できませんでした:
${add_body}"
    fi
    echo "追加リクエストを受け付けました。完了を待ちます（operation: ${add_op_name}）"
    wait_for_operation "${add_op_name}"
    echo "追加しました"
    ;;
  409) echo "既に Firebase プロジェクトのためスキップします" ;;
  403)
    # IAM 権限（firebase.projects.update ほか）が揃っていても、その Google
    # アカウントが Firebase 利用規約に未承諾だと addFirebase は
    # PERMISSION_DENIED を返す。そして規約の承諾は Firebase コンソールでしか
    # できない（公式ドキュメントに明記。CLI / REST / Terraform では不可能）。
    # ここだけは仕様上 UI 操作が避けられないため、案内して停止する。
    die "Firebase の追加が 403 で拒否されました。

権限は足りています（testIamPermissions で確認済みの前提）。原因は
**Firebase 利用規約が未承諾**であることがほとんどです。規約の承諾は
Firebase コンソールでしかできません（CLI / REST API / Terraform では不可能）。

  https://console.firebase.google.com/

  1. 「プロジェクトを追加」
  2. 「Google Cloud プロジェクトに Firebase を追加」を選び ${PROJECT_ID} を選択
  3. 利用規約に同意

Google アカウントにつき 1 回だけの操作です。完了後にこのスクリプトを
再実行すると、以降はすべて自動で進みます。"
    ;;
  *)
    # ALREADY_EXISTS は 400 で返ることもある
    if printf '%s' "${add_result}" | grep -qi "already"; then
      echo "既に Firebase プロジェクトのためスキップします"
    else
      die "Firebase の追加に失敗しました (HTTP ${add_status}):
${add_result}"
    fi
    ;;
esac

log "Hosting サイト ${SITE_ID} を作成します"
# Hosting API は Site リソースの JSON ボディを要求する。空ボディだと
# Content-Type: application/json のまま本文が無くなり 400 になり得るため
# 最小の Site ペイロード（{}）を明示的に送る。
site_result="$(api_post "https://firebasehosting.googleapis.com/v1beta1/projects/${PROJECT_ID}/sites?siteId=${SITE_ID}" '{}' || true)"
site_status="$(printf '%s' "${site_result}" | sed -n 's/^HTTP_STATUS://p')"
case "${site_status}" in
  200) echo "作成しました（https://${SITE_ID}.web.app）" ;;
  409) echo "既に存在するためスキップします（https://${SITE_ID}.web.app）" ;;
  *)
    if printf '%s' "${site_result}" | grep -qi "already exists"; then
      echo "既に存在するためスキップします（https://${SITE_ID}.web.app）"
    else
      die "Hosting サイトの作成に失敗しました (HTTP ${site_status}):
${site_result}

サイト ID は全 Firebase で一意です。使用済みなら別の ID で再実行してください:
  SITE_ID=<別の一意な ID> bash tools/bootstrap-firebase.sh"
    fi
    ;;
esac

# --- (4) CI 用サービスアカウント ---
log "CI 用サービスアカウント ${sa_email} を確認します"
if gcloud iam service-accounts describe "${sa_email}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "既に存在するため作成をスキップします"
else
  gcloud iam service-accounts create "${SA_ID}" \
    --display-name="${sa_display_name}" \
    --project="${PROJECT_ID}"
fi

# 実際の displayName を確認する。SA_ID を書き換えて実行した場合など、
# 既存の無関係なサービスアカウント（他の CI・サービスが使っている共有
# アカウント等）と衝突している可能性があるため、鍵の自動削除は
# 「本スクリプトが作成した専用アカウントだと確認できた場合」に限定する
# （下記 (5) を参照）。
actual_display_name="$(gcloud iam service-accounts describe "${sa_email}" \
  --project="${PROJECT_ID}" --format="value(displayName)" 2>/dev/null || echo "")"
if [ "${actual_display_name}" = "${sa_display_name}" ]; then
  sa_is_dedicated=true
else
  sa_is_dedicated=false
fi

log "最小ロールを付与します"
# firebasehosting.admin: 本番チャンネル・プレビューチャンネルへのデプロイ
# serviceusage.apiKeysViewer: firebase CLI がデプロイ時に参照する
# （Auth も Cloud Run rewrites も使わないため firebaseauth.admin / run.viewer は付けない）
for role in roles/firebasehosting.admin roles/serviceusage.apiKeysViewer; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${sa_email}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
  echo "付与: ${role}"
done

# --- (5) 鍵を発行して GitHub Secret へ登録（手元には残さない） ---
log "サービスアカウント鍵を発行し GitHub Secret ${SECRET_NAME} へ登録します"

# 再実行のたびに鍵を増やすと GitHub Secret には最新の 1 個しか反映されない
# のに古い鍵だけがアクティブなまま残り続け、サービスアカウントあたり 10 個
# という GCP の上限にいずれ達する。ただし削除を先にやると、鍵作成や
# gh secret set が途中で失敗した場合に GitHub 側が失効済みの鍵しか持たない
# 状態になり CI デプロイが止まる。そのため
#   1. 削除対象を「今から作る新しい鍵より前に存在した鍵」に限定して先に記録
#   2. 新しい鍵を作成し、GitHub Secret への登録まで成功させる
#   3. 登録が成功した後にだけ、記録しておいた旧鍵を削除する
# の順で行い、途中失敗時は Secret が有効な鍵を指したまま保たれるようにする。
existing_keys="$(gcloud iam service-accounts keys list \
  --iam-account="${sa_email}" \
  --project="${PROJECT_ID}" \
  --managed-by=user \
  --format="value(name)")"

key_file="$(mktemp -t firebase-sa-key)"
# 鍵ファイルは必ず消す（異常終了時も含む）
trap 'rm -f "${key_file}"' EXIT

gcloud iam service-accounts keys create "${key_file}" \
  --iam-account="${sa_email}" \
  --project="${PROJECT_ID}"

gh secret set "${SECRET_NAME}" --repo "${GITHUB_REPO}" < "${key_file}"
gh variable set FIREBASE_PROJECT_ID --repo "${GITHUB_REPO}" --body "${PROJECT_ID}"
gh variable set FIREBASE_SITE_ID --repo "${GITHUB_REPO}" --body "${SITE_ID}"
echo "登録しました（鍵ファイルは削除されます）"

if [ -n "${existing_keys}" ]; then
  if [ "${sa_is_dedicated}" = "true" ] || [ "${ROTATE_EXISTING_KEYS:-false}" = "true" ]; then
    echo "新しい鍵の登録が完了したため、直前まで存在していた旧鍵を削除します（世代交代）"
    while IFS= read -r key_name; do
      [ -n "${key_name}" ] || continue
      gcloud iam service-accounts keys delete "${key_name}" \
        --iam-account="${sa_email}" \
        --project="${PROJECT_ID}" \
        --quiet
    done <<< "${existing_keys}"
  else
    # displayName が本スクリプトの想定と一致しない = SA_ID が意図せず
    # 既存の別用途サービスアカウントと衝突している可能性がある。他の
    # CI・サービスの認証情報を誤って失効させないよう、確認なしでは
    # 削除しない。
    echo "警告: ${sa_email} は本スクリプトが作成した専用アカウントと確認できませんでした。"
    echo "      既存の鍵を自動削除すると他用途の認証を壊す恐れがあるため、削除をスキップします。"
    echo "      意図的に削除する場合は ROTATE_EXISTING_KEYS=true を指定して再実行してください。"
  fi
fi

# --- (6) .firebaserc の生成 ---
log ".firebaserc を生成します"
cat > "${project_root}/.firebaserc" <<EOF
{
  "projects": {
    "default": "${PROJECT_ID}"
  }
}
EOF
echo "${project_root}/.firebaserc"

log "完了しました"
cat <<EOF

公開 URL:      https://${SITE_ID}.web.app
プロジェクト:  ${PROJECT_ID}（請求先アカウント未紐付け = Spark）
GitHub Secret: ${SECRET_NAME}（${GITHUB_REPO}）
GitHub 変数:   FIREBASE_PROJECT_ID=${PROJECT_ID} / FIREBASE_SITE_ID=${SITE_ID}

次の手順:
  1. .firebaserc の差分をコミットしてください
  2. main へ push すると .github/workflows/deploy.yml が本番へデプロイします
  3. PR を作るとプレビューチャンネルへデプロイされ、PR にプレビュー URL が投稿されます

独自ドメインを使う場合は、Firebase Hosting のカスタムドメイン設定と
レジストラでの DNS レコード登録が別途必要です（DNS 側だけは UI 操作が残ります）。
EOF
