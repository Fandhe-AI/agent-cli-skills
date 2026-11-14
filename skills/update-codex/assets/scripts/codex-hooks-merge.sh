#!/usr/bin/env bash
# codex-hooks-merge.sh — .codex/hooks.json へ「自エントリ」だけを追加・更新する
#
# 呼び出し元: update-codex の SKILL.md（init-codex が最初に置く hooks.json の追補にも使える）。
# 役割: 対象リポジトリの hooks.json には利用者が自分で足した hook が入っていることがある。
#       テンプレートの hooks.json で丸ごと上書きすると消えるため、このスクリプトが管理するのは
#       自エントリだけとし、それ以外（利用者のハンドラ・他のイベント・未知のトップレベルキー）は
#       順序を含めて変えない。
#
# 使い方:
#   codex-hooks-merge.sh --target <.codex/hooks.json> --template <assets/codex/hooks.json> [--check]
#   --check は書き込まず、書いた場合の結果語彙だけを返す（終了コードは通常実行と同じ）。
#
# 自エントリの識別規則:
#   ハンドラ（hooks[].hooks[] の要素）の command が文字列で、次のいずれかを部分一致で含むもの。
#     .codex/hooks/codex-pretooluse.sh
#     .codex/hooks/codex-session-start.sh
#   テンプレート側のハンドラも同じ規則で識別し、含むスクリプト名ごとに 1 つの管理対象とする。
#   matcher・timeout・statusMessage は識別に使わない（利用者が matcher を変えていても自エントリ。
#   ただし PreToolUse の自エントリは matcher がテンプレートと違うと error-matcher で止める）。
#   テンプレートのグループ内で自エントリでないハンドラは管理対象外（追加時にも持ち込まない）。
#
# 挙動（テンプレートの自エントリごと・同じイベントの中で）:
#   - target が無い                    -> テンプレートをそのバイトのまま作成（created）
#   - 自エントリが無い                 -> イベント配列の末尾へ「そのハンドラ 1 つだけを持つグループ」を
#                                         追加（added）。イベント自体が無ければ配列ごと作る
#   - 自エントリが 1 つで内容が違う    -> そのハンドラだけテンプレートの内容に置き換え（updated）。
#                                         所属グループの matcher と他のハンドラは変えない
#                                         （PreToolUse の自エントリは先に matcher を照合する・下記 error-matcher）
#   - すべて同一                       -> 書かない（unchanged。mtime も変えない）
#   added と updated が混ざるときの語彙は updated。
#   書き出しは jq の整形（インデント 2 桁）になるため、利用者が手で整えた空白は変わりうるが、
#   キーと配列の順序・値は変わらない。
#
# 終了コード: 0 成功 / 1 使い方の誤り / 2 入出力・前提（jq 無し・symlink・error-changed 等） / 4 内容の不整合
# stdout の最終行は固定語彙の CODEX_HOOKS_MERGE_RESULT
#   <created|added|updated|unchanged|error-usage|error-no-jq|error-symlink|error-io|error-template|
#    error-target|error-json|error-type|error-duplicate|error-matcher|error-changed>
#   error-json: target が JSON として不正（空ファイル・`{}{}` のような複数文書を含む）/ error-type: 期待する型でない
#   （トップレベルがオブジェクトでない・hooks がオブジェクトでない・イベントが配列でない・
#   グループやハンドラがオブジェクトでない等）/ error-duplicate: 同じイベントに同じ自エントリが 2 つ以上
#   / error-matcher（exit 4）: PreToolUse の自エントリ（codex-pretooluse.sh）の所属グループの matcher が
#   テンプレートの該当グループの matcher と異なる（例: `^Edit$` のグループにある）。Bash に発火せずガードが
#   静かに無効になるため unchanged / updated を返さない。利用者の matcher は書き換えない。
#   SessionStart の自エントリは matcher を検査しない
#   error-changed（exit 2）: 読み込んだあとに target が書き換えられた（target が無いと見て作ろうとしたら
#   他者が先に作っていた場合を含む）。他者の更新を上書きしないため書かずに止める。読み込みの前に
#   target を一時ディレクトリへコピーし、結果はそのコピーから作る。置換（mv）の直前に target がコピーと
#   同じかを比べ、違えば書かない。比べてから mv までの短い間は排他しない（update-docs の agents-section.sh と
#   同じ方式）。再実行すれば最新の内容から作り直す。
#   エラー時は target を一切変更しない。
#
# パスの扱い:
#   - `-` で始まる --target / --template は `./` を前置し、jq・cp・mv などへオプションとして渡らないようにする。
#   - --target の親ディレクトリがシンボリックリンクのときは、リンク先の実体のディレクトリへ書くことを
#     stderr に警告する（止めない。.codex を共有ディレクトリへ向けた構成を許すため。ファイル自体の
#     symlink は従来どおり error-symlink）。
#   - jq の stderr は結果へ載せない（jq の実行時エラーは対象のデータ断片を含み得るため。固定文だけを出す）。
# 一時ファイル: 書き込み用の一時ファイル（<target>.tmp.XXXXXX）は置換の直前に作り、正常・異常終了と
#   TERM を受けたときも EXIT trap で消す（bash は終了時に EXIT trap を走らせる。TERM で実測）。SIGKILL は捕捉できないため、その瞬間に残り得る
#   .tmp.* は人が消す（target は無傷。作ってから mv までの窓は数ミリ秒）。
#
# 単体実行専用（source しない）。bash 3.2 と jq 1.5 以降で動く。
set -euo pipefail

SELF_A='.codex/hooks/codex-pretooluse.sh'
SELF_B='.codex/hooks/codex-session-start.sh'

fail() {
  # $1 終了コード $2 語彙 $3 メッセージ
  echo "エラー: $3" >&2
  echo "CODEX_HOOKS_MERGE_RESULT $2"
  exit "$1"
}

TARGET="" TEMPLATE="" CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      CHECK=1
      shift
      ;;
    --target | --template)
      [[ $# -ge 2 ]] || fail 1 error-usage "$1 に値がない"
      if [[ "$1" == "--target" ]]; then TARGET="$2"; else TEMPLATE="$2"; fi
      shift 2
      ;;
    *) fail 1 error-usage "未知の引数: $1（使い方: --target <hooks.json> --template <hooks.json> [--check]）" ;;
  esac
done
[[ -n "${TARGET}" && -n "${TEMPLATE}" ]] || fail 1 error-usage "--target と --template は必須"
# `-` 始まりのパスがコマンドのオプションとして解釈されないよう、相対パスに ./ を前置する
case "${TARGET}" in -*) TARGET="./${TARGET}" ;; esac
case "${TEMPLATE}" in -*) TEMPLATE="./${TEMPLATE}" ;; esac
command -v jq > /dev/null 2>&1 || fail 2 error-no-jq "jq が見つからない（jq を入れてから再実行する）"
[[ -f "${TEMPLATE}" && -r "${TEMPLATE}" ]] || fail 2 error-template "--template のファイルを読めない"
jq -e 'type == "object" and ((.hooks | type) == "object")' "${TEMPLATE}" > /dev/null 2>&1 \
  || fail 2 error-template "--template が hooks オブジェクトを持つ JSON ではない"
[[ ! -L "${TARGET}" ]] || fail 2 error-symlink "--target はシンボリックリンク（mv で置換すると実体を壊すため扱わない）"
[[ ! -e "${TARGET}" || -f "${TARGET}" ]] || fail 2 error-target "--target は通常ファイルではない"
PARENT=$(dirname -- "${TARGET}")
[[ -d "${PARENT}" ]] || fail 2 error-io "--target の親ディレクトリが無い"
if [[ -L "${PARENT}" ]]; then
  echo "警告: --target の親ディレクトリ（${PARENT}）はシンボリックリンク。リンク先の実体のディレクトリへ書く" >&2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/codex-hooks-merge.XXXXXX") || fail 2 error-io "一時ディレクトリを作れない"
TMP_OUT=""
cleanup() {
  rm -rf "${WORK}"
  [[ -z "${TMP_OUT}" ]] || rm -f "${TMP_OUT}"
}
trap cleanup EXIT

# 結果と書き出す本文: {result, doc} または {err}。型・重複の違反は error() で投げて catch する。
cat > "${WORK}/merge.jq" <<'JQEOF'
def selfk:
  if type == "object" and ((.command | type) == "string") then
    (if (.command | contains($A)) then $A
      elif (.command | contains($B)) then $B
      else null end)
  else null end;

def valid_groups:
  if type == "array"
    and all(.[]; type == "object"
                  and ((has("hooks") | not)
                        or ((.hooks | type) == "array" and all(.hooks[]; type == "object"))))
  then . else error("type") end;

# target の event へ、テンプレートのハンドラ $h（所属グループ $g）を反映する。
def apply($name; $g; $h):
  ($h | selfk) as $k
  | if (.doc.hooks // {} | has($name) | not) then
      .doc.hooks = ((.doc.hooks // {}) + {($name): [$g | .hooks = [$h]]}) | .st += ["added"]
    else
      (.doc.hooks[$name] | valid_groups) as $groups
      | [ $groups | to_entries[] | .key as $gi
          | ((.value.hooks // []) | to_entries[] | select(.value | selfk == $k) | [$gi, .key]) ] as $pos
      | if ($pos | length) == 0 then
          .doc.hooks[$name] += [$g | .hooks = [$h]] | .st += ["added"]
        elif ($pos | length) > 1 then error("duplicate")
        elif $k == $A and (($groups[$pos[0][0]].matcher // null) != ($g.matcher // null)) then error("matcher")
        elif ($groups[$pos[0][0]].hooks[$pos[0][1]]) == $h then .st += ["unchanged"]
        else .doc.hooks[$name][$pos[0][0]].hooks[$pos[0][1]] = $h | .st += ["updated"]
        end
    end;

try (
  if type != "object" then error("type") else . end
  | (if has("hooks") and ((.hooks | type) != "object") then error("type") else . end)
  | { doc: ., st: [] } as $init
  | reduce ($tmpl[0].hooks | to_entries[]) as $ev ($init;
      $ev.key as $name
      | reduce ($ev.value[]?) as $g (.;
          reduce (($g.hooks // [])[] | select(selfk != null)) as $h (.;
            apply($name; $g; $h))))
  | { result: (if (.st | index("updated")) then "updated"
                elif (.st | index("added")) then "added"
                else "unchanged" end),
      doc: .doc }
) catch { err: . }
JQEOF

# 読み込みの前に target のコピーを取り、以降の判定と結果の生成はすべてこのコピー（SNAP）から行う。
# 置換の直前に target がコピーと同じかを比べ、読んだあとの他者の更新を上書きしない。
NEW="${WORK}/new"
SNAP="${WORK}/snap"
if [[ ! -e "${TARGET}" ]]; then
  mode=created
  cat "${TEMPLATE}" > "${NEW}"
else
  cat "${TARGET}" > "${SNAP}" || fail 2 error-io "--target を読めない"
  # 空ファイルは文書数 0、不正 JSON は jq が非 0 で終わる。`{}{}` のような複数文書は文書数が 2 以上になる。
  # 最初の文書だけを書き戻すと後ろの文書を消すため、ちょうど 1 文書のときだけ先へ進む
  jq -e -s 'length == 1' "${SNAP}" > /dev/null 2>&1 \
    || fail 4 error-json "--target が JSON として不正（空ファイル・複数文書を含む）。ファイルは変更しない"
  RES="${WORK}/res.json"
  jq -c --slurpfile tmpl "${TEMPLATE}" --arg A "${SELF_A}" --arg B "${SELF_B}" \
    -f "${WORK}/merge.jq" "${SNAP}" > "${RES}" 2> /dev/null \
    || fail 2 error-io "jq の実行に失敗した（対象のデータは出力しない）"
  err=$(jq -r '.err // empty' "${RES}")
  case "${err}" in
    "") ;;
    type) fail 4 error-type "期待する型でない（トップレベル・hooks はオブジェクト、イベントは配列、グループとハンドラはオブジェクト）。ファイルは変更しない" ;;
    matcher) fail 4 error-matcher "PreToolUse の自エントリ（codex-pretooluse.sh）が、テンプレートと違う matcher のグループにある。Bash に発火せずガードが無効になるため、利用者の matcher は書き換えずファイルを変更しない（自エントリをテンプレートの matcher のグループへ移すか、そのグループの matcher を直す）" ;;
    duplicate) fail 4 error-duplicate "同じイベントに同じ自エントリが 2 つ以上ある。どれを残すか決められないためファイルは変更しない" ;;
    *) fail 2 error-io "想定外のエラー（jq の実行時エラー。対象のデータは出力しない）" ;;
  esac
  mode=$(jq -r '.result' "${RES}")
  if [[ "${mode}" != "unchanged" ]]; then
    jq '.doc' "${RES}" > "${NEW}" || fail 2 error-io "結果の整形に失敗"
  fi
fi

if [[ "${mode}" == "unchanged" || "${CHECK}" -eq 1 ]]; then
  echo "CODEX_HOOKS_MERGE_RESULT ${mode}"
  exit 0
fi

# ---- 原子的な書き込み（同一ディレクトリの一時ファイル -> mv） ----
TMP_OUT=$(mktemp "${TARGET}.tmp.XXXXXX") || fail 2 error-io "一時ファイルを作れない"
if [[ "${mode}" != "created" ]]; then
  cp -p "${TARGET}" "${TMP_OUT}" || fail 2 error-io "権限を引き継げない"
else
  m=$(umask)
  chmod "$(printf '%03o' $((0666 & ~0${m})))" "${TMP_OUT}" || fail 2 error-io "権限を設定できない"
fi
cat "${NEW}" > "${TMP_OUT}" || fail 2 error-io "一時ファイルへ書けない"
# 置換の直前に、読んだときの状態から変わっていないことを確かめる（変わっていたら他者の更新を上書きしない）
if [[ "${mode}" == "created" ]]; then
  [[ ! -e "${TARGET}" && ! -L "${TARGET}" ]] \
    || fail 2 error-changed "target が無いと見て作る間に他者が作った。他の更新を上書きしないため書かない（再実行する）"
else
  cmp -s "${TARGET}" "${SNAP}" \
    || fail 2 error-changed "読み込んだあとに target が書き換えられた。他の更新を上書きしないため書かない（再実行する）"
fi
mv -f "${TMP_OUT}" "${TARGET}" || fail 2 error-io "置換できない"
TMP_OUT=""
echo "CODEX_HOOKS_MERGE_RESULT ${mode}"
