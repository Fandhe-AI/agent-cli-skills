#!/usr/bin/env bash
# observe-checks-lib.sh — observe-pr.sh の checks --until settled の分類だけを持つ純関数（source 専用）
#
# 呼び出し元: observe-pr.sh（Issue #603 第 8 弾）。HEAD sha の check-run の配列と commit status の配列を受け取り、
#             「合格 / 未完了 / 不合格」の件数に分類する。スクリプト本体から切り出した理由は、テストが 1 回の bash 起動で
#             表の全ケースを渡せるようにするため（lib/pr-push-lib.sh と同じ）。
# 契約: どの関数も exit せず、git・gh・ネットワークを呼ばない。結果は標準出力と return 値だけで返す。
#       source 元のシェル状態を壊さないため set -e / set -u / trap / exit は置かない。二重 source は無害。
# 語彙:
#       check-run   (.conclusion // .status) が success / neutral / skipped なら合格、queued / in_progress / waiting /
#                   pending / requested なら未完了、それ以外はすべて不合格（failure / cancelled / timed_out / action_required /
#                   stale / startup_failure と、未知の語彙。未知を合格にも未完了にも倒さない = merge-gate.sh の
#                   「SUCCESS / NEUTRAL / SKIPPED 以外は green ではない」と同じ側）。
#       commit status  state が success なら合格、pending なら未完了、それ以外（failure / error / 未知）は不合格。
#                   combined status の最上位の state は使わない（status が 0 件でも pending を返すため）。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU・busybox）。paste・bc・mapfile・GNU 専用フラグを使わない。
#
# このファイルは単体実行しない。run-verified.sh のハッシュ照合は scripts/lib/*.sh も対象に含む。
# 読み込み済みを示す変数でのガードは置かない（環境から継承した変数で定義が飛ばされ、偽の関数が使われるのを防ぐ）。

# checks_classify RUNS_JSON STATUSES_JSON
#   RUNS_JSON      check-run オブジェクトの配列（各要素が status を文字列で持つ。conclusion は null か文字列）
#   STATUSES_JSON  commit status オブジェクトの配列（各要素が state を文字列で持つ）
#   標準出力: 「合格 未完了 不合格」（空白区切りの 3 整数）。形が違う入力は何も出力せず return 1（件数を 0 に畳まない）。
checks_classify() {
  jq -nr --argjson runs "${1:-null}" --argjson sts "${2:-null}" '
    def run_bucket:
      (.conclusion // .status) as $v
      | if ($v == "success" or $v == "neutral" or $v == "skipped") then "p"
        elif ($v == "queued" or $v == "in_progress" or $v == "waiting" or $v == "pending" or $v == "requested") then "w"
        else "f" end;
    def st_bucket:
      if .state == "success" then "p" elif .state == "pending" then "w" else "f" end;
    if (($runs | type) == "array" and ($sts | type) == "array"
        and ($runs | all(type == "object" and (.status | type) == "string" and ((.conclusion | type) == "null" or (.conclusion | type) == "string")))
        and ($sts | all(type == "object" and (.state | type) == "string"))) then
      ([$runs[] | run_bucket] + [$sts[] | st_bucket]) as $b
      | "\($b | map(select(. == "p")) | length) \($b | map(select(. == "w")) | length) \($b | map(select(. == "f")) | length)"
    else error("shape") end' 2>/dev/null || return 1
}
