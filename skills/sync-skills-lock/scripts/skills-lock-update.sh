#!/usr/bin/env bash
# skills-lock-update.sh — skills-lock.json の computedHash を npx skills add で更新する
#
# 使い方（リポジトリルートから実行）:
#   skills/sync-skills-lock/scripts/skills-lock-update.sh <skill-name> <source-repo>
#   （インストール先からは .agents/skills/sync-skills-lock/scripts/skills-lock-update.sh）
# 例:
#   skills/sync-skills-lock/scripts/skills-lock-update.sh github-docs Fandhe-AI/agent-reference-skills
#
# このスクリプトは sync-skills-lock スキルが使用する実例コマンド集。
# リポジトリルートから実行すること。

set -euo pipefail

# skills CLI (vercel-labs/skills) の固定実行バージョン。
# exact 版のみ許可（dist-tag・レンジ禁止）。npx はバージョン未固定だと
# ローカルキャッシュに無い場合レジストリの最新版を確認なしで即実行するため、
# レジストリ乗っ取り時に任意コード実行を許す経路になる。この実行は
# skills-lock.json の差分確認・ユーザー承認より前に走るため、source の
# Fandhe-AI 完全一致検証（下記）では防げない。exact 版固定が信頼アンカー。
# 更新手順は SKILL.md の「skills CLI のバージョン固定と更新手順」節を参照。
# SKILL.md 側のフェンスと同時更新し、tests/version-pin.test.mjs が両者の
# 一致を検証する。
readonly SKILLS_CLI_VERSION="1.5.22"   # 実装時に latest を再確認して確定（npm view skills version）

# dist-tag（latest 等）・レンジ指定（^, ~ 等）の混入をコード上でも防ぐ形式ガード。
# 不一致時は最新版へ暗黙フォールバックせず fail-closed で停止する。
if [[ ! "${SKILLS_CLI_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "エラー: SKILLS_CLI_VERSION は exact semver（X.Y.Z）のみ許可: ${SKILLS_CLI_VERSION}" >&2
  exit 1
fi

SKILL_NAME="${1:-}"
SOURCE_REPO="${2:-}"

if [[ -z "$SKILL_NAME" || -z "$SOURCE_REPO" ]]; then
  echo "使い方: $0 <skill-name> <source-repo>"
  echo "例: $0 github-docs Fandhe-AI/agent-reference-skills"
  exit 1
fi

# SKILL_NAME バリデーション: 小文字 kebab-case のみ許可（パストラバーサル防止）
if [[ ! "$SKILL_NAME" =~ ^[a-z][a-z0-9-]+$ ]]; then
  echo "エラー: SKILL_NAME は小文字 kebab-case のみ許可されています: ${SKILL_NAME}" >&2
  exit 1
fi

# source の安全弁: Fandhe-AI org の単一リポジトリのみ許可（完全一致検証）
# 前方一致では `../` を含む値が通過し、clone 時の URL パス正規化で
# 組織外リポジトリを対象にできるため、OWNER/REPO へ正規化後に厳密検証する
REPO_SLUG="${SOURCE_REPO#https://github.com/}"
REPO_SLUG="${REPO_SLUG%.git}"
if [[ ! "$REPO_SLUG" =~ ^Fandhe-AI/[A-Za-z0-9._-]+$ ]] \
  || [[ "$REPO_SLUG" == "Fandhe-AI/." || "$REPO_SLUG" == "Fandhe-AI/.." ]]; then
  echo "エラー: 想定外の source: $SOURCE_REPO — Fandhe-AI/<repo> の完全一致のみ許可されています" >&2
  exit 1
fi

# skills-lock.json に source があれば SOURCE_REPO と照合する（誤 upstream 同期防止）。
# jq 不在時にこの照合ブロックごと skip すると、lockfile の source 安全弁を経由せず
# 任意のリポジトリを SOURCE_REPO として通過させられてしまうため、skills-lock.json が
# 存在するのに jq が無い場合は照合を省略せず fail-closed で中止する。
if [[ -f skills-lock.json ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "エラー: jq が見つかりません。skills-lock.json の source 照合に jq の導入が必要です。中止します。" >&2
    exit 1
  fi
  LOCK_SOURCE=$(jq -r ".skills[\"${SKILL_NAME}\"].source // empty" skills-lock.json 2>/dev/null)
  if [[ -n "${LOCK_SOURCE}" ]]; then
    norm_lock="${LOCK_SOURCE#https://github.com/}"; norm_lock="${norm_lock%.git}"
    norm_arg="${SOURCE_REPO#https://github.com/}"; norm_arg="${norm_arg%.git}"
    if [[ "${norm_lock}" != "${norm_arg}" ]]; then
      echo "エラー: 指定された source (${SOURCE_REPO}) が skills-lock.json の source (${LOCK_SOURCE}) と一致しません。中止します。" >&2
      exit 1
    fi
  fi
fi

# gh CLI の認証確認
if ! gh auth status &>/dev/null; then
  echo "エラー: gh CLI が認証されていません。gh auth login を実行してください。" >&2
  exit 1
fi

# 作業ツリーの状態シグネチャ（種別 + パーミッション + 内容）を1行で返す。
# 第1引数のパスを起点に、通常ファイルは内容の sha256、シンボリックリンクは
# リンク先文字列の sha256（リンク先の解決はしない）、ディレクトリ・gitlink は
# 自身の mode に加えて配下全エントリ（サブディレクトリの mode・ディレクトリ向け
# symlink のリンク先と mode・ファイルの mode と内容ハッシュ）をバイト列ソートで
# 決定的に再帰集約した sha256 を返す。存在しないパスは "MISSING"（それ自体が
# 1つの状態であり、エラーではない）。第2引数以降で走査の除外を指定できる:
#   prune:<rel> — 起点からの相対パス <rel> をエントリごと走査から除外する。
#                 パス区切りをまたがない per-segment glob（fnmatch）を使える
#                 （例: .git/MERGE_* は .git 直下にのみ一致し .git/hooks/ 配下の
#                 同名ファイルには一致しない）。npx が書き換えてよいスコープ内と、
#                 .git のうち通常の git 操作で変動し得る領域の限定除外に使う
#   omit:<rel>  — <rel> 自身のメタデータ（存在・mode）は記録しないが配下は走査する
#                 （実行前に存在しなかった親ディレクトリを npx が正当に新規作成する
#                 ケースの許容に使う。完全一致のみで glob 不可）
#
# PR #412 の P1 指摘群（porcelain に現れない状態変化の見逃し: 配下ファイルの
# 内容上書き・ディレクトリと dirlink の変更・ディレクトリの chmod）は、いずれも
# 「git status に現れたパスだけを個別にシグネチャ化する」構造に起因する同一クラス。
# git はディレクトリの mode を追跡しないため、スコープ外ディレクトリの chmod は
# status の前後どちらにも現れず、status 由来のパス集合をどれだけ精緻にハッシュ
# しても原理的に検出できない。そのためこのシグネチャは status 由来のパスではなく
# リポジトリルート全体（スコープ内と、.git のうち git 操作で変動し得る領域のみ
# 除外。.git/config・.git/hooks/ 等の永続メタデータは署名対象）へ適用する。
# .gitignore 対象の
# ファイルも同じ理由（porcelain に現れない）で走査対象に含める。対象は skills
# 配布リポジトリで作業ツリーが小さく、全走査 + 全ハッシュを前後 2 回行っても
# 実用上問題ない。
# gitlink（未初期化 submodule 等、os.walk が降りられない空ディレクトリ相当）は
# entries が空集合のままになり「空ディレクトリ」と区別が付かないが、この用途は
# 「npx 実行前後で変化したか」の検出のみで足りるため区別不要。stat コマンドの
# 出力書式は環境（BSD/GNU）で異なるため、シェルの `stat` は使わず python3 の
# os.lstat に統一する。取得エラー（lstat・open・走査失敗）は「読めなかっただけ」を
# 「変化なし」と誤認する fail-open 経路になるため、握り潰さず即座に非ゼロ終了して
# 呼び出し側で fail-closed に扱う。
path_state() {
  local path="$1"
  shift
  python3 - "${path}" "$@" <<'PYEOF'
import fnmatch, hashlib, os, stat, sys

path = sys.argv[1]

# 除外指定（prune: 走査ごと除外 / omit: 自身のメタデータのみ不記録）を解釈する。
prunes = []
omits = set()
for spec in sys.argv[2:]:
    label, _, rel = spec.partition(":")
    if label == "prune" and rel:
        prunes.append(rel)
    elif label == "omit" and rel:
        omits.add(rel)
    else:
        print(f"path_state: 不正な除外指定: {spec}", file=sys.stderr)
        sys.exit(1)


def pruned(rel):
    # prune はパス区切りをまたがない per-segment glob で照合する。素の fnmatch は
    # `*` が `/` もまたいで一致するため、`.git/*.lock` のような浅い階層向けの
    # パターンが `.git/hooks/x.lock`（署名対象へ残したい深い階層）まで巻き込んで
    # しまう。セグメント数の一致を要求してから各セグメントを個別に照合し、
    # 除外が意図した深さの外へ広がらないようにする。
    segs = rel.split(os.sep)
    for pat in prunes:
        pat_segs = pat.split("/")
        if len(pat_segs) == len(segs) and all(
            fnmatch.fnmatchcase(s, p) for s, p in zip(segs, pat_segs)
        ):
            return True
    return False


def fail(err):
    # 部分的なシグネチャを出力したまま正常終了すると、呼び出し側が欠損に気付けない。
    # ファイル内容は出力せず（秘密情報混入防止）、エラー要因のみ stderr へ出して
    # 非ゼロ終了する。
    print(f"path_state: 状態取得に失敗: {err}", file=sys.stderr)
    sys.exit(1)


def file_hash(p):
    fh = hashlib.sha256()
    with open(p, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            fh.update(chunk)
    return fh.hexdigest()


try:
    st = os.lstat(path)
except FileNotFoundError:
    print("MISSING")
    sys.exit(0)
except OSError as e:
    fail(e)

mode = oct(stat.S_IMODE(st.st_mode))
kind = stat.S_IFMT(st.st_mode)
h = hashlib.sha256()

try:
    if stat.S_ISLNK(st.st_mode):
        h.update(os.readlink(path).encode("utf-8", "surrogateescape"))
    elif stat.S_ISREG(st.st_mode):
        h.update(file_hash(path).encode("ascii"))
    else:
        # ディレクトリ・gitlink 等。配下の各エントリを相対パス・パーミッション・
        # 内容（種別に応じたハッシュ）でソートして正規化し、走査順に依存せず
        # 決定的な signature にする。os.walk は既定（followlinks=False）で
        # symlink の指す先へは降りないため、ディレクトリ向け symlink は dirnames
        # として自身（リンク先文字列・mode）だけを記録し、リンク先ディレクトリの
        # 中身が二重に取り込まれることはない。
        entries = []
        for dirpath, dirnames, filenames in os.walk(path, onerror=fail):
            kept = []
            for dname in sorted(dirnames):
                # dirnames 自体（配下ディレクトリ・ディレクトリ向け symlink）を
                # lstat して entries へ含める。os.walk は filenames 経由で列挙
                # しないため、ここで記録しないと配下ディレクトリの mode 変更や
                # ディレクトリ向け symlink のリンク先・mode 変更がシグネチャに
                # 反映されない（PR #412 P1 指摘）。
                dp = os.path.join(dirpath, dname)
                rel = os.path.relpath(dp, path)
                if pruned(rel):
                    continue
                kept.append(dname)
                if rel in omits:
                    continue
                dst = os.lstat(dp)
                dmode = oct(stat.S_IMODE(dst.st_mode))
                if stat.S_ISLNK(dst.st_mode):
                    target_hash = hashlib.sha256(
                        os.readlink(dp).encode("utf-8", "surrogateescape")
                    ).hexdigest()
                    entries.append(f"{rel}:{dmode}:dirlink:{target_hash}")
                else:
                    entries.append(f"{rel}:{dmode}:dir")
            # prune した名前を降下対象からも外す（os.walk は dirnames の
            # in-place 更新で走査対象を制御する仕様）。
            dirnames[:] = kept
            for name in sorted(filenames):
                p = os.path.join(dirpath, name)
                rel = os.path.relpath(p, path)
                if pruned(rel) or rel in omits:
                    continue
                fst = os.lstat(p)
                fmode = oct(stat.S_IMODE(fst.st_mode))
                if stat.S_ISLNK(fst.st_mode):
                    target_hash = hashlib.sha256(
                        os.readlink(p).encode("utf-8", "surrogateescape")
                    ).hexdigest()
                    entries.append(f"{rel}:{fmode}:link:{target_hash}")
                elif stat.S_ISREG(fst.st_mode):
                    entries.append(f"{rel}:{fmode}:reg:{file_hash(p)}")
                else:
                    # デバイスファイル等の特殊な種別は内容ハッシュが定義できない
                    # ため種別・mode のみ記録する。
                    entries.append(f"{rel}:{fmode}:other")
        entries.sort()
        for entry in entries:
            h.update(entry.encode("utf-8", "surrogateescape"))
            h.update(b"\n")
except OSError as e:
    fail(e)

print(f"{kind}:{mode}:{h.hexdigest()}")
PYEOF
}

# リポジトリルート全体の状態シグネチャ（スコープ外書き込み検出の実体）。
# 除外は次の 3 種のみ:
#   - スコープ内 — skills-lock.json / .agents/skills/${SKILL_NAME}（npx の正当な書き込み先）
#   - .git のうち通常の git 操作で npx と無関係に変動し得る領域のみ — このスクリプト
#     自身が呼ぶ git status（index の stat cache 更新）や、fetch・commit・merge 等の
#     並行操作で変わる index・ODB（objects）・refs 系・reflog・一時状態ファイル・
#     lock。`.git` を丸ごと prune すると .git/config・.git/hooks/ の書き換え
#     （フック仕込み・設定改変）まで署名から漏れるため（PR #412 P1 指摘）、変動が
#     避けられない領域だけを限定列挙し、config・hooks・info 等の永続メタデータは
#     署名対象に残す
#   - REPO_SIG_OMITS — 実行前に存在しなかった場合の .agents / .agents/skills
#     （npx 実行前スナップショットの直前に一度だけ確定する）。既存なら omit せず
#     種別・mode・symlink 先を通常どおり署名するため、既存親ディレクトリの chmod や
#     ディレクトリ→symlink 置換は検出される（PR #412 P1 指摘）。不存在だった場合
#     のみ omit し、初回インストールで npx が親ディレクトリを正当に新規作成する
#     ケースを誤検知にしない。omit でも配下の走査は継続するため、同居する他スキルの
#     ツリー（スコープ外）は引き続き保護される
#
# REPO_SIG_OMITS は前後 2 回の呼び出しで同一でなければならない（実行後の存在有無で
# 再判定すると、初回インストールの正当な新規作成が前後不一致＝誤検知になる）。
# 空配列の "${arr[@]}" 展開は bash 3.2 の set -u で unbound になるため
# ${arr[@]+...} 形式で参照する。
REPO_SIG_OMITS=()
repo_state_signature() {
  path_state . \
    "prune:skills-lock.json" \
    "prune:.agents/skills/${SKILL_NAME}" \
    "prune:.git/index" \
    "prune:.git/*.lock" \
    "prune:.git/objects" \
    "prune:.git/refs" \
    "prune:.git/packed-refs" \
    "prune:.git/logs" \
    "prune:.git/HEAD" \
    "prune:.git/FETCH_HEAD" \
    "prune:.git/ORIG_HEAD" \
    "prune:.git/MERGE_*" \
    "prune:.git/AUTO_MERGE" \
    "prune:.git/CHERRY_PICK_HEAD" \
    "prune:.git/REVERT_HEAD" \
    "prune:.git/REBASE_HEAD" \
    "prune:.git/BISECT_*" \
    "prune:.git/COMMIT_EDITMSG" \
    "prune:.git/sequencer" \
    "prune:.git/rebase-merge" \
    "prune:.git/rebase-apply" \
    "prune:.git/gc.log" \
    "prune:.git/shallow" \
    "prune:.git/worktrees" \
    "prune:.git/modules" \
    ${REPO_SIG_OMITS[@]+"${REPO_SIG_OMITS[@]}"}
}

# git status --porcelain -z の1レコード（"XY PATH\0"）からスコープ内（skills-lock.json /
# .agents/skills/${SKILL_NAME}/ 配下）を除いたレコードだけを NUL 区切りで outfile へ
# 書き出す。これは Step 4 実行前後のスナップショット差分（scope-guard）用のフィルタで、
# 未追跡ファイルのプレビュー表示（既存の git ls-files -z 経路。下部で継続使用）とは別物。
# 検出の主体はリポジトリ全体の状態シグネチャ（repo_state_signature）であり、この
# レコード列は status レベルの前後比較と、検出時の報告（どのパスが git status 上で
# 変化したか）に使う。ディレクトリの chmod 等 status に現れない変化はこの一覧に
# 載らず、シグネチャ不一致としてのみ検出される。
# ステータス文字の後の空白1文字を含む固定長プレフィックス（3文字）を切り落とすことで
# パスを取り出す。C-quote（改行等を含むパスのダブルクォート化）の影響を受けない
# （-z 出力は raw byte のパスであり、path をそのままファイルアクセスに使ってよい）。
filter_out_of_scope() {
  local infile="$1" outfile="$2" record path
  : > "${outfile}"
  while IFS= read -r -d '' record; do
    path="${record:3}"
    if [[ "${path}" == "skills-lock.json" || "${path}" == ".agents/skills/${SKILL_NAME}/"* ]]; then
      continue
    fi
    printf '%s\0' "${record}" >> "${outfile}"
  done < "${infile}"
}

echo "==> skills-lock.json を更新中: ${SKILL_NAME} (source: ${SOURCE_REPO})"
echo ""

# 更新前の computedHash を表示
echo "変更前の computedHash:"
SKILL_NAME_VAR="${SKILL_NAME}" python3 - <<'PYEOF'
import json, os, sys
skill = os.environ['SKILL_NAME_VAR']
try:
    with open('skills-lock.json') as f:
        lock = json.load(f)
    skills = lock.get('skills', {})
    if skill in skills:
        print(skills[skill].get('computedHash', '(computedHash なし)'))
    else:
        print('(未登録)')
except FileNotFoundError:
    print('(skills-lock.json が見つかりません)', file=sys.stderr)
    sys.exit(1)
PYEOF

echo ""

# skills-lock.json の clean チェック（sync 由来以外の変更の混入を防ぐ）
# git diff 系は untracked を検出しないため porcelain を使う
if [[ -n "$(git status --porcelain -- skills-lock.json)" ]]; then
  echo "エラー: skills-lock.json に未コミットの変更があります。コミットまたは退避してから再実行してください。" >&2
  exit 1
fi

# 当該スキルの install ツリーの clean チェック（npx による WIP 上書きを防ぐ）
# git diff 系は untracked を検出しないため porcelain を使う（未追跡 WIP も保護対象）
if [[ -n "$(git status --porcelain -- ".agents/skills/${SKILL_NAME}/")" ]]; then
  echo "エラー: .agents/skills/${SKILL_NAME}/ に未コミット変更（未追跡含む）があります。npx の上書きで失われるため中止します。コミットまたは退避してから再実行してください。" >&2
  exit 1
fi

# 一時ファイルは npx 実行前後のスナップショット比較に使うため、npx を呼ぶより前に
# すべて用意し、単一の trap へまとめて登録する（trap は後勝ちのため、複数箇所に
# 分散させると先に登録した分の掃除が消える）。UNTRACKED_LIST_FILE はこの後の
# 未追跡ファイル一覧化（プレビュー表示）でも使うため、ここでまとめて確保する。
SNAP_BEFORE="$(mktemp)"
SNAP_AFTER="$(mktemp)"
SNAP_FILTERED_BEFORE="$(mktemp)"
SNAP_FILTERED_AFTER="$(mktemp)"
NPX_OUTPUT_FILE="$(mktemp)"
UNTRACKED_LIST_FILE="$(mktemp)"
trap 'rm -f "${SNAP_BEFORE}" "${SNAP_AFTER}" "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}" "${NPX_OUTPUT_FILE}" "${UNTRACKED_LIST_FILE}"' EXIT

# npx 実行前のリポジトリ全体スナップショット（スコープ外書き込み検出の起点）。
# -z は改行等を含むパスでも1レコード1件を保つため、後段の filter_out_of_scope が
# C-quote に影響されず判定できる。-uall は新規ディレクトリの collapse
# （`?? .agents/` のような1行への丸め）を防ぐために必須（丸められると
# ディレクトリ配下の個々のパスがスコープ判定の対象に現れない）。
# status.renames=false で rename 検出を明示的に無効化し、2フィールド
# （新パス + 旧パス）のレコードが混入しない形にそろえる（既定でも通常は無効だが、
# ユーザー環境の git config 依存にしない）。
if ! git -c status.renames=false status --porcelain -z -uall > "${SNAP_BEFORE}"; then
  echo "エラー: npx 実行前の git status 取得に失敗しました。スコープ外書き込みの検出ができないため中止します。" >&2
  exit 1
fi

filter_out_of_scope "${SNAP_BEFORE}" "${SNAP_FILTERED_BEFORE}"

# .agents / .agents/skills の omit（自身のメタデータ不記録）は「npx 実行前に存在
# したか」で決める。既存なら通常どおり署名対象にして chmod・ディレクトリ→symlink
# 置換を検出し（PR #412 P1 指摘）、不存在だった場合のみ omit して初回インストール
# での正当な親ディレクトリ新規作成を誤検知にしない。判定は npx 実行前のここで
# 一度だけ行い、前後の両シグネチャで同じ除外集合を使う（実行後に再判定すると
# 初回作成が前後不一致になる）。-e は壊れた symlink で偽になるため -L も併せて
# 見る（symlink 自体は「存在」として署名対象に含める）。
if [[ ! -e ".agents" && ! -L ".agents" ]]; then
  REPO_SIG_OMITS+=("omit:.agents")
fi
if [[ ! -e ".agents/skills" && ! -L ".agents/skills" ]]; then
  REPO_SIG_OMITS+=("omit:.agents/skills")
fi

# リポジトリ全体の状態シグネチャは「その時点のディスク内容・モード」を読むため、
# 必ず npx を呼ぶ前にここで確定させる。npx 実行後（事後検査の直前）に取得すると、
# 「変更前」のつもりが実質「変更後」と一致してしまい、実行前から M・?? だった
# スコープ外ファイルの内容・モードだけの上書きを見逃す（事前シグネチャ化を npx の
# 後にまとめて行った最初の実装で実測した回帰）。取得失敗時はスコープ外書き込みを
# 検出できないため fail-closed で中止する（この時点では npx 未実行のため残置なし）。
if ! REPO_STATE_BEFORE="$(repo_state_signature)"; then
  echo "エラー: npx 実行前の状態シグネチャ取得に失敗しました。スコープ外書き込みの検出ができないため中止します。" >&2
  exit 1
fi

# npx skills add で CLI に computedHash を更新させる
# --yes（1つ目）は npx 自体のインストール確認プロンプトを非対話でスキップする
# ものであり、skills CLI へ渡す --yes（末尾）とは別物（位置で区別される）。
# skills@${SKILLS_CLI_VERSION} で exact 版のみ解決させ、該当版が存在しない・
# レジストリ到達不能の場合は npx が非ゼロ終了する（fail-closed。最新版への暗黙
# フォールバック経路は存在しない）。
# --agent universal は書き込み先を union ストア（.agents/skills/<name>/）+
# skills-lock.json のみに限定する一次防御。個別 agent 指定（claude-code 等）は
# .agents/skills を経由せず .claude/skills/ 等へ直接コピーしレイアウトを変えるため
# 使わない（実測: スクラッチリポジトリで --agent universal のみ .agents/skills/
# 以外へ書き込みが無いことを確認済み）。npx の出力は tee で NPX_OUTPUT_FILE へも
# 保存し、後段の「Invalid agents」no-op 検出に使う。
#
# 終了コードの扱い: この行を素の `set -euo pipefail` 下に置くと、npx が非ゼロ終了
# した瞬間に pipefail でスクリプトが即停止し、下の事後スナップショット取得・
# スコープ外検査（この行より後の NPX_STATUS 分岐）に到達できない。npx が部分的に
# スコープ外へ書き込んだ後に失敗した場合、その残置がまったく検出されないまま停止して
# しまうため、この行の前後だけ errexit を無効化し、pipeline の終了コードを PIPESTATUS
# 経由で変数へ保存して明示的に分岐する（成功・失敗いずれの経路でも下の事後検査へ
# 必ず到達させる）。
# npx 呼び出し自体は bare のまま1行を維持する（tests/version-pin.test.mjs の静的抽出
# が行頭 npx の1物理行を前提にしているため、バックスラッシュ継続で複数行に分けない）。
# PIPESTATUS は pipeline 直後の「次のコマンド実行前」にしか正しい値を保持しない。
# 変数代入も1個のコマンドと数えられるため、`NPX_STATUS=...; TEE_STATUS=...` のように
# 2つの代入に分けると、1つ目の代入自体がその時点の PIPESTATUS を（要素数1・
# 値0の配列へ）上書きしてしまい、2つ目の代入が参照する PIPESTATUS[1] は
# `set -u` 下で unbound variable エラーになる（実測: bash 5.3 で再現）。
# 配列全体を単一の代入 `arr=("${PIPESTATUS[@]}")` でスナップショットし、
# 添字アクセスはそのコピーに対して行う。npx（[0]）・tee（[1]）両方を読む理由:
# tee がディスク容量不足等で非ゼロ終了すると NPX_OUTPUT_FILE が空・不完全なまま
# 残り得るが、npx 自体は成功（exit 0）し得るため、tee 側の失敗は npx の終了コード
# だけを見る分岐からは検出できない（Issue #410 CI 失敗指摘）。TEE_STATUS が非ゼロ
# なら、その不完全な NPX_OUTPUT_FILE を前提にした「Invalid agents」no-op 判定を
# 信頼せず、NPX_STATUS を強制的に失敗へ倒して以降の失敗経路（事後スコープ外検査・
# スコープ内リバート）へ必ず合流させる。
set +e
npx --yes "skills@${SKILLS_CLI_VERSION}" add "${SOURCE_REPO}" --skill "${SKILL_NAME}" --agent universal --yes 2>&1 | tee "${NPX_OUTPUT_FILE}"
PIPE_EXIT_SNAPSHOT=("${PIPESTATUS[@]}")
set -e
NPX_STATUS="${PIPE_EXIT_SNAPSHOT[0]}"
TEE_STATUS="${PIPE_EXIT_SNAPSHOT[1]}"

if [[ "${TEE_STATUS}" -ne 0 ]]; then
  echo "エラー: npx の出力を ${NPX_OUTPUT_FILE} へ保存する tee が失敗しました（終了コード ${TEE_STATUS}。ディスク容量不足等）。出力ファイルが不完全なため、npx 自体の終了コード（${NPX_STATUS}）に関わらず失敗として扱います。" >&2
  NPX_STATUS=1
fi

# CLI がバージョン更新等で --agent universal を認識できなくなった場合、
# エラー表示のうえ exit 0 の no-op になる（実測: skills@1.5.22 で確認済み）。
# 検知せず先へ進むと「同期したつもりで何も更新されていない」まま完了扱いに
# なるため、明示的にエラー化する（NPX_STATUS -eq 0 のときのみ意味を持つ判定。
# 上の TEE_STATUS チェックで NPX_STATUS が強制失敗化されていればここは通らない）。
if [[ "${NPX_STATUS}" -eq 0 ]] && grep -q "Invalid agents" "${NPX_OUTPUT_FILE}"; then
  echo "エラー: skills CLI が --agent universal を認識せず、何も実行していません（exit 0 の no-op）。SKILLS_CLI_VERSION 更新時は SKILL.md の「skills CLI のバージョン固定と更新手順」節に従い universal の有効性を再確認してください。" >&2
  exit 1
fi

if [[ "${NPX_STATUS}" -ne 0 ]]; then
  echo "エラー: skills@${SKILLS_CLI_VERSION} の実行が失敗しました（該当版の不存在・レジストリ障害・ダウンロード中断等、原因は問いません）。" >&2
  # 失敗が部分書き込み後に発生した場合、skills-lock.json / .agents/skills/${SKILL_NAME}/
  # に加えてスコープ外（他エージェントツリー等）にも残置され得るため、失敗経路でも
  # 実行後スナップショットを取ってスコープ外残留を検査する（下の成功経路と同一ロジック。
  # ここで検査しないと、次にこのディレクトリを扱う処理がスコープ外の残置差分を
  # 「元から存在した dirty 状態」として誤認しかねない）。
  git -c status.renames=false status --porcelain -z -uall > "${SNAP_AFTER}" || true
  filter_out_of_scope "${SNAP_AFTER}" "${SNAP_FILTERED_AFTER}"
  # 実行後シグネチャの取得失敗は「変化なしと確認できない」であって「変化なし」では
  # ないため、比較不能な sentinel を入れて必ず不一致（= 残置疑いの報告）へ倒す。
  if ! REPO_STATE_AFTER="$(repo_state_signature)"; then
    echo "エラー: npx 実行後の状態シグネチャ取得に失敗しました。変化なしと確認できないため、スコープ外残置ありとして扱います（fail-closed）。" >&2
    REPO_STATE_AFTER="(signature-error)"
  fi
  if ! cmp -s "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}" \
    || [[ "${REPO_STATE_BEFORE}" != "${REPO_STATE_AFTER}" ]]; then
    echo "エラー: 失敗した npx 実行がスコープ外へも書き込んだ可能性があります。以下を確認してください（削除はしていません）:" >&2
    while IFS= read -r -d '' rec; do printf '  %s\n' "${rec}" >&2; done < "${SNAP_FILTERED_AFTER}"
    echo "  （ディレクトリの chmod 等、git status に現れない変化は上記一覧に載りません。状態シグネチャの不一致として検出されています）" >&2
  fi
  # 次にこのディレクトリを扱う呼び出し元（SKILL.md の全スキル sync ループ等）が、
  # この失敗による残置差分を承認済みの変更や「既存の dirty 状態」と混同しないよう、
  # スコープ内（skills-lock.json / .agents/skills/${SKILL_NAME}/）分のみ即座にリバート
  # してから exit 1 で終端する。2つのパスを1つの `git checkout --` に渡すとアトミックに
  # 扱われ、どちらか一方が「追跡対象なし」（初回具現化・untracked のみの書き込み時）で
  # pathspec エラーになるとコマンド全体が失敗し、もう一方（skills-lock.json）も復元
  # されないまま抜けてしまうため、必ず1コマンド1パスで分離する。
  git checkout -- skills-lock.json 2>/dev/null || true
  git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
  if [[ -d ".agents/skills/${SKILL_NAME}/" ]]; then
    git clean -fd ".agents/skills/${SKILL_NAME}/" || true
  fi
  echo "スコープ内（skills-lock.json / .agents/skills/${SKILL_NAME}/）の変更はリバートしました。固定版を外した再実行はしません。" >&2
  exit 1
fi

# npx 実行後のスナップショット。前後のスコープ外差分を見るため、取得条件は
# SNAP_BEFORE と完全に揃える。
if ! git -c status.renames=false status --porcelain -z -uall > "${SNAP_AFTER}"; then
  echo "エラー: npx 実行後の git status 取得に失敗しました。スコープ外書き込みの検出ができないため中止します。" >&2
  exit 1
fi

filter_out_of_scope "${SNAP_AFTER}" "${SNAP_FILTERED_AFTER}"

# 実行後シグネチャの取得失敗は「変化なしと確認できない」であって「変化なし」では
# ないため、比較不能な sentinel を入れて必ず不一致（= 検出・リバート・停止）へ倒す。
if ! REPO_STATE_AFTER="$(repo_state_signature)"; then
  echo "エラー: npx 実行後の状態シグネチャ取得に失敗しました。変化なしと確認できないため、スコープ外書き込みありとして扱います（fail-closed）。" >&2
  REPO_STATE_AFTER="(signature-error)"
fi

# スコープ外の状態が前後で一致しなければ、--agent universal が抑止しているはずの
# スコープ外書き込みが発生したことになる（一次防御を突破した場合の多層防御）。
# 判定は 2 軸: (1) porcelain レコード（SNAP_FILTERED_*。git の porcelain -z 出力順は
# 決定的なためソート不要で cmp -s のバイト列比較のみで判定できる）と、
# (2) リポジトリ全体の状態シグネチャ（REPO_STATE_*、repo_state_signature の出力）。
# 実行前から M・?? だったスコープ外ファイルの内容・モードだけの上書きや、
# ディレクトリの chmod・ディレクトリ向け symlink の変更・.gitignore 対象ファイルの
# 上書きは porcelain レコードに現れないため、シグネチャ側の不一致だけがそれを
# 検出できる（レコード側は検出時の報告用としても使う）。
if ! cmp -s "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}" \
  || [[ "${REPO_STATE_BEFORE}" != "${REPO_STATE_AFTER}" ]]; then
  echo "エラー: npx skills add がスコープ外（skills-lock.json / .agents/skills/${SKILL_NAME}/ 以外）へ書き込みました。" >&2
  echo "==> 実行前のスコープ外状態:" >&2
  while IFS= read -r -d '' rec; do printf '  %s\n' "${rec}" >&2; done < "${SNAP_FILTERED_BEFORE}"
  echo "==> 実行後のスコープ外状態:" >&2
  while IFS= read -r -d '' rec; do printf '  %s\n' "${rec}" >&2; done < "${SNAP_FILTERED_AFTER}"
  echo "（ディレクトリの chmod 等、git status に現れない変化は上記一覧に載りません。その場合は状態シグネチャの不一致として検出されています）" >&2
  echo "スコープ内（skills-lock.json / .agents/skills/${SKILL_NAME}/）の変更はこれからリバートします。" >&2
  echo "スコープ外は既存の WIP を巻き込む恐れがあるため自動リバートしません。" >&2
  echo "上記パスの内容を git status / git diff で確認し、必要なら手動で" >&2
  echo "  git checkout -- <path>   （変更前が clean だった追跡ファイルの場合）" >&2
  echo "  git clean -fd <path>     （変更前に存在しなかった未追跡ファイルの場合）" >&2
  echo "を実行してください。" >&2
  # スコープ内リバート。git checkout -- は「対象なし」で失敗し得る（初回具現化・
  # 未追跡のみの書き込み時）ため || true で許容する。git clean -fd はディレクトリが
  # 存在しない場合に非ゼロ終了するため、存在確認してから呼ぶ（set -e 下で無条件に
  # 呼ぶとこのエラーメッセージより先にスクリプトが停止し得る）。
  git checkout -- skills-lock.json 2>/dev/null || true
  git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
  if [[ -d ".agents/skills/${SKILL_NAME}/" ]]; then
    git clean -fd ".agents/skills/${SKILL_NAME}/" || true
  fi
  exit 1
fi

echo ""
echo "==> 更新完了。変更内容:"
# install ツリーの上書きも確認するため、skills-lock.json と当該スキルの install ツリー両方を diff する。
# git diff は未追跡ファイルを表示しない。スクリプト冒頭の clean ガード（porcelain）により
# npx 実行前の install ツリーは必ず clean のため、npx が新規作成したファイルは
# 例外なく未追跡になる。tracked diff だけでは upstream 側のファイル増加を一切見せずに
# 承認判断（呼び出し元の git add）へ進んでしまうため、未追跡分を別途列挙・表示する。
git diff -- skills-lock.json ".agents/skills/${SKILL_NAME}/"

# 承認（呼び出し元の git add、-f なし）が新規に取り込む集合、拒否（git clean -fd、-x なし）が
# 削除する集合と同一のもの（.gitignore 対象を除く非追跡ファイル）を列挙し、
# 中身が見えないまま承認 / 拒否のどちらか一方だけが通過する非対称を無くす。
# git ls-files の既定出力は改行区切りのため、ファイル名自体に改行を含む
# 未追跡ファイルがあると 1 パスが複数の存在しないパスへ分割される。分割後の
# 各 git diff は失敗し || true で握り潰される一方、後続の git add は実ファイルを
# そのまま取り込むため、内容を表示しないまま承認できてしまう（-z / NUL 区切りで防ぐ）。
UNTRACKED_COUNT=0
echo ""
# git ls-files をプロセス置換（`< <(...)`）へ直接つなぐと、`set -euo pipefail` は
# その終了コードを検査しない。`git ls-files` が失敗（破損 index・権限エラー等）しても
# while は単に0回実行され UNTRACKED_COUNT=0 のまま「新規（未追跡）ファイル: なし」と
# 誤表示し、実際には存在する未追跡ファイルの内容を確認しないまま呼び出し元が
# git add で承認してしまう（このスクリプトが防ごうとしている非対称そのもの）。
# 通常のコマンド置換で一時ファイルへ書き出し、`if ! ...` で明示的に終了コードを検査する
# ことで fail-closed にする。UNTRACKED_LIST_FILE 自体は npx 実行前のスナップショット
# 取得と同時に mktemp 済み（単一 trap にまとめるため）。
if ! git ls-files -z --others --exclude-standard -- ".agents/skills/${SKILL_NAME}/" > "${UNTRACKED_LIST_FILE}"; then
  echo "エラー: git ls-files が失敗し、未追跡ファイルの一覧化を確認できません。内容未確認のまま承認できてしまうため中止します。" >&2
  exit 1
fi
while IFS= read -r -d '' f; do
  if [[ "${UNTRACKED_COUNT}" -eq 0 ]]; then
    echo "==> 新規（未追跡）ファイル — 承認時に git add で取り込まれる集合:"
  fi
  UNTRACKED_COUNT=$((UNTRACKED_COUNT + 1))
  # 空ファイルは git diff --no-index が差分を出力しないため、diff の見出しだけでは
  # どのファイルが追加されるか分からない。先に printf でファイル名自体を明示してから
  # 内容の diff を表示する（0 byte のファイルでも名前は必ず見える）。
  printf '%s\n' "--- ${f} ---"
  # バイナリファイルは git diff --no-index が "Binary files ... differ" としか出力せず、
  # 追加される中身を一切提示しない。numstat の追加/削除行数が両方 "-" になる出力で
  # バイナリ判定し、内容の代わりに種別・サイズ・ハッシュを明示することで、中身を
  # 確認できないまま承認（git add）だけが通ってしまう非対称を防ぐ。
  NUMSTAT="$(git diff --no-index --numstat -- /dev/null "${f}" 2>/dev/null || true)"
  if [[ "${NUMSTAT}" == -$'\t'-$'\t'* ]]; then
    FILE_SIZE="$(wc -c < "${f}" | tr -d '[:space:]')"
    if command -v file >/dev/null 2>&1; then
      FILE_TYPE="$(file -b -- "${f}" 2>/dev/null || echo "unknown")"
    else
      FILE_TYPE="file コマンド未検出"
    fi
    FILE_HASH="$(git hash-object -- "${f}")"
    # object format は repository 設定依存（既定 sha1 / 拡張 sha256）で出力桁数が変わる
    # （sha1: 40 桁 / sha256: 64 桁）。固定表記 "git-blob-sha1" だと sha256 リポジトリで
    # 実際のアルゴリズムと表示が食い違うため、表記自体をアルゴリズム非依存にする。
    OBJECT_FORMAT="$(git rev-parse --show-object-format 2>/dev/null || echo unknown)"
    printf '%s\n' "==> バイナリファイル（内容は表示されません）: type=${FILE_TYPE} size=${FILE_SIZE}bytes git-blob-hash(${OBJECT_FORMAT})=${FILE_HASH}"
  else
    # --no-index は index を変更しない（git add -N は使わない。呼び出し元の拒否経路が
    # index からの git checkout -- で承認済み他スキルの hash を復元する設計に依存しており、
    # intent-to-add エントリを混入させるとその復元設計と干渉するため）。
    # 差分ありのとき exit 1 を返す仕様のため、表示専用のこの呼び出しに限り || true で
    # set -e の中断を避ける（clean ガード等の fail-closed 判定には影響しない）。
    git diff --no-index -- /dev/null "${f}" || true
  fi
done < "${UNTRACKED_LIST_FILE}"
if [[ "${UNTRACKED_COUNT}" -eq 0 ]]; then
  echo "==> 新規（未追跡）ファイル: なし"
fi

echo ""
echo "コミットするには:"
echo "  git add skills-lock.json"
echo "  git add .agents/skills/${SKILL_NAME}/  # 上記の未追跡ファイルもここで取り込まれる"
echo "  git commit -m 'chore(skills-lock): ${SKILL_NAME} の computedHash を upstream と同期'"
