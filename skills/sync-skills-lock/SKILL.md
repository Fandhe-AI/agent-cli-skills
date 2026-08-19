---
name: sync-skills-lock
description: ルート直下の `skills-lock.json` の `computedHash` を upstream リポジトリの最新状態と照合して更新する。`source` が `Fandhe-AI/<repo>` に完全一致しないエントリは clone せず skip (安全弁)。submodule 配下の `skills-lock.json` は触らない。contribute-skill のマージ後や upstream 同期後、「ハッシュ更新」「skills-lock 同期」などで使用。
argument-hint: "[skill-name] (省略時は全スキル)"
user-invocable: true
model: sonnet
---

# sync-skills-lock

ルート直下の `skills-lock.json` の `computedHash` を、upstream リポジトリの現状と照合して更新する。

## 対象ファイル

- **ルート**: 呼び出し元リポジトリ直下の `skills-lock.json` — このスキルが唯一編集するファイル
- **除外**: submodule 配下の `skills-lock.json` — submodule 境界を跨がないため **絶対に触らない**

## 前提条件

- `gh` CLI がインストールされ、認証済みであること
- `node` / `npx` が利用可能であること（`npx skills add` を使用するため）。`skills` CLI は固定版（`SKILLS_CLI_VERSION`）で実行する。値と更新手順は「skills CLI のバージョン固定と更新手順」節を参照
- `file` CLI が利用可能であること（未追跡バイナリファイルの種別表示に使用。未導入の環境では
  種別が `file コマンド未検出` として表示され、承認前にサイズ・git blob ハッシュのみで
  判断することになる。macOS / 主要 Linux ディストリビューションには標準搭載されている）
- ルート直下の `skills-lock.json` が存在すること
- **実行前に `skills-lock.json` に未コミットの変更がないこと**（ステージ済み・未ステージ問わず）。本スキルの実行中に発生する変更は sync 由来のみとなり、`git add skills-lock.json` で全体をステージしても無関係な変更が混入しない
- **対象スキルの `.agents/skills/<name>/` に未コミット変更がないこと**。`npx skills add` は `.agents/skills/<name>/` を upstream の最新版で上書きするため、そのディレクトリに WIP が存在すると即座に失われる。`git checkout` で戻せるのは「最後にコミットされた状態」のみであり、npx 実行前の未コミット編集は復元できない。**未追跡ファイルとして存在する WIP も対象**であり、`git status --porcelain` で検出する

## フロー

### Step 1: 引数を確認し、事前条件を検証する

```bash
TARGET="$ARGUMENTS"  # 空なら全スキル対象

# 引数指定時は kebab-case のみ許可（パストラバーサル防止）
if [[ -n "${TARGET}" && ! "${TARGET}" =~ ^[a-z][a-z0-9-]+$ ]]; then
  echo "エラー: スキル名は小文字 kebab-case のみ許可されています: ${TARGET}"
  exit 1
fi
```

引数ありの場合は該当スキルのみ処理、なしの場合は `skills-lock.json` の全エントリを対象にする。

次に `skills-lock.json` の clean 状態を確認する。未コミット変更（ステージ済み・未ステージ問わず）があれば中止する。

```bash
# skills-lock.json に未コミット変更があれば中止（sync 由来以外の変更の混入を防ぐ）
# git diff 系は untracked を検出しないため porcelain を使う
if [[ -n "$(git status --porcelain -- skills-lock.json)" ]]; then
  echo "エラー: skills-lock.json に未コミットの変更があります。コミットまたは退避してから再実行してください。"
  exit 1
fi
```

### Step 2: upstream 一覧を集計する

`skills-lock.json` を読み、`source` フィールドごとにスキルをグルーピングする（同一リポへの処理を 1 回にまとめるため）。

```
Fandhe-AI/agent-cli-skills:
  - create-commit
  - create-issue
  - ...
```

### Step 3: source を検証する

**安全弁**: 処理前に必ず `source` フィールドが `Fandhe-AI/<repo>` に完全一致することを確認する。前方一致では `../` を含む値が通過し、clone 時の URL パス正規化で組織外リポジトリを対象にできてしまうため、`OWNER/REPO` へ正規化後に厳密な正規表現で検証する。想定外の source は skip してユーザーに警告する。`skills-lock.json` の改ざん・誤設定によって untrusted リポジトリから clone することを防ぐためである。

```bash
REPO_SLUG="${SOURCE#https://github.com/}"
REPO_SLUG="${REPO_SLUG%.git}"
if [[ ! "$REPO_SLUG" =~ ^Fandhe-AI/[A-Za-z0-9._-]+$ ]] \
   || [[ "$REPO_SLUG" == "Fandhe-AI/." || "$REPO_SLUG" == "Fandhe-AI/.." ]]; then
  echo "警告: 想定外の source: $SOURCE — このスキルは skip します"
  continue
fi
```

### Step 4–7: 対象スキルを1つずつ処理する（ループ）

対象スキルそれぞれについて、次の 4→5→6→7 を順に実行し、**1スキル完了後に次スキルへ進む**。全スキル sync であっても同時に複数スキルを処理せず、1スキルずつ完結させること。

#### Step 4: npx skills add で computedHash を更新する

`sha256sum` などで手動計算するのではなく、`npx skills add` に計算を任せる。これにより CLI の内部アルゴリズムと完全に一致する。

```bash
# 当該スキルの install ツリーに未コミット変更があれば npx が上書きするため skip
# git diff 系は untracked を検出しないため porcelain を使う（未追跡 WIP も保護対象）
if [[ -n "$(git status --porcelain -- ".agents/skills/${SKILL_NAME}/")" ]]; then
  echo "警告: .agents/skills/${SKILL_NAME}/ に未コミット変更（未追跡含む）があります。npx の上書きで失われるため skip します。"
  continue
fi

# skills CLI (vercel-labs/skills) は固定版でのみ実行する（未固定 npx はレジストリ
# 最新版の無検証即時実行になり、差分確認・承認より前に走る supply chain 経路になる）。
# 1つ目の --yes は npx 自体のインストール確認プロンプトのスキップ、末尾の --yes は
# skills CLI へ渡す確認プロンプトのスキップで、別物（位置で区別される）。
SKILLS_CLI_VERSION="1.5.22"   # scripts/skills-lock-update.sh と同一値。更新手順は下記節を参照

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
# 実用上問題ない。python3 は主要 Linux / macOS に標準搭載されている。stat
# コマンドの出力書式は環境（BSD/GNU）で異なるため、シェルの `stat` は使わず
# python3 の os.lstat に統一する。取得エラー（lstat・open・走査失敗）は
# 「読めなかっただけ」を「変化なし」と誤認する fail-open 経路になるため、
# 握り潰さず即座に非ゼロ終了して呼び出し側で fail-closed に扱う。
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

# git status --porcelain -z の1レコード（"XY PATH\0"）からスコープ内
# （skills-lock.json / .agents/skills/${SKILL_NAME}/ 配下）を除いたレコードだけを
# outfile へ NUL 区切りで書き出す。検出の主体はリポジトリ全体の状態シグネチャ
# （repo_state_signature）であり、このレコード列は status レベルの前後比較と、
# 検出時の報告（どのパスが git status 上で変化したか）に使う。ディレクトリの
# chmod 等 status に現れない変化はこの一覧に載らず、シグネチャ不一致としてのみ
# 検出される。固定長プレフィックス（ステータス2文字+空白1文字=3文字）を
# 切り落としてパスを取り出すため、C-quote（改行等を含むパスのダブルクォート化）の
# 影響を受けない（-z 出力は raw byte のパスであり、path をそのままファイルアクセス
# に使ってよい）。
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

# スコープ内（skills-lock.json / .agents/skills/${SKILL_NAME}/）の変更をリバートする。
# npx 失敗・スコープ外検出・実行後 git status 取得失敗のすべての異常終端経路が
# 共有する（PR #412 P1: どの異常経路でも生成済みのスコープ内変更を残置しない契約）。
# 2つのパスを1つの `git checkout --` に渡すとアトミックに扱われ、どちらか一方が
# 「追跡対象なし」（初回具現化・untracked のみの書き込み時）で pathspec エラーになると
# コマンド全体が失敗し、もう一方（skills-lock.json）も復元されないまま抜けてしまう
# ため、必ず1コマンド1パスで分離する。git clean -fd はディレクトリが存在しない場合に
# 非ゼロ終了するため、存在確認してから呼ぶ（set -e 下で無条件に呼ぶと呼び出し元の
# 案内メッセージより先に停止し得る）。SKILL_NAME はループの現在値を呼び出し時に参照する。
revert_in_scope() {
  git checkout -- skills-lock.json 2>/dev/null || true
  git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
  if [[ -d ".agents/skills/${SKILL_NAME}/" ]]; then
    git clean -fd ".agents/skills/${SKILL_NAME}/" || true
  fi
}

# npx 実行前後のスナップショット比較（スコープ外書き込みの多層防御）用の一時ファイル。
# -uall は新規ディレクトリの collapse（`?? .agents/` への丸め）を防ぐため必須。
# status.renames=false でユーザー環境の git config に依存せず rename 検出を無効化する。
SNAP_BEFORE="$(mktemp)"
SNAP_AFTER="$(mktemp)"
SNAP_FILTERED_BEFORE="$(mktemp)"
SNAP_FILTERED_AFTER="$(mktemp)"
NPX_OUTPUT_FILE="$(mktemp)"
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
# 必ず npx を呼ぶ前にここで確定させる。npx 実行後に取得すると「変更前」のつもりが
# 実質「変更後」と一致してしまい、実行前から M・?? だったスコープ外ファイルの
# 内容・モードだけの上書きを見逃す。取得失敗時はスコープ外書き込みを検出できない
# ため fail-closed で中止する（この時点では npx 未実行のため残置なし）。
if ! REPO_STATE_BEFORE="$(repo_state_signature)"; then
  echo "エラー: npx 実行前の状態シグネチャ取得に失敗しました。スコープ外書き込みの検出ができないため中止します。" >&2
  exit 1
fi

# CLI に computedHash を更新させる。固定版が解決できない場合（該当版の不存在・
# レジストリ障害）は npx が非ゼロ終了する。その場合は当該スキルを中止（skip）し、
# 固定版を外した再実行はしない（fail-closed。暗黙の最新版フォールバックはしない）。
# ここでの fail-closed は「他スキルへの処理を止めない」という Step 1/3 の他の skip
# 分岐と同じ意味であり、「script 全体を停止する」という意味ではない
# （`scripts/skills-lock-update.sh` 単体実行時の set -euo pipefail による停止とは別軸。
# 詳細は下記「skills CLI のバージョン固定と更新手順」節の fail-closed 記述を参照）。
# --agent universal は書き込み先を union ストア（.agents/skills/<name>/）+
# skills-lock.json のみに限定する一次防御。個別 agent 指定（claude-code 等）は
# .agents/skills を経由せず .claude/skills/ 等へ直接コピーしレイアウトを変えるため
# 使わない（実測: スクラッチリポジトリで --agent universal のみ .agents/skills/
# 以外へ書き込みが無いことを確認済み）。npx の出力を tee で NPX_OUTPUT_FILE へも
# 保存し、後段の「Invalid agents」no-op 検出に使う。PIPESTATUS は pipeline 直後の
# 「次のコマンド実行前」にしか正しい値を保持しない。変数代入も1個のコマンドと
# 数えられるため、`NPX_STATUS=...; TEE_STATUS=...` のように2つの代入に分けると、
# 1つ目の代入自体がその時点の PIPESTATUS を（要素数1・値0の配列へ）上書きして
# しまい、2つ目の代入が参照する PIPESTATUS[1] は `set -u` 下で unbound variable
# エラーになる（実測: bash 5.3 で再現）。配列全体を単一の代入
# `arr=("${PIPESTATUS[@]}")` でスナップショットし、添字アクセスはそのコピーに対して
# 行う。npx（[0]）・tee（[1]）両方を読む理由: tee がディスク容量不足等で非ゼロ終了
# すると NPX_OUTPUT_FILE が空・不完全なまま残り得るが、npx 自体は成功（exit 0）
# し得るため、tee 側の失敗は npx の終了コードだけを見る分岐からは検出できない
# （Issue #410 CI 失敗指摘）。TEE_STATUS が非ゼロなら、その不完全な NPX_OUTPUT_FILE
# を前提にした「Invalid agents」no-op 判定を信頼せず、NPX_STATUS を強制的に失敗へ
# 倒して以降の失敗経路（事後スコープ外検査・スコープ内リバート・skip）へ合流させる。
npx --yes "skills@${SKILLS_CLI_VERSION}" add "${SOURCE}" --skill "${SKILL_NAME}" --agent universal --yes 2>&1 | tee "${NPX_OUTPUT_FILE}"
PIPE_EXIT_SNAPSHOT=("${PIPESTATUS[@]}")
NPX_STATUS="${PIPE_EXIT_SNAPSHOT[0]}"
TEE_STATUS="${PIPE_EXIT_SNAPSHOT[1]}"

if [[ "${TEE_STATUS}" -ne 0 ]]; then
  echo "警告: npx の出力を ${NPX_OUTPUT_FILE} へ保存する tee が失敗しました（終了コード ${TEE_STATUS}。ディスク容量不足等）。出力ファイルが不完全なため、npx 自体の終了コード（${NPX_STATUS}）に関わらず失敗として扱います。"
  NPX_STATUS=1
fi

# CLI がバージョン更新等で --agent universal を認識できなくなった場合、
# エラー表示のうえ exit 0 の no-op になる（実測: skills@1.5.22 で確認済み）。
# 検知しないまま先へ進むと「同期したつもりで何も更新されていない」まま完了扱いに
# なるため、npx 自体の終了コードとは別に明示的な失敗として扱う（上の TEE_STATUS
# チェックで NPX_STATUS が強制失敗化されていればここは通らない）。
# この分岐で直接 exit すると実行後スナップショット・シグネチャ比較・スコープ内
# リバートをすべて迂回する（PR #412 P1 指摘）。「Invalid agents」は CLI の出力文言に
# 過ぎず、将来版が部分書き込みの後に同じ文言を出しても no-op とは限らないため、
# NPX_STATUS=1 を設定して下の共通失敗経路へ合流させ、「成功・失敗いずれの経路でも
# 事後検査へ必ず到達」の契約を守る。universal 無効は以降の全スキルでも再現し
# 続行に意味がないため、共通失敗経路の末尾で continue ではなく exit 1 で終端する
# （NPX_NOOP_DETECTED がその分岐と汎用メッセージの抑止を担う）。
NPX_NOOP_DETECTED=0
if [[ "${NPX_STATUS}" -eq 0 ]] && grep -q "Invalid agents" "${NPX_OUTPUT_FILE}"; then
  echo "エラー: skills CLI が --agent universal を認識せず、何も実行していません（exit 0 の no-op）。SKILLS_CLI_VERSION 更新時は「skills CLI のバージョン固定と更新手順」節に従い universal の有効性を再確認してください。" >&2
  NPX_NOOP_DETECTED=1
  NPX_STATUS=1
fi

if [[ "${NPX_STATUS}" -ne 0 ]]; then
  if [[ "${NPX_NOOP_DETECTED}" -eq 0 ]]; then
    echo "警告: skills@${SKILLS_CLI_VERSION} の実行が失敗しました（該当版の不存在・レジストリ障害・ダウンロード中断等、原因は問わない）。"
  fi
  # 失敗が部分書き込み後に発生した場合、skills-lock.json / .agents/skills/${SKILL_NAME}/ に
  # 加えてスコープ外（他エージェントツリー等）にも残置され得るため、失敗経路でも
  # 実行後スナップショットを取ってスコープ外残留を検査する（下の成功経路と同一ロジック）。
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
  # 次スキルの `git add skills-lock.json`（Step 7）が
  # この残置変更を承認済みの変更と一緒に stage してしまわないよう、Step 6 の却下時と
  # 同じ手順で当該スキル分のみを即座にリバートしてから skip する。
  revert_in_scope
  rm -f "${SNAP_BEFORE}" "${SNAP_AFTER}" "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}" "${NPX_OUTPUT_FILE}"
  # universal 無効の no-op は以降の全スキルでも再現するため、skip（continue）ではなく
  # ループ全体を停止する（事後検査・リバートは上で完了済み）。
  if [[ "${NPX_NOOP_DETECTED}" -eq 1 ]]; then
    exit 1
  fi
  echo "警告: 固定版を外した再実行はせず、当該スキルの変更をリバートして skip します。"
  continue
fi

# npx 実行後のスナップショット。前後のスコープ外差分を見るため、取得条件は
# SNAP_BEFORE と完全に揃える。取得失敗時にその場で exit すると、npx が生成済みの
# スコープ内変更を残置したままスコープ外シグネチャ検査も行われない（PR #412 P1
# 指摘）。状態シグネチャは git 非依存（python3 の走査）で取得できるため、可能な
# 範囲で事後検査（スコープ外残置疑いの報告）を行い、スコープ内をリバートしてから
# fail-closed で exit 1 する（ループ停止。以降のスキルも同じ git 障害に当たるため
# skip 継続に意味がない）。
if ! git -c status.renames=false status --porcelain -z -uall > "${SNAP_AFTER}"; then
  echo "エラー: npx 実行後の git status 取得に失敗しました。porcelain レコードでの前後比較ができません。" >&2
  if REPO_STATE_AFTER="$(repo_state_signature)"; then
    if [[ "${REPO_STATE_BEFORE}" != "${REPO_STATE_AFTER}" ]]; then
      echo "エラー: スコープ外（skills-lock.json / .agents/skills/${SKILL_NAME}/ 以外）へも書き込まれた可能性があります（状態シグネチャ不一致）。git status / git diff で手動確認してください（削除はしていません）。" >&2
    fi
  else
    # シグネチャも取れない場合は「変化なし」と確認できないため、残置の可能性ありと
    # して案内する（fail-closed。green 側へ倒さない）。
    echo "エラー: 実行後の状態シグネチャ取得にも失敗しました。スコープ外残置の可能性を排除できません。git status / git diff で手動確認してください（fail-closed）。" >&2
  fi
  revert_in_scope
  echo "スコープ内（skills-lock.json / .agents/skills/${SKILL_NAME}/）の変更はリバートしました。" >&2
  rm -f "${SNAP_BEFORE}" "${SNAP_AFTER}" "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}" "${NPX_OUTPUT_FILE}"
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
# 判定は 2 軸: (1) porcelain レコード（SNAP_FILTERED_*）と (2) リポジトリ全体の
# 状態シグネチャ（REPO_STATE_*、repo_state_signature の出力）。実行前から M・??
# だったスコープ外ファイルの内容・モードだけの上書きや、ディレクトリの chmod・
# ディレクトリ向け symlink の変更・.gitignore 対象ファイルの上書きは porcelain
# レコードに現れないため、シグネチャ側の不一致だけがそれを検出できる。
# 他の skip 分岐と異なり、ここは
# continue ではなく exit 1 でループ全体を停止する。スコープ外の汚染は自動リバート
# されないため、続行すると最終報告が「clean」でも実際は dirty 残留となり、この
# issue が問題視している状態そのものになる。この時点までに承認・stage 済みの他
# スキル分は index に残ったままになるため、停止後は `git status` で確認し、必要な
# 分だけ `git commit` するか `git reset` で戻すかを判断すること。
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
  revert_in_scope
  rm -f "${SNAP_BEFORE}" "${SNAP_AFTER}" "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}" "${NPX_OUTPUT_FILE}"
  exit 1
fi

rm -f "${SNAP_BEFORE}" "${SNAP_AFTER}" "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}" "${NPX_OUTPUT_FILE}"
```

`npx skills add` は以下を行う:

- upstream の最新スキルをダウンロード
- インストール先（`.agents/skills/<name>/`）を最新化
- `skills-lock.json` の `computedHash` を CLI 算出値で更新

**重要な副作用**: `npx skills add` はインストール済みファイルを最新の upstream 版で上書きする。upstream との同期が目的のため、これは意図した動作である。上記の per-skill clean ガードは `git status --porcelain` を使い、ステージ済み・未ステージ・**未追跡ファイルも含めて**検出する。WIP がある場合は npx 実行前に skip するため、未コミット編集の消失は防止される。

**注意**: clean ガードを通過したスキルについては、npx が即座に `skills-lock.json` と `.agents/skills/<name>/` を書き換える。ユーザー承認（Step 6）の前に変更が確定するため、承認しない場合は Step 6 の案内に従いリバートが必要。

**書き込みスコープの制限（`--agent universal`）**: `npx skills add` はエージェント/パス制限なしで実行すると、検出した各エージェント向けツリー（`.claude/skills/` 等）へも書き込み得る（Issue #410）。しかし clean ガード・Step 5 のプレビュー・Step 6 のリバート・Step 7 の `git add` はいずれも `skills-lock.json` と `.agents/skills/<name>/` のみを対象としており、スコープ外への書き込みが発生すると WIP 上書き・レビュー迂回・「clean 報告後の dirty 残留」が起き得る。`--agent universal` により書き込みは `.agents/skills/<name>/` と `skills-lock.json` に限定され、他エージェントツリー（`.claude/skills/` 等）へは書かない（実測: スクラッチリポジトリで確認済み）。万一 CLI のバージョン更新等でこの前提が崩れて書き込まれた場合も、npx 実行前後のスナップショット比較で fail-closed に停止する（多層防御）。

#### Step 5: 当該スキルの差分を表示する

`git diff` は未追跡ファイルを表示しない。Step 4 の clean ガード（`git status --porcelain`）により
`npx skills add` 実行前の当該ディレクトリは必ず clean であるため、**upstream 側でファイルが増えた
ケースでは、その新規ファイルは例外なく未追跡になる**。tracked diff だけを見せて Step 6 の承認判断へ
進むと、その内容を一切確認しないまま承認できてしまうため、tracked 差分と未追跡ファイルの内容を分けて
両方提示する。

```bash
# 当該スキルにスコープした tracked 差分を表示する
git diff -- skills-lock.json ".agents/skills/${SKILL_NAME}/"

# 未追跡ファイルを列挙し、内容を diff 形式で表示する。
# この集合は Step 7（承認・git add）が新規に取り込む集合、Step 6（拒否・git clean -fd）が
# 削除する集合と同一（.gitignore 対象を除く非追跡ファイル）であり、
# 「プレビュー = 承認 = 拒否」の 3 経路が同じ対象を扱うことを保証する。
# git ls-files の既定出力は改行区切りのため、ファイル名自体に改行を含む未追跡ファイルが
# あると 1 パスが複数の存在しないパスへ分割される。分割後の各 git diff は失敗し || true で
# 握り潰される一方、Step 7 の git add は実ファイルをそのまま取り込むため、内容を表示しない
# まま承認できてしまう（-z / NUL 区切りで防ぐ）。
UNTRACKED_COUNT=0
# git ls-files をプロセス置換へ直接つなぐと、set -euo pipefail はその終了コードを
# 検査しない。失敗（破損 index・権限エラー等）しても while は0回実行され「なし」と
# 誤表示するため、一時ファイルへ書き出し if ! ... で明示的に終了コードを検査する
# （scripts/skills-lock-update.sh と同一のガード）。
UNTRACKED_LIST_FILE="$(mktemp)"
trap 'rm -f "${UNTRACKED_LIST_FILE}"' EXIT
if ! git ls-files -z --others --exclude-standard -- ".agents/skills/${SKILL_NAME}/" > "${UNTRACKED_LIST_FILE}"; then
  echo "エラー: git ls-files が失敗し、未追跡ファイルの一覧化を確認できません。中止します。" >&2
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
  # 確認できないまま承認（Step 7 の git add）だけが通ってしまう非対称を防ぐ。
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
    # --no-index は index を変更しない（git add -N は使わない。Step 6 の拒否経路が
    # index からの git checkout -- で承認済み他スキルの hash を復元する設計に依存しており、
    # intent-to-add エントリの混入はその復元設計と干渉するため）。
    # 差分ありのとき exit 1 を返す仕様のため、表示専用のこの呼び出しに限り || true で
    # set -e の中断を避ける。
    git diff --no-index -- /dev/null "${f}" || true
  fi
done < "${UNTRACKED_LIST_FILE}"
if [[ "${UNTRACKED_COUNT}" -eq 0 ]]; then
  echo "==> 新規（未追跡）ファイル: なし"
fi
```

変更点を確認し、更新された `computedHash` の内容と未追跡ファイルの中身を合わせてユーザーに提示する。

#### Step 6: ユーザーに当該スキルの承認を求める

差分がある場合のみ、ユーザーに「この更新を適用してよいか」を確認する。Step 5 のプレビュー
（`git ls-files --others --exclude-standard`）・本 Step の拒否（`git clean -fd`）・Step 7 の承認
（`git add`）は同じ集合（追跡ファイルの変更 + 非 ignore の未追跡ファイル）を対象とする。
`.gitignore` 対象はいずれの経路でも扱わない。

**却下された場合**は当該スキルのみ即座にリバートして**次スキルへ continue**する（全体を中止しない）:

```bash
# 当該スキルの変更のみをリバート（追跡ファイル）。
# git checkout -- <file> は HEAD ではなく「index（ステージ）」の内容を作業ツリーへ復元する。
# 前スキルの承認変更は git add で既に index に載っているため、checkout 後の作業ツリーにも
# 引き継がれ、承認済み computedHash が消えることはない。
# 2つのパスを1つの `git checkout --` に渡すとアトミックに扱われ、どちらか一方が
# 「追跡対象なし」（初回具現化・untracked のみの書き込み時）で pathspec エラーになると
# コマンド全体が失敗し、もう一方（skills-lock.json）も復元されない。必ず1コマンド1パスで
# 分離し、一方の失敗が他方の復元を阻害しないようにする。
git checkout -- skills-lock.json
git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
# npx が新規作成した未追跡ファイルも削除（Step 4 の clean ガードで実行前は clean を保証済み）
# ${SKILL_NAME} は kebab-case 検証済みのため、対象は当該スキルディレクトリ配下に限定される
git clean -fd ".agents/skills/${SKILL_NAME}/"
```

Step 4 の clean ガードにより `npx` 実行前の当該ディレクトリは clean（未追跡含む）であることが保証されているため、`git clean` で削除される未追跡ファイルは `npx` が作成したものに限られる。`git clean` の対象は kebab-case 検証済みの `${SKILL_NAME}` 配下のみに限定されており、リポジトリ全体には影響しない。

このリバートは「次スキルの `npx skills add` 実行前」に行うため、`skills-lock.json` から戻るのは当該スキル分のみである。`git checkout --` は HEAD ではなく index から復元するため、承認済みの他スキルの hash は index にも作業ツリーにも保持されており、影響を受けない。

#### Step 7: 承認されたスキルを stage する（ループ内で積み上げる）

```bash
# 当該スキルのファイルのみをステージング（tracked 変更 + Step 5 で提示した未追跡ファイル）
git add skills-lock.json ".agents/skills/${SKILL_NAME}/"
```

`skills-lock.json` は単一 JSON ファイルのため行単位での部分ステージは現実的でない。しかし Step 1 の事前ガードで実行開始時の clean 状態を保証しているため、ファイル全体をステージしても sync 由来の変更のみが含まれ、無関係な編集が混入することはない。このコマンドをループ内で実行することで、複数スキルの全スキル sync でも処理した全スキルが過不足なく stage に積み上がる。

### Step 8: コミット提案（ループ後に1回だけ実行）

ループ完了後、stage 済みの全承認スキルをまとめて1コミットにする。

```bash
git commit -m "$(cat <<'EOF'
chore(skills-lock): upstream の最新ハッシュと同期

<変更内容の要約>
EOF
)"
```

ユーザーにコミットしてよいか確認する。承認済みスキルが1つもなかった場合（全却下・差分なし）はコミットせずその旨を伝える。

## skills CLI のバージョン固定と更新手順

**Why**: `npx skills add` をバージョン未固定で実行すると、npx はローカルキャッシュに無い場合レジストリのその時点の最新版を確認なしで即時取得・実行する。`skills`（vercel-labs/skills）パッケージが乗っ取られた場合、これは任意コード実行の経路になる。しかもこの実行は Step 5 の差分確認・Step 6 のユーザー承認より**前**に走るため、source の `Fandhe-AI/<repo>` 完全一致検証では防げない。exact 版（`X.Y.Z`。dist-tag・`^`/`~` レンジは禁止）への固定が信頼アンカーになる。

**固定版の決め方**:
1. `npm view skills version` で現在の latest を確認する
2. `npm view skills repository.url` が `vercel-labs/skills` であることを確認する
3. `npm view skills time --json` 等で公開日時が不自然でないことを確認する
4. upstream リポジトリの該当タグ間の差分・リリースノートを確認し、問題なければ採用する

**更新手順**:
1. `scripts/skills-lock-update.sh` の `SKILLS_CLI_VERSION` と、本ファイルの Step 4 フェンス内の `SKILLS_CLI_VERSION` を**同一コミット**で更新する（値は完全一致させる）
2. `node --test skills/sync-skills-lock/tests/` で両ファイルの一致を検証する
3. **`universal` が新版でも有効な agent id であることを確認する**。無効値へ変わっていた場合、CLI はエラー表示のうえ `exit 0` の no-op になる（実測: `skills@1.5.22` で確認済み）ため、気付かずに運用すると「同期したつもりで何も更新されていない」状態になる。確認方法: スクラッチリポジトリで 1 スキルを実際に `--agent universal` で実行し、出力に `Invalid agents` が出ないこと、および `.agents/skills/<name>/` が実際に更新されることを確認する
4. 1 スキルで実際に実行し、差分が正常であること・書き込みが `.agents/skills/<name>/` と `skills-lock.json` のみに限定されていること（`git status --porcelain` に `.claude/` 等の他ツリーが現れないこと）を確認する
5. `chore(sync-skills-lock): skills CLI を X.Y.Z へ更新` でコミットする

**fail-closed**: 固定版が解決できない場合（該当版の不存在・レジストリ障害）は `npx` が非ゼロ終了する。黙って最新版へフォールバックする経路は存在せず、dist-tag・レンジ指定への書き換えも禁止する。`npx` の失敗経路でも成功経路と同じスコープ外書き込み検査（後述の「多層防御」）を必ず実行する。停止範囲は実行経路によって異なる: `scripts/skills-lock-update.sh` を単体実行した場合、`npx` 行だけ errexit を無効化して終了コードを保存し、成功・失敗いずれの経路でも事後のスコープ外検査を実行したうえでスクリプト全体を `exit 1` で停止する（この行の前後だけ `set +e`/`set -e` を挟む理由は同スクリプト内のコメント参照）。一方、本ファイルの Step 4 フェンス（複数スキルをループで処理する経路）では、`npx` の失敗を検出したら事後検査のうえ Step 6 の却下時と同じ手順（`git checkout --` / `git clean -fd`）で当該スキル分の部分書き込みをリバートしてから skip（`continue`）して次スキルへ進む — Step 1/3 の他の skip 分岐と同じ制御フローであり、ループ全体を停止させるものではない。事後検査・リバートを挟まずに skip すると、失敗が部分書き込み後に発生した場合の残置変更（スコープ内は次スキルの `git add`（Step 7）が承認済み変更と一緒に stage してしまう、スコープ外は後続処理から「元から存在した dirty 状態」と誤認され得る）を防げないため、両方とも必須の手順である。**スコープ外書き込みの検出（`exit 1`）はこれとは別の停止経路であり、`continue` ではなくループ全体を止める**（詳細は次項「書き込みスコープの制限」を参照）。

## 書き込みスコープの制限（`--agent universal` とスコープ外検出）

`npx skills add` にエージェント/パス制限を付けずに実行すると、CLI が検出した各エージェント向けツリー（`.claude/skills/` 等）へも書き込み得る（Issue #410）。しかし clean ガード（前提条件節・Step 4）・プレビュー（Step 5）・リバート（Step 6）・承認 `git add`（Step 7）はいずれも `skills-lock.json` と `.agents/skills/<name>/` のみを対象としているため、スコープ外への書き込みが発生すると (1) WIP 上書き、(2) レビュー（プレビュー）迂回、(3) 「clean と報告した後の dirty 残留」が起き得る。

2 層で防ぐ:

1. **一次防御（`--agent universal`）**: Step 4 の npx 呼び出しに `--agent universal` を付け、書き込み先を union ストア（`.agents/skills/<name>/`）と `skills-lock.json` のみへ限定する。個別 agent 指定（`claude-code` 等）は `.agents/skills/` を経由せず対象ツリーへ直接コピーしレイアウトを変えてしまうため使わない
2. **多層防御（実行前後スナップショット比較 + 状態シグネチャ比較）**: Step 4 の npx 実行直前・直後に `git status --porcelain -z -uall` でリポジトリ全体のスナップショットを取り、スコープ内（`skills-lock.json` / `.agents/skills/<name>/`）を除いた差分を比較する。加えて、リポジトリルート全体（除外はスコープ内と、`.git` のうち通常の git 操作で変動し得る領域〔index・objects・refs・reflog・一時状態ファイル・lock 等〕のみ。`.git/config`・`.git/hooks/` 等の永続 Git メタデータは署名対象に含め、フック仕込み・設定改変も検出する。`.agents` / `.agents/skills` 自身は実行前に存在した場合のみ署名対象で、実行前に不存在だった場合に限り自身のメタデータを omit して初回インストールの正当な親作成を許容する）の状態シグネチャを `repo_state_signature`（`path_state` を起点 `.` へ適用。python3。通常ファイルは mode + 内容の sha256、シンボリックリンクは mode + リンク先の sha256、ディレクトリ・gitlink は自身の mode + 配下全エントリを再帰的に相対パス・パーミッション・内容ハッシュで集約した sha256）で1本にまとめ、前後で比較する。git status に現れたパスだけをシグネチャ化する方式では、git がディレクトリの mode を追跡しない以上、スコープ外ディレクトリの chmod や `.gitignore` 対象ファイルの上書きを原理的に検出できないため、走査は status 由来のパス集合ではなく作業ツリー全体に対して行う（PR #412 P1 指摘群の同一クラス解消）。ステータス+パスの記録だけでなく全体シグネチャも一致して初めて「変化なし」と判定し、どちらかに差分があれば `--agent universal` が抑止しているはずの書き込みが発生したことを意味し、スコープ内をリバートしたうえで `exit 1` によりループ全体を停止する。**他の skip 分岐（`continue`）とは異なり、この検出はループを継続しない**: スコープ外の汚染は自動リバートされないため、続行すると最終報告が「clean」でも実際は dirty 残留となり、この issue が問題視する状態そのものになるため。停止時点までに承認・stage 済みの他スキル分は index に残ったままになるので、操作者は `git status` で確認したうえで、必要な分だけ `git commit` するか `git reset` で戻すかを判断する

**検出の限界**: `git status --porcelain` は `.gitignore` 対象を報告しないため、porcelain スナップショット比較（判定軸 1）**単独**では ignore されたパスへの書き込みを検出できない。しかし状態シグネチャ比較（判定軸 2）は `.gitignore` 対象を含む作業ツリー全体を走査して内容ハッシュへ取り込むため、ignore されたパスへの書き込みもシグネチャ不一致として検出できる（porcelain 由来の報告一覧に該当パスが載らないだけで、検出・停止自体は機能する）。シグネチャ比較はほかに、npx 実行前から M（追跡・変更済み）や ??（未追跡）だったスコープ外ファイルをステータス文字列・パスとも変えずに内容・パーミッションだけ上書きするケース、およびディレクトリ・gitlink（未初期化 submodule 含む）が異なる状態へ書き換わるケースも検出できる。実際に残る制約は次の 2 点である（いずれも Issue #413 で追跡）: (1) シグネチャの走査から prune している `.git` 配下の変動領域（`.git/objects`・`.git/refs`・`.git/worktrees`・`.git/modules` 等）への書き込みは検出できない。(2) スコープ外検出時のスコープ内リバート（`revert_in_scope`）が使う `git clean -fd` は `-x` を付けないため、`.agents/skills/<name>/` 配下へ書き込まれた `.gitignore` 対象ファイルはリバート後も残置される。この残余リスクは、一次防御（`--agent universal`）が書き込み自体を抑止していることと合わせて小さいと判断する。

## 注意事項

- **全スキル sync での途中却下**: 1スキルずつ承認・stage を行うため、途中で却下しても承認済みスキルの stage は保持される。全スキル処理後に一括コミットする
- **スコープ外書き込みを検出した場合はループ全体が停止する**: 「書き込みスコープの制限」節を参照。`continue` ではなく `exit 1` のため、承認・stage 済みの他スキル分が index に残ったまま処理が止まる。手動で `git status` を確認し、コミットするか `git reset` するかを判断する
- **`skills-lock.json` は実行前 clean 前提で全体をステージする**: 単一 JSON ファイルのため部分ステージは現実的でない。Step 1 の事前ガードで clean を保証し、sync 由来以外の変更の混入を防ぐ
- **ルートの `skills-lock.json` のみを編集**: submodule 配下は手を付けない
- **source 完全一致検証（必須）**: `source` を `OWNER/REPO` へ正規化した上で `Fandhe-AI/<repo>` に完全一致しないエントリは skip する（`contribute-skill` と同じ安全弁）。前方一致では `../` を含む値が通過してしまうため、完全一致の正規表現で検証する。`skills-lock.json` の改ざんや誤設定から防御するため
- **`npx skills add --yes` は上書き確認をスキップする**: upstream に破壊的変更がある場合は `git diff` で内容を必ず確認すること
- **新スキルの取扱い**: ローカルに存在するが upstream に未登録のスキル（`contribute-skill`, `sync-skills-lock` 自身など）は、upstream マージ後に登録する。マージ前に `computedHash` を勝手に書き込まない
- **Step 5 のプレビューは index を変更しない**: 未追跡ファイルの表示に `git add -N`（intent-to-add）ではなく `git diff --no-index` を使う。Step 6 の拒否経路が index からの `git checkout --` で承認済み他スキルの hash を復元する設計に依存しており、i-t-a エントリの混入はその復元設計と干渉するため
- **skills CLI は固定版で実行する**: `npx skills add` はバージョン未固定で実行しない。固定版の決め方・更新手順は「skills CLI のバージョン固定と更新手順」節を参照

## sandbox 環境での実行

このスキルはネットワーク越しの GitHub 操作（`npx skills add` による上流リポジトリの取得等）を必須とする。該当コマンドはコマンド単位で sandbox 無効にして実行する。ネットワーク遮断を解除できない環境では実行できない。

## 検証

コミット後、以下で完了を確認する。

```bash
# skills-lock.json が更新済みであることを確認
git show HEAD -- skills-lock.json | grep computedHash

# 差分なし（sync 完了）を確認
git status --porcelain skills-lock.json
```

- コミットに sync 対象スキルの `computedHash` 更新が含まれること
- ステージ・未ステージに残留変更がないこと

### 未追跡ファイル可視化の手動回帰確認

upstream にファイルが増えたケース（Step 5 のプレビュー拡張が効いているか）は、npx を実行せずに
未追跡ファイルを模擬して確認できる。フラットファイルの追加と、upstream が新規サブディレクトリ
ごと追加する典型ケース（`references/` 等）の両方を確認する。**両ケースで手順3の照合方法が異なる**
点に注意する（後述）。

```bash
# 1a. clean な状態で検証用ファイル（フラット）を作成し、npx が新規ファイルを増やした直後の状態を再現する
touch ".agents/skills/${SKILL_NAME}/__preview_regression_check__.md"

# 1b. 新規サブディレクトリごと追加されるケースも作成する
mkdir -p ".agents/skills/${SKILL_NAME}/__preview_regression_dir__"
touch ".agents/skills/${SKILL_NAME}/__preview_regression_dir__/new.md"

# 2. Step 5 のプレビュー部（上記コマンド）を実行し、両方の検証用ファイルの内容（0 byte でも
#    「新規（未追跡）ファイル — 承認時に git add で取り込まれる集合:」の一覧に、サブディレクトリ
#    配下のファイルも含めてフルパスで名前が出ること）が表示されることを確認する
#    （プレビューは git ls-files ベースのため、ディレクトリではなく個々のファイルパスを列挙する）

# 3. git clean -fdn（dry-run）の一覧と照合する。
#    フラットファイルはプレビューの行と `git clean -fdn` の行が完全一致する。
#    新規サブディレクトリは `git clean -fdn` が個々のファイルではなく親ディレクトリを
#    まとめて1行（`Would remove <dir>/`）で報告するため、行単位の完全一致では照合できない。
#    この場合はプレビューの各ファイルパスが `git clean -fdn` のいずれかの出力行（ファイル
#    自身、またはその祖先ディレクトリ）で始まることを確認する（前方一致で照合する）。
#    完全一致を要求すると、正常に動作しているプレビューを「壊れている」と誤診断する。
git clean -fdn -- ".agents/skills/${SKILL_NAME}/"

# 4. 検証用ファイル・ディレクトリを削除して原状復帰する
rm ".agents/skills/${SKILL_NAME}/__preview_regression_check__.md"
rm -rf ".agents/skills/${SKILL_NAME}/__preview_regression_dir__"
```

## 既存スキルとの関係

- `contribute-skill` でスキル改修が upstream にマージされた後に本スキルを実行する運用を推奨
- `create-commit` の Conventional Commits を踏襲（Step 8）
- 実行可能コマンド集として `scripts/skills-lock-update.sh` を参照
