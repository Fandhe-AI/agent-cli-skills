#!/usr/bin/env bash
# optin-record-lib.sh — observe-pr.sh の optin-record モードの判定だけを持つ純関数（source 専用）
#
# 呼び出し元: observe-pr.sh。マージ前の opt-in テスト記録ゲート（Issue #495）が、PR 本文の記録節のマーカー行
#             `<!-- optin-test-record: <40 桁 sha> <pass|fail|not-run> <コマンド> -->` を、現在の HEAD に対して宣言コマンドごとに
#             何件数えるかを決める。かつてはこの手順（正規化 + 固定文字列の grep）を 1 KB 超のインラインのコマンド列として
#             エージェントのプロンプトに埋め込み、エージェントが書き写して実行していた。書き写しの誤り（バックスラッシュの半減・
#             `\n` の `n` 化など）が結果を黙って変えない形にするため、スクリプトへ移した。判定そのもの（pass が 1 件以上かつ
#             pass 以外が 0 件）はホストの classifyOptinRecordGate に残る。ここは件数を数えるだけ。
# 契約: exit せず、git・gh・ネットワークを呼ばない。結果は標準出力と return 値だけ。set -e / set -u / trap / exit は置かない。二重 source は無害。
# マーカー行の書式は implement-issue-tree.src.js の optinRecordMarkerLine と同じ（書式のずれは tests/optin-tests-gate.test.mjs の群 F が
#             ホストの描画・書き直しの出力をこの関数へ通して検出する）。接頭辞を変えるときは両方を同時に変える。
OPTIN_RECORD_MARKER_PREFIX='<!-- optin-test-record: '

# 宣言コマンドの文字列として許す形か（ホストの OPTIN_TEST_COMMAND_RE と同じ: 先頭が英数字、残りは [A-Za-z0-9 _./:=@+,-]、200 文字以内）。
# 改行や許可外の文字を含む値は grep -F のパターンが複数行に化ける・シェル特殊文字を持ち込むため、gh を呼ぶ前に拒否する
optin_cmd_valid() {
  local rest
  case "$1" in
    '' | [!A-Za-z0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 200 ] || return 1
  rest=${1// /}
  case "${rest}" in
    *[!A-Za-z0-9_./:=@+,-]*) return 1 ;;
  esac
  return 0
}

# PR 本文の正規化（標準入力 → 標準出力）。CR の除去と、行頭・行末の空白の除去。マーカー行は行頭インデントなしで書く契約だが、
# 人手の復旧編集で空白や CRLF が付くことがある。LC_ALL=C のため [[:space:]] は ASCII の空白だけ
optin_record_normalize() {
  tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# 正規化済みの本文に、行全体が `<接頭辞><sha> <result> <コマンド> -->` と一致する行が何件あるか。
# $1 = 正規化済みの本文、$2 = 40 桁の sha、$3 = pass|fail|not-run、$4 = コマンド。標準出力に件数。grep が 0 / 1 以外で終わる（構文エラー等）か
# 件数が数字でないときは return 1（件数を 0 件へ畳み込まない）
optin_record_count() {
  local n rc=0
  n=$(printf '%s\n' "$1" | grep -cxF -- "${OPTIN_RECORD_MARKER_PREFIX}$2 $3 $4 -->") || rc=$?
  [ "${rc}" -le 1 ] || return 1
  case "${n}" in '' | *[!0-9]*) return 1 ;; esac
  printf '%s' "${n}"
}

# 宣言コマンド 1 件の件数を「pass 件数 pass 以外の件数」で出す。pass 以外 = fail + not-run（$H と一致しないマーカー行はどの grep にも
# 一致せず自動的に除かれる = 古い HEAD・base 取り込み前・fix 前の記録は存在しないものとして扱う）。$1 = 正規化済みの本文、$2 = sha、$3 = コマンド
optin_record_counts() {
  local p f nr
  p=$(optin_record_count "$1" "$2" pass "$3") || return 1
  f=$(optin_record_count "$1" "$2" fail "$3") || return 1
  nr=$(optin_record_count "$1" "$2" not-run "$3") || return 1
  printf '%s %s' "${p}" "$((f + nr))"
}
