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
- **消費側リポジトリが commit 済み local patch を持つ場合**: vendored skill（`.agents/skills/` 配下）へ commit 済みの local patch を適用しているリポジトリは、その検証・再適用の入口として repository-owned checker `scripts/check-skill-local-patches.sh`（無引数 = check / `apply` の 2 モード）と台帳 `.agents/skills/LOCAL-PATCHES.md` を持つ。commit 済み patch は上記 clean ガードでは保護できないため、checker が存在する場合は同期の前後（Step 4 の pre-check・Step 5.5 の apply + 最終検証）での成功が必須（非 0 は fail-closed で同期・stage しない）。台帳があるのに checker が無い状態も検証不能として fail-closed で停止する。checker（apply）の書き込み先は当該スキルディレクトリ・`skills-lock.json`・durable patch 置き場 `scripts/local-patches/` に限る契約とし、範囲外の変更は各実行直後の digest 比較で fail-closed に検出する（検出範囲は Git が追跡・列挙する対象に限る best-effort であり、書き込み制限の保証ではない。保証はユーザーによる checker 内容レビュー + blob hash 承認が担う。詳細は Step 4 の「検出範囲の限界」コメント）。checker は消費側が配置する実行可能コードのため「存在するだけ」では実行せず、HEAD に commit 済みで worktree と一致し、かつユーザーへ由来・内容を提示して blob hash 単位の明示承認を得た場合のみ実行する（Step 4 で機械検証）

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

# 消費側リポジトリが vendored skill へ commit 済み local patch を適用している場合
# (台帳: .agents/skills/LOCAL-PATCHES.md)、commit 済み patch は上の clean ガードを
# 通過してしまうため、npx より前に repository-owned checker(check mode)を必須にする。
# checker 非 0、および台帳があるのに checker が無い状態は、fail-closed で npx を
# 実行しない(同期を開始しない)
if [[ -f scripts/check-skill-local-patches.sh ]]; then
  # checker は導入先リポジトリが配置する実行可能コードであり、「存在するだけ」で実行しては
  # ならない(未信頼な checkout・未レビュー PR の任意コードが、差分提示・承認より前に
  # ユーザー権限で走る経路になる)。実行前に次の両方を満たすことを確認する(fail-closed):
  #   (1) HEAD に commit 済みで、worktree の内容が HEAD の blob と一致する
  #       (未追跡・未コミット変更の checker は拒否 = レビューを経ていないコードを実行しない)
  #   (2) ユーザーへ由来と内容を提示し、この blob hash に対する実行の明示承認を得ている
  #       (承認は hash 単位で本フロー全体に有効。内容が変われば再承認。
  #        提示: git log -1 -- scripts/check-skill-local-patches.sh /
  #              git show HEAD:scripts/check-skill-local-patches.sh)
  CHECKER_HASH="$(git hash-object -- scripts/check-skill-local-patches.sh)"
  if [[ "${CHECKER_HASH}" != "$(git rev-parse HEAD:scripts/check-skill-local-patches.sh 2>/dev/null || true)" ]]; then
    echo "エラー: checker が HEAD に commit 済みの内容と一致しません(未 commit・未追跡・未コミット変更)。任意コード実行を防ぐため同期しません(fail-closed)。"
    exit 1
  fi
  echo "CHECKER_HASH=${CHECKER_HASH}  # 実行承認の対象となる blob hash。由来・内容と合わせてユーザーへ提示する"
  # ユーザー承認(上記 (2))を得たら、承認された hash を CHECKER_APPROVED_HASH に設定する。
  # 承認は変数の設定によってのみ成立し、未設定・不一致のまま checker を実行する経路は無い
  if [[ "${CHECKER_APPROVED_HASH:-}" != "${CHECKER_HASH}" ]]; then
    echo "エラー: checker はユーザー承認済みの blob hash(CHECKER_APPROVED_HASH)と一致する場合のみ実行できます。承認を得てから再実行してください(fail-closed)。"
    exit 1
  fi

  # durable patch 置き場は承認時に directory ごと stage し、却下時に index からの復元 +
  # git clean の対象になるため、未 stage の WIP・未追跡ファイルが残っていると巻き込まれて
  # 失われる。staged のみの変更(= 本ループ内で承認済みに積み上がった分)は許容する。
  # producer(git status)を grep -q へ直接 pipe すると、-q の早期終了による SIGPIPE で
  # pipefail 下のパイプラインが偽になり WIP を見逃し得るため、一旦変数へ取得してから判定する
  LOCAL_PATCHES_STATUS="$(git status --porcelain -- scripts/local-patches/)"
  if grep -q '^.[^ ]' <<<"${LOCAL_PATCHES_STATUS}"; then
    echo "エラー: scripts/local-patches/ に未 stage の変更・未追跡ファイルがあります。承認・却下経路が巻き込むため同期しません(fail-closed)。"
    exit 1
  fi
  # 契約範囲(skills-lock.json / 当該スキル / durable patch)外の状態 digest。worktree 側は
  # 「HEAD を基底にした一時 index へ範囲外のみ git add -A」した tree hash で捉える
  # (未追跡・削除を含む全ファイルが実 blob hash で比較され、diff の表示文字列に依存しない
  # = dirty なバイナリの上書きも検出する。範囲内は HEAD のまま固定されるため同期による
  # 正当な変更では digest が動かない)。index 側は ls-files -s の blob hash で捉える。
  # 基準(PRE_OUTSIDE)は checker の初回実行(同期前 check)より前に取得する。check の後に
  # 取得すると、check mode が行った範囲外変更が基準へ取り込まれ検出できなくなる。
  #
  # 【検出範囲の限界(重要)】この digest は Git が追跡・列挙できる対象(非 ignore の
  # worktree / index)に限られる。.gitignore 対象・.git/ 配下(config・hooks 等)・
  # リポジトリ外への書き込みは検出できない。同一権限で任意コードを実行した後の
  # tree 比較は書き込み制限の「保証」にはならず、信頼アンカーはあくまで実行前の
  # ユーザーによる checker 内容レビュー + blob hash 承認である。本検証はその上に
  # 重ねる best-effort の追加防御(defense-in-depth)として扱うこと
  OUTSIDE_PATHSPEC=(. ":(exclude)skills-lock.json" ":(exclude).agents/skills/${SKILL_NAME}" ":(exclude)scripts/local-patches")
  outside_state() {
    local tmp_index_dir wt_tree idx_digest
    tmp_index_dir="$(mktemp -d)"
    GIT_INDEX_FILE="${tmp_index_dir}/index" git read-tree HEAD
    GIT_INDEX_FILE="${tmp_index_dir}/index" git add -A -- "${OUTSIDE_PATHSPEC[@]}"
    wt_tree="$(GIT_INDEX_FILE="${tmp_index_dir}/index" git write-tree)"
    rm -rf "${tmp_index_dir}"
    idx_digest="$(git ls-files -s -z -- "${OUTSIDE_PATHSPEC[@]}" | git hash-object --stdin)"
    echo "${wt_tree}:${idx_digest}"
  }
  PRE_OUTSIDE="$(outside_state)"
  echo "PRE_OUTSIDE=${PRE_OUTSIDE}  # 範囲外検証の基準 digest。Step 5.5 まで同一 shell で保持する(失われたら再設定に使う)"

  # checker の「初回実行より前」に index snapshot を取得する。同期前 check(check mode)も
  # 契約上、契約範囲(当該スキル / skills-lock.json / durable patch)を変更・stage し得るため、
  # npx 失敗時はこの snapshot で契約範囲全体を同期開始前へ戻す(Step 4 の npx 失敗時リバート参照)
  PRE_SYNC_TREE="$(git write-tree)"
  echo "PRE_SYNC_TREE=${PRE_SYNC_TREE}  # npx 失敗時の契約範囲復元に使う snapshot hash"

  # checker の「すべての」実行(同期前 check / Step 5.5 の apply・最終 check)の直後に、
  # 実行結果に関わらず範囲外 digest と checker 自身の blob hash を再検証する。範囲外を
  # 書き換えて非 0 終了するケース・checker 自身を未承認コードへ置換するケースを、次の
  # 実行より前に fail-closed で検出するため
  verify_outside_and_checker() {
    if [[ "$(git hash-object -- scripts/check-skill-local-patches.sh 2>/dev/null || echo missing)" != "${CHECKER_APPROVED_HASH}" ]]; then
      echo "エラー: checker 自身が書き換えられました。未承認コードのため以後実行しません(fail-closed)。"
      return 1
    fi
    if [[ "$(outside_state)" != "${PRE_OUTSIDE}" ]]; then
      echo "エラー: checker が契約範囲外の path を変更しました(fail-closed)。"
      echo "git status --porcelain で範囲外の変更を特定し、tracked は git restore -- <path> / index は git restore --staged -- <path> で手動復旧してください(契約範囲用の却下手順では範囲外は戻りません)。checker 側の修正も必要です。"
      return 1
    fi
    return 0
  }

  echo "==> 同期前の local patch 検証(check)"
  pre_check_rc=0
  bash scripts/check-skill-local-patches.sh || pre_check_rc=$?
  if ! verify_outside_and_checker; then
    echo "(npx は実行していません)"
    exit 1
  fi
  if [[ "${pre_check_rc}" -ne 0 ]]; then
    echo "エラー: 同期前の local patch 検証に失敗しました。修復してから再実行してください(fail-closed。npx は実行していません)。"
    exit 1
  fi
elif [[ -f .agents/skills/LOCAL-PATCHES.md ]]; then
  echo "エラー: .agents/skills/LOCAL-PATCHES.md があるのに scripts/check-skill-local-patches.sh がありません。local patch を検証できないため同期しません(fail-closed)。"
  exit 1
fi

# skills CLI (vercel-labs/skills) は固定版でのみ実行する（未固定 npx はレジストリ
# 最新版の無検証即時実行になり、差分確認・承認より前に走る supply chain 経路になる）。
# 1つ目の --yes は npx 自体のインストール確認プロンプトのスキップ、末尾の --yes は
# skills CLI へ渡す確認プロンプトのスキップで、別物（位置で区別される）。
SKILLS_CLI_VERSION="1.5.22"   # scripts/skills-lock-update.sh と同一値。更新手順は下記節を参照

# CLI に computedHash を更新させる。固定版が解決できない場合（該当版の不存在・
# レジストリ障害）は npx が非ゼロ終了する。その場合は当該スキルを中止（skip）し、
# 固定版を外した再実行はしない（fail-closed。暗黙の最新版フォールバックはしない）。
# ここでの fail-closed は「他スキルへの処理を止めない」という Step 1/3 の他の skip
# 分岐と同じ意味であり、「script 全体を停止する」という意味ではない
# （`scripts/skills-lock-update.sh` 単体実行時の set -euo pipefail による停止とは別軸。
# 詳細は下記「skills CLI のバージョン固定と更新手順」節の fail-closed 記述を参照）。
npx --yes "skills@${SKILLS_CLI_VERSION}" add "${SOURCE}" --skill "${SKILL_NAME}" --yes || {
  echo "警告: skills@${SKILLS_CLI_VERSION} の実行が失敗しました（該当版の不存在・レジストリ障害・ダウンロード中断等、原因は問わない）。"
  # 失敗が部分書き込み後に発生した場合、skills-lock.json / .agents/skills/${SKILL_NAME}/ が
  # 中途半端な状態のまま残り得る。次スキルの `git add skills-lock.json`（Step 7）が
  # この残置変更を承認済みの変更と一緒に stage してしまわないよう、Step 6 の却下時と
  # 同じ手順で当該スキル分のみを即座にリバートしてから skip する。
  # 2つのパスを1つの `git checkout --` に渡すとアトミックに扱われ、どちらか一方が
  # 「追跡対象なし」（初回具現化・untracked のみの書き込み時）で pathspec エラーになると
  # コマンド全体が失敗し、もう一方（skills-lock.json）も復元されないまま continue してしまう。
  # 必ず1コマンド1パスで分離し、一方の失敗が他方の復元を阻害しないようにする。
  if [[ -f scripts/check-skill-local-patches.sh ]]; then
    # checker を持つリポジトリでは、同期前 check(check mode)が契約範囲(durable patch 含む)を
    # 変更・stage している可能性がある。Step 4 冒頭で取得した PRE_SYNC_TREE で index を
    # 丸ごと同期開始前へ戻してから(前スキルの承認済み積上げは snapshot に含まれるため保持)、
    # 契約範囲の worktree を復元する。snapshot 未設定のまま read-tree すると「現 index からの
    # 誤復元」になるため空値は弾く。skills-lock.json は必須の追跡ファイルであり、
    # checkout 失敗は実復元漏れなので握り潰さない
    : "${PRE_SYNC_TREE:?Step 4 で表示された同期開始前 snapshot を設定してから実行する}"
    git read-tree "${PRE_SYNC_TREE}"
    git checkout -- skills-lock.json
    git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
    git checkout -- scripts/local-patches/ 2>/dev/null || true
    git clean -fd ".agents/skills/${SKILL_NAME}/" scripts/local-patches/
  else
    git checkout -- skills-lock.json
    git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
    git clean -fd ".agents/skills/${SKILL_NAME}/"
  fi
  echo "警告: 固定版を外した再実行はせず、当該スキルの変更をリバートして skip します。"
  continue
}
```

`npx skills add` は以下を行う:

- upstream の最新スキルをダウンロード
- インストール先（`.agents/skills/<name>/`）を最新化
- `skills-lock.json` の `computedHash` を CLI 算出値で更新

**重要な副作用**: `npx skills add` はインストール済みファイルを最新の upstream 版で上書きする。upstream との同期が目的のため、これは意図した動作である。上記の per-skill clean ガードは `git status --porcelain` を使い、ステージ済み・未ステージ・**未追跡ファイルも含めて**検出する。WIP がある場合は npx 実行前に skip するため、未コミット編集の消失は防止される。

**注意**: clean ガードを通過したスキルについては、npx が即座に `skills-lock.json` と `.agents/skills/<name>/` を書き換える。ユーザー承認（Step 6）の前に変更が確定するため、承認しない場合は Step 6 の案内に従いリバートが必要。

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

**checker（`scripts/check-skill-local-patches.sh`）を持つリポジトリの場合**、この時点の diff は **raw な upstream 差分**であり、local patch はまだ再適用されていない(Step 5.5 の再適用後の最終 diff と混同しないこと)。

#### Step 5.5: local patch を再適用して最終検証する（checker を持つリポジトリのみ）

`npx skills add` の上書きで消費側リポジトリの local patch が worktree から消えているため、**stage より前に**再適用と最終検証を行う。checker（apply）は当該スキルディレクトリのほか durable patch（`scripts/local-patches/`）も変更・stage し得るため、(1) 却下・失敗時の厳密復元用に apply 前の index を snapshot し、(2) apply 後は変更集合が契約範囲（`skills-lock.json`・当該スキル・`scripts/local-patches/`）に収まることを機械検証する。すべて成功した場合のみ Step 6 以降へ進める。

```bash
if [[ -f scripts/check-skill-local-patches.sh ]]; then
  # Step 4 と同一 shell セッションの前提を機械検証する。セッションが切れて失われた場合は、
  # outside_state / verify_outside_and_checker(いずれも純粋関数)を Step 4 のとおり再定義し、
  # PRE_OUTSIDE / CHECKER_APPROVED_HASH には Step 4 が表示・承認した値を設定してから進む。
  # 値が不明なまま進んではならない(fail-closed で中止し、Step 6 の却下手順で戻す)
  : "${PRE_OUTSIDE:?Step 4 で表示された基準 digest を設定してから実行する}"
  : "${CHECKER_APPROVED_HASH:?ユーザー承認済みの checker blob hash を設定してから実行する}"

  # 却下・失敗時の厳密復元用に、apply 前の index(= 承認済み積上げ)を tree として保存する。
  # 却下手順(Step 6 の checker 版)は git read-tree でこの snapshot へ index を丸ごと戻すため、
  # apply が stage した変更だけが正確に取り除かれ、承認済みの他スキル分は保持される
  # (Step 4 の pre-check が unmerged index を fail-closed で弾くため write-tree は成立する)
  # snapshot hash は shell 変数にしか存在しないため、後からの復旧に備えて値を必ず表示する
  # (Step 6 の却下手順はこの値を使う)
  PRE_APPLY_TREE="$(git write-tree)"
  echo "PRE_APPLY_TREE=${PRE_APPLY_TREE}  # 却下・復旧(git read-tree)で使う snapshot hash。控えておくこと"

  # 範囲外 digest の基準(PRE_OUTSIDE)・outside_state・verify_outside_and_checker は
  # Step 4 で checker の初回実行より前に定義・取得済みのものを同一 shell セッションで
  # そのまま使う(ここで取り直すと、同期前 check 以降の範囲外変更が基準へ取り込まれてしまう)

  # local patch の再適用(--3way fallback や index 復元により、patch 対象 file や durable patch が
  # stage されることがある)
  apply_rc=0
  bash scripts/check-skill-local-patches.sh apply || apply_rc=$?
  if ! verify_outside_and_checker; then exit 1; fi
  if [[ "${apply_rc}" -ne 0 ]]; then
    echo "エラー: local patch の再適用に失敗しました。Step 6 の却下手順(checker 版。snapshot: ${PRE_APPLY_TREE})で同期前へ戻してください(fail-closed)。"
    exit 1
  fi

  # 再適用後の最終検証(worktree / index / durable patch)
  check_rc=0
  bash scripts/check-skill-local-patches.sh || check_rc=$?
  if ! verify_outside_and_checker; then exit 1; fi
  if [[ "${check_rc}" -ne 0 ]]; then
    echo "エラー: 再適用後の最終検証に失敗しました。Step 6 の却下手順(checker 版。snapshot: ${PRE_APPLY_TREE})で同期前へ戻してください(fail-closed)。"
    exit 1
  fi
fi
```

いずれかが非 0 の場合は **fail-closed で停止**し、Step 6・7(承認・stage)へ進まない。**local patch が欠けた状態を承認済みとして stage してはならない**。復旧は Step 6 の却下手順(checker を持つリポジトリ版)で当該スキルを同期前状態へ戻してから原因を調査する。

#### Step 6: ユーザーに当該スキルの承認を求める

差分がある場合のみ、ユーザーに「この更新を適用してよいか」を確認する。Step 5 のプレビュー
（`git ls-files --others --exclude-standard`）・本 Step の拒否（`git clean -fd`）・Step 7 の承認
（`git add`）は同じ集合（追跡ファイルの変更 + 非 ignore の未追跡ファイル）を対象とする。
`.gitignore` 対象はいずれの経路でも扱わない。

**checker を持つリポジトリの場合、承認の対象は Step 5.5 完了後の最終 diff**（upstream 更新 + local patch 再適用を含む commit 候補。durable patch `scripts/local-patches/` を含む）であり、次で確認する。`git diff HEAD` は未追跡ファイルを表示しないため、未追跡分は Step 5 と同じ手順（`git ls-files -z --others --exclude-standard` で列挙し、`git diff --no-index` / バイナリ判定で内容表示）を契約範囲の path に対して再実行し、tracked 差分と合わせて提示する:

```bash
git diff HEAD -- skills-lock.json ".agents/skills/${SKILL_NAME}/" scripts/local-patches/
# 未追跡分は Step 5 のプレビュー処理(一時ファイル + NUL 区切り + 空/バイナリ判定。
# git ls-files の失敗は fail-closed で中止)を、pathspec を
# ".agents/skills/${SKILL_NAME}/" scripts/local-patches/ の 2 つへ広げて再実行し、
# 名前の列挙だけでなく内容(git diff --no-index / バイナリは種別・サイズ・hash)まで提示する
```

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

**checker を持つリポジトリの却下は次を使う**（Step 5.5 の apply が当該スキルや durable patch の file を index へ stage している可能性があるため、`git checkout --`（index → worktree）だけでは戻らない。Step 5.5 で保存した `PRE_APPLY_TREE` へ index を丸ごと復元してから、worktree を index から戻す）:

```bash
# index を apply 前(= 承認済み積上げ)へ丸ごと復元する。apply が stage した変更だけが
# 取り除かれ、承認済みの他スキル分・durable patch の既存 stage はそのまま保持される。
# PRE_APPLY_TREE は Step 5.5 が表示した snapshot hash。shell を跨いで変数が消えている
# 場合は表示済みの値を代入してから実行する。未設定のまま read-tree すると
# 「post-apply の index のまま worktree だけ戻す」誤復元になるため、空値は必ず弾く
: "${PRE_APPLY_TREE:?Step 5.5 の snapshot hash を設定してから実行する(未設定のまま復元しない)}"
git read-tree "${PRE_APPLY_TREE}"

# worktree を復元済みの index から戻す。初回具現化などで追跡対象が無い path は
# pathspec エラーになるため path ごとに分離し、その失敗のみ無視する(戻す対象自体が無い)
git checkout -- skills-lock.json
git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
git checkout -- scripts/local-patches/ 2>/dev/null || true

# npx・apply が新規作成した未追跡ファイルを削除する
git clean -fd ".agents/skills/${SKILL_NAME}/" scripts/local-patches/
```

対象は kebab-case 検証済みの当該スキルディレクトリ配下・`skills-lock.json`・durable patch（`scripts/local-patches/`）のみで、承認済みの他スキルの stage には影響しない（index snapshot が承認済み積上げそのものを保持しているため）。

#### Step 7: 承認されたスキルを stage する（ループ内で積み上げる）

```bash
# 当該スキルのファイルのみをステージング（tracked 変更 + Step 5 で提示した未追跡ファイル）
git add skills-lock.json ".agents/skills/${SKILL_NAME}/"

# checker を持つリポジトリは、承認対象(Step 6 の最終 diff)に含めた durable patch の
# 変更も同じ承認単位で stage する
if [[ -f scripts/check-skill-local-patches.sh && -d scripts/local-patches/ ]]; then
  git add scripts/local-patches/
fi
```

`skills-lock.json` は単一 JSON ファイルのため行単位での部分ステージは現実的でない。しかし Step 1 の事前ガードで実行開始時の clean 状態を保証しているため、ファイル全体をステージしても sync 由来の変更のみが含まれ、無関係な編集が混入することはない。このコマンドをループ内で実行することで、複数スキルの全スキル sync でも処理した全スキルが過不足なく stage に積み上がる。**checker を持つリポジトリでは Step 5.5(apply + final check)の成功が stage の前提**であり、`computedHash` は npx が書いた upstream 版の値のまま変更しない(local patch で hash を更新しない)。

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
3. 1 スキルで実際に実行し、差分が正常であることを確認する
4. `chore(sync-skills-lock): skills CLI を X.Y.Z へ更新` でコミットする

**fail-closed**: 固定版が解決できない場合（該当版の不存在・レジストリ障害）は `npx` が非ゼロ終了する。黙って最新版へフォールバックする経路は存在せず、dist-tag・レンジ指定への書き換えも禁止する。この失敗時の停止範囲は実行経路によって異なる: `scripts/skills-lock-update.sh` を単体実行した場合はスクリプト全体が `set -euo pipefail` により即座に停止する。一方、本ファイルの Step 4 フェンス（複数スキルをループで処理する経路）では、`npx` の失敗を検出したら Step 6 の却下時と同じ手順（`git checkout --` / `git clean -fd`）で当該スキル分の部分書き込みをリバートしてから skip（`continue`）して次スキルへ進む — Step 1/3 の他の skip 分岐と同じ制御フローであり、ループ全体を停止させるものではない。リバートを挟まずに skip すると、失敗が部分書き込み後に発生した場合の残置変更を次スキルの `git add`（Step 7）が承認済み変更と一緒に stage してしまい得るため必須の手順である。

## 注意事項

- **全スキル sync での途中却下**: 1スキルずつ承認・stage を行うため、途中で却下しても承認済みスキルの stage は保持される。全スキル処理後に一括コミットする
- **`skills-lock.json` は実行前 clean 前提で全体をステージする**: 単一 JSON ファイルのため部分ステージは現実的でない。Step 1 の事前ガードで clean を保証し、sync 由来以外の変更の混入を防ぐ
- **ルートの `skills-lock.json` のみを編集**: submodule 配下は手を付けない
- **source 完全一致検証（必須）**: `source` を `OWNER/REPO` へ正規化した上で `Fandhe-AI/<repo>` に完全一致しないエントリは skip する（`contribute-skill` と同じ安全弁）。前方一致では `../` を含む値が通過してしまうため、完全一致の正規表現で検証する。`skills-lock.json` の改ざんや誤設定から防御するため
- **`npx skills add --yes` は上書き確認をスキップする**: upstream に破壊的変更がある場合は `git diff` で内容を必ず確認すること
- **新スキルの取扱い**: ローカルに存在するが upstream に未登録のスキル（`contribute-skill`, `sync-skills-lock` 自身など）は、upstream マージ後に登録する。マージ前に `computedHash` を勝手に書き込まない
- **Step 5 のプレビューは index を変更しない**: 未追跡ファイルの表示に `git add -N`（intent-to-add）ではなく `git diff --no-index` を使う。Step 6 の拒否経路が index からの `git checkout --` で承認済み他スキルの hash を復元する設計に依存しており、i-t-a エントリの混入はその復元設計と干渉するため
- **skills CLI は固定版で実行する**: `npx skills add` はバージョン未固定で実行しない。固定版の決め方・更新手順は「skills CLI のバージョン固定と更新手順」節を参照
- **local patch の保護（checker を持つリポジトリでは必須）**: npx 前の checker（Step 4）→ 承認前の再適用 + 最終検証 + 契約範囲検証（Step 5.5）→ 成功時のみ stage（Step 7）の順を省略しない。checker 非 0・台帳（`.agents/skills/LOCAL-PATCHES.md`）のみ存在は fail-closed で停止し、local patch が欠けた状態を stage・commit しない。apply が変更し得る durable patch（`scripts/local-patches/`）は承認（Step 6 の最終 diff + 未追跡プレビュー再実行）・stage（Step 7）・却下（`PRE_APPLY_TREE` からの index 復元）のすべてで同じ集合として扱い、未 stage の WIP が同 directory に残る状態では同期を開始しない（Step 4 で fail-closed）。`computedHash` は upstream 版の値を維持する

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
