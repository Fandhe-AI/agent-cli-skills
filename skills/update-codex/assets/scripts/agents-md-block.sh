#!/usr/bin/env bash
# agents-md-block.sh — AGENTS.md の「管理区間」だけを差し替える
#
# 呼び出し元: init-codex / init-opencode / update-codex / update-opencode の各 SKILL.md。
# 役割: 4 スキルはどれも対象リポジトリの AGENTS.md に Codex / OpenCode 共通の指示を書く。
#       AGENTS.md には setup-repo-guards が置く ai-review のレビュー観点集など人が育てた本文が
#       あるため、マーカー区間の中身だけを管理し、区間外のバイトは 1 つも変えない。
#       どのスキルをどの順で何回実行しても区間は 1 つ（同じマーカーを共有する）。
#
# 使い方:
#   agents-md-block.sh --target <AGENTS.md> --block <区間の中身ファイル> [--check]
#   --check は書き込まず、書いた場合の結果語彙だけを返す（終了コードは通常実行と同じ）。
#
# マーカー（それぞれ単独の 1 行。行末の空白・CR は無視、行頭の字下げは不可）:
#   <!-- agent-cli-skills:agents-md:start -->
#   <!-- agent-cli-skills:agents-md:end -->
#
# 挙動:
#   - ファイル無し           -> 区間だけの新規作成（created）
#   - 区間無し               -> 末尾へ追記（appended）。既存バイトは不変。末尾改行が無ければ
#                               区切りの改行を区間側で足し、空行 1 つを挟んで区間を置く
#   - 区間 1 組（start < end）-> start/end の間だけ差し替え（replaced）。区間外は不変
#   - 結果が現状と同一       -> 書かない（unchanged。mtime も変えない）
#   - 片方だけ・2 組以上・逆順 -> 非 0 で終了しファイルを変えない（error-markers）
#
# コードフェンス: ``` / ~~~ のフェンス内の行はマーカーとして数えない（update-root-body.sh と同じ
#   規則。字下げ 3 桁まで・開きより短い閉じは無効）。閉じ忘れのフェンスは以降がすべてコード扱いに
#   なり本物のマーカーを見落とすため、error-fence で止める。
# 既存のマーカー行（CRLF を含む）は差し替え時もそのバイトのまま残す。追記時に足すマーカーは LF。
#
# 32768 バイト超: Codex が AGENTS.md を読む上限。書き込みは行い、stderr へ警告だけ出す。
#
# 読み込みと書き込みの間の更新（lost update）: 走査の前に --target を一時ディレクトリへコピーし、
#   判定と結果の生成はすべてそのコピーから行う。置換（mv）の直前に --target がコピーと同じかを比べ、
#   違えば書かずに error-changed で止める（target が無いと見て作る間に他者が作った場合も同じ）。
#   他者の更新を上書きしないための検知で、比べてから mv までの短い間は排他しない。再実行すれば最新の
#   内容から作り直す。update-docs の agents-section.sh と同じ方式。
# パスの扱い: `-` で始まる --target / --block は `./` を前置し、cat・cp・mv などへオプションとして
#   渡らないようにする。--target の親ディレクトリがシンボリックリンクのときは、リンク先の実体の
#   ディレクトリへ書くことを stderr に警告する（止めない。ファイル自体の symlink は従来どおり
#   error-symlink）。
# 一時ファイル: 書き込み用の一時ファイル（<target>.tmp.XXXXXX）は置換の直前に作り、正常・異常終了と
#   TERM を受けたときも EXIT trap で消す（bash は終了時に EXIT trap を走らせる。TERM で実測）。SIGKILL は捕捉できないため、その瞬間に残り得る .tmp.* は
#   人が消す（target は無傷。作ってから mv までの窓は数ミリ秒）。
#
# 終了コード: 0 成功 / 1 使い方の誤り / 2 入出力・前提（error-changed を含む）/ 4 マーカー・フェンス不整合
# stdout の最終行は固定語彙の AGENTS_MD_BLOCK_RESULT <created|appended|replaced|unchanged|error-...>。
#
# 単体実行専用（source しない）。bash 3.2 と BSD/GNU の POSIX ツールだけで動く。
set -euo pipefail

START='<!-- agent-cli-skills:agents-md:start -->'
END='<!-- agent-cli-skills:agents-md:end -->'
LIMIT=32768

fail() {
  # $1 終了コード $2 語彙 $3 メッセージ
  echo "エラー: $3" >&2
  echo "AGENTS_MD_BLOCK_RESULT $2"
  exit "$1"
}

TARGET="" BLOCK="" CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      CHECK=1
      shift
      ;;
    --target | --block)
      [[ $# -ge 2 ]] || fail 1 error-usage "$1 に値がない"
      if [[ "$1" == "--target" ]]; then TARGET="$2"; else BLOCK="$2"; fi
      shift 2
      ;;
    *) fail 1 error-usage "未知の引数: $1（使い方: --target <AGENTS.md> --block <file> [--check]）" ;;
  esac
done
[[ -n "${TARGET}" && -n "${BLOCK}" ]] || fail 1 error-usage "--target と --block は必須"
# `-` 始まりのパスがコマンドのオプションとして解釈されないよう、相対パスに ./ を前置する
case "${TARGET}" in -*) TARGET="./${TARGET}" ;; esac
case "${BLOCK}" in -*) BLOCK="./${BLOCK}" ;; esac
[[ -f "${BLOCK}" && -r "${BLOCK}" ]] || fail 2 error-block-unreadable "--block のファイルを読めない"
[[ ! -L "${TARGET}" ]] || fail 2 error-symlink "--target はシンボリックリンク（mv で置換すると実体を壊すため扱わない）"
[[ ! -e "${TARGET}" || -f "${TARGET}" ]] || fail 2 error-target "--target は通常ファイルではない"
PARENT=$(dirname -- "${TARGET}")
[[ -d "${PARENT}" ]] || fail 2 error-io "--target の親ディレクトリが無い"
if [[ -L "${PARENT}" ]]; then
  echo "警告: --target の親ディレクトリ（${PARENT}）はシンボリックリンク。リンク先の実体のディレクトリへ書く" >&2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/agents-md-block.XXXXXX") || fail 2 error-io "一時ディレクトリを作れない"
TMP_OUT=""
cleanup() {
  rm -rf "${WORK}"
  [[ -z "${TMP_OUT}" ]] || rm -f "${TMP_OUT}"
}
trap cleanup EXIT

# ---- 区間の中身の検査 ----
# 中身にマーカー文字列があると区間が壊れる。フェンスの内外を問わず拒否する。
if grep -qF -e "${START}" -e "${END}" -- "${BLOCK}"; then
  fail 4 error-block-marker "--block の中身に管理マーカーの文字列が含まれている"
fi
[[ -s "${BLOCK}" ]] || fail 2 error-block-empty "--block が空"

# 末尾改行を保証した中身（コマンド置換は末尾改行を落とすため、ファイルのまま扱う）
BLK="${WORK}/blk"
cat -- "${BLOCK}" > "${BLK}"
if [[ -n "$(tail -c 1 "${BLK}")" ]]; then printf '\n' >> "${BLK}"; fi

# ---- 走査: フェンス外のマーカー位置 ----
# 出力 1 行: <start行> <end行> <startの数> <endの数> <フェンスが閉じていないとき 1>
scan() {
  LC_ALL=C awk -v S="${START}" -v E="${END}" '
    function rtrim(s) { sub(/[ \t\r]+$/, "", s); return s }
    {
      t = $0; sub(/\r$/, "", t); sub(/^ ? ? ?/, "", t)
      c = substr(t, 1, 1); run = 0
      if (c == "`" || c == "~") { while (substr(t, run + 1, 1) == c) run++ }
      if (!infence) {
        if (run >= 3) {
          rest = substr(t, run + 1)
          if (c == "~" || index(rest, "`") == 0) { infence = 1; fch = c; flen = run; next }
        }
        s = rtrim($0)
        if (s == S) { ns++; sl = NR } else if (s == E) { ne++; el = NR }
      } else {
        if (c == fch && run >= flen && substr(t, run + 1) ~ /^[ \t]*$/) infence = 0
      }
    }
    END { printf "%d %d %d %d %d\n", sl + 0, el + 0, ns + 0, ne + 0, infence + 0 }
  ' "$1"
}

warn_size() {
  local size
  size=$(wc -c < "$1" | tr -d ' ')
  if [[ "${size}" -gt "${LIMIT}" ]]; then
    echo "警告: 書き込み後の AGENTS.md は ${size} バイトで Codex の読み込み上限 ${LIMIT} バイトを超える（超過分は読まれない）" >&2
  fi
}

NEW="${WORK}/new"
SNAP="${WORK}/snap"
if [[ ! -e "${TARGET}" ]]; then
  mode=created
  { printf '%s\n' "${START}"; cat "${BLK}"; printf '%s\n' "${END}"; } > "${NEW}"
else
  # 以降の判定と結果の生成はすべてこのコピーから行う（置換の直前に --target と比べる）
  cat -- "${TARGET}" > "${SNAP}" || fail 2 error-io "AGENTS.md を読めない"
  SCAN1="${WORK}/scan1"
  scan "${SNAP}" > "${SCAN1}" || fail 2 error-io "AGENTS.md を走査できない"
  read -r sl el ns ne infence < "${SCAN1}" || fail 2 error-io "走査結果を読めない"
  [[ "${infence}" -eq 0 ]] \
    || fail 4 error-fence "コードフェンスが閉じていない。マーカーの位置を判定できないため変更しない（フェンスを閉じてから再実行する）"
  if [[ "${ns}" -eq 0 && "${ne}" -eq 0 ]]; then
    mode=appended
    {
      cat "${SNAP}"
      if [[ -s "${SNAP}" ]]; then
        if [[ -n "$(tail -c 1 "${SNAP}")" ]]; then printf '\n'; fi
        printf '\n'
      fi
      printf '%s\n' "${START}"
      cat "${BLK}"
      printf '%s\n' "${END}"
    } > "${NEW}"
  elif [[ "${ns}" -eq 1 && "${ne}" -eq 1 && "${sl}" -lt "${el}" ]]; then
    mode=replaced
    {
      head -n "${sl}" "${SNAP}"
      cat "${BLK}"
      tail -n +"${el}" "${SNAP}"
    } > "${NEW}"
  else
    fail 4 error-markers "管理マーカーが不整合（片方のみ・2 組以上・逆順のいずれか）。ファイルは変更しない"
  fi
  if cmp -s "${NEW}" "${SNAP}"; then mode=unchanged; fi
fi

if [[ "${mode}" == "unchanged" || "${CHECK}" -eq 1 ]]; then
  [[ "${mode}" == "unchanged" ]] || warn_size "${NEW}"
  echo "AGENTS_MD_BLOCK_RESULT ${mode}"
  exit 0
fi

# ---- 原子的な書き込み（同一ディレクトリの一時ファイル -> mv） ----
TMP_OUT=$(mktemp -- "${TARGET}.tmp.XXXXXX") || fail 2 error-io "一時ファイルを作れない"
if [[ "${mode}" != "created" ]]; then
  # 権限・所有を引き継ぐため、既存ファイルのコピーへ内容だけ上書きする
  cp -p -- "${TARGET}" "${TMP_OUT}" || fail 2 error-io "権限を引き継げない"
else
  m=$(umask)
  chmod "$(printf '%03o' $((0666 & ~0${m})))" "${TMP_OUT}" || fail 2 error-io "権限を設定できない"
fi
cat "${NEW}" > "${TMP_OUT}" || fail 2 error-io "一時ファイルへ書けない"
# 置換の直前に、走査したときの内容から変わっていないことを確かめる（変わっていたら他者の更新を上書きしない）
if [[ "${mode}" == "created" ]]; then
  [[ ! -e "${TARGET}" && ! -L "${TARGET}" ]] \
    || fail 2 error-changed "AGENTS.md が無いと見て作る間に他者が作った。他の更新を上書きしないため書かない（再実行する）"
else
  cmp -s "${TARGET}" "${SNAP}" \
    || fail 2 error-changed "走査のあとに AGENTS.md が書き換えられた。他の更新を上書きしないため書かない（再実行する）"
fi
mv -f -- "${TMP_OUT}" "${TARGET}" || fail 2 error-io "置換できない"
TMP_OUT=""
warn_size "${TARGET}"
echo "AGENTS_MD_BLOCK_RESULT ${mode}"
