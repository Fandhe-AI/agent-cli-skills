# update-external の pin SHA 自動追従 — 設計・案の評価・PAT 要件

`.github/workflows/update-external-pin-bump.yml` と実効差分ゲート
（`.github/scripts/check_update_external_drift.py` の `evaluate_pin_impact`）の設計・
採否記録。イシュー #343 の成果物。関連: #259（reusable 化）・#260/#261（乖離検知の
軸再定義）・#302（上流 action SHA 固定検査、本イシューとは別スコープ）・#341（乖離検知
レポートで `PIN-STALE` 22 件がノイズ化した実測）。

## 課題

`Fandhe-AI/actions` の reusable workflow 化（#259）により、`update-external` の
更新ロジック・fail-closed ガード・外部 action の pin は上流 1 ファイルで集中管理される
ようになった。しかし下流 wrapper の `uses: ...@<40-hex>` に書く **pin SHA だけは
skills-update の配布対象外**（配布されるのは `.agents/skills/**` と
`skills-lock.json` のみ）で、各リポへ手 PR を出すしかない。

その結果、乖離検知 CI（#260、run 32059462649 / レポート #341）は wrapper 移行済み
22 リポ**全件**を `PIN-STALE` と報告し、レポートが恒常的にノイズを含んでいた。本来
見るべき所見（`SYNC-CI-ABSENT` 5 件など）が 22 行の `PIN-STALE` に埋もれる。

## 実測した事実（この設計の根拠）

| # | 実測内容 | 結果 |
|---|---------|------|
| E1 | `Fandhe-AI/actions` main 先頭（計画立案時） | `0bd2cf930f5c78732abd539dfd468aa8c1363e15` |
| E2 | `compare/8dea43ee40a7...main` | `ahead_by: 1` / 変更ファイルは `.claude/workflows/implement-issue-tree.js` の 1 件のみ |
| E3 | `compare/0655187f7c71...main` | `ahead_by: 2` / 変更ファイルに `.github/workflows/update-external.yml` を含む（#80 が inputs を追加） |
| E4 | `.github/workflows/update-external.yml` の blob SHA | `0655187f` → `a32cc04879ef5db2e9760470bd7e85edae2822b5`／`8dea43ee` → `828b5d6ea5d9d80d419ead5e60989cfb27d1b104`／main → `828b5d6e…`（`8dea43ee` と同一） |
| E5 | 上流 reusable workflow 内の全 `uses:` | すべて絶対参照 + 40 桁 SHA 固定。`./` によるローカル参照は 0 件 |
| E6 | `Fandhe-AI/actions` の tags / releases | 0 件（Dependabot による SHA 追従は原理的に不可） |
| E7 | 組織シークレット | `SUBMODULE_PAT`（visibility: all）と `CARGO_REGISTRY_TOKEN` のみ。pin 更新専用 PAT `WORKFLOW_PIN_PAT` は未作成のため、この workflow は登録するまで fail-closed で停止する |

### E4 + E5 から導かれる中核の性質

reusable workflow は `uses: <owner>/<repo>/<path>@<sha>` で解決された**そのファイル
だけ**を実行し、そこから呼ばれる composite action は**ファイル内で別 SHA に固定
されている**（E5）。ローカル `./` 参照も無い。

したがって:

> **pin における `.github/workflows/update-external.yml` の内容が main における内容と
> バイト一致するなら、その pin は main と実行上まったく等価である。**

E4 により、`8dea43ee` 群（本リポ `agent-cli-skills` を含む）は 1 コミット遅れているが
**実効差分ゼロ**。一方 `0655187f` 群は blob が実際に異なるため**真の乖離**である。

コミット数ベースの判定は、この 2 種類を区別できない。これがノイズの構造的原因である。

## 案の評価と採否

| 案 | 内容 | 判定 | 理由 |
|----|------|------|------|
| **A** | pin bump PR を全リポへ自動生成する workflow を追加する | **採用（条件付き）** | 唯一の真の自動追従。上流ではなく**本リポに置く**ことで、#259 が案 A（当時の B に相当）を却下した理由（skills-update ジョブの資格情報の面を広げる／自己書き換えの再帰）を回避する。組織横断走査の実績（乖離検知 CI）と `SUBMODULE_PAT` の参照経路が既にこのリポにある。ただし `.github/workflows/**` への書き込みには PAT の Workflows: write が必要で、E7 のとおり保有可否は未確認（下記「PAT 権限」参照） |
| **C′** | `PIN-STALE` の判定を「実効差分がある場合のみ」へ厳密化する | **採用（A と同時）** | 「n コミット以上遅れ」等の緩めた閾値ではなく、上流 workflow ファイルの内容一致という厳密な等価判定に置き換える。実効差分が 1 バイトでもあれば必ず鳴るため検知力を落とさず、コミット数だけずれているリポのノイズだけを構造的に消す |
| B | skills-update の配布対象に `update-external.yml` を追加 | 却下 | #259 で却下済みの案と同一。自己書き換えの再帰・下流固有差分の全置換破壊・sync ジョブの PAT スコープ拡大。加えて上流リポの変更が必要で本リポ単独では実施できない |
| C（原案） | 「n コミット以上遅れ」等でしきい値を緩める | 却下 | しきい値は任意で根拠がなく、上流が workflow を変更しても閾値未満なら黙る。C′ が同じノイズ削減を厳密な根拠で達成する |
| D | 現状維持 | 却下 | 受入条件を満たさない。実施漏れが起きやすく、レポートのノイズも残る |
| E | `@main` 等の可動参照へ変更 | 却下 | 上流 main への任意の push が、書き込み PAT を渡している全リポで即時実行される。サプライチェーン上受容不能。乖離検知は `@main` を `WRAPPER-UNPINNED`（乖離）として扱う設計であり、方針そのものと矛盾する |
| F | pin SHA を skills-update でデータとして配布し `uses:` から参照 | 却下 | 原理的に不可能。`uses:` は式（`${{ }}`）・変数・ファイル参照を受け付けず、リテラルしか書けない |
| G | 上流でタグ／リリースを発行し Dependabot で追従 | 却下 | E6 のとおり上流はタグ 0 件で、Dependabot は SHA pin を「タグの無いリポ」に対して更新できない。タグ発行は別リポの変更。さらに `dependabot.yml` を全対象リポへ配る必要があり、配布問題を別の場所へ移すだけ |

### 採用案の要約

> **実効差分ゲート付き自動 bump（A + C′）**。
> 上流 workflow ファイルの内容一致を「pin の等価性」の唯一の根拠とし、
> (a) 乖離検知はこのゲートで `PIN-STALE` を厳密化し、
> (b) 実効差分があるリポにだけ、本リポの新 workflow が pin bump PR を自動生成する。

## 実効差分ゲートの設計

`check_update_external_drift.py` に追加した純粋関数（`evaluate_pin_impact` の
docstring も参照）:

```text
git_blob_sha(text)                       -> str
has_local_uses(text)                     -> bool
evaluate_pin_impact(pin_text, main_text) -> {"equivalent", "reason", "pin_blob", "main_blob"}
```

判定順（すべて fail-closed = 迷ったら「等価でない」に倒す）:

1. `pin_text is None`（取得失敗）→ 等価でない
2. `has_local_uses(pin_text)` または `has_local_uses(main_text)` が真 → 等価でない
   （ローカル参照があると内容一致だけでは実行等価を主張できない。E5 の前提が将来崩れた
   場合に自動で安全側へ倒れる）
3. `pin_text == main_text`（生テキストの完全一致。改行正規化や `strip()` はしない）
   → **等価**
4. それ以外 → 等価でない

`scan()` は `PIN_BEHIND`（コミット数で遅れている）と判定された pin に対してのみ、
上流の `contents/{path}?ref={pin}` を追加取得してこのゲートを適用する。等価と
判定された pin は `findings` へ積まず、レポートの別バケット
`ScanResult.pins_equivalent`（`(repo, pin, pin_blob)` のリスト）へ積む。

内容取得が `error`（403/429/5xx/解析失敗）のときは**従来どおり `PIN-STALE` として
報告する**。UNKNOWN へは落とさない（見逃さない側へ倒す）。

## 自動 bump（A）の設計

`.github/scripts/bump_update_external_pin.py`。`check_update_external_drift.py` を
`import` して判定ロジック（`classify_workflow` / `evaluate_pin` /
`evaluate_pin_impact`）を再利用する（同スクリプトは `if __name__ == "__main__"`
ガード済みで import に副作用が無い）。

### 対象条件

- `KIND_WRAPPER`（軸 1: 手管理 LEGACY・未 pin・上流本体は対象外）
- `PIN_BEHIND`（軸 2: コミット数で遅れている）
- 実効差分ゲートで `equivalent: False`（bump しても意味の無い pin には触らない）

### 安全策

- 変更するのは `uses:` 行の 40 桁 SHA **1 箇所のみ**（`replace_job_uses_ref`）。
  一致 0 件・2 件以上ならエラーとして書き換えない。置換後に
  `classify_workflow` を再実行し `KIND_WRAPPER` + 新 SHA であることを自己検証する
- **入力契約ゲート（`check_wrapper_contract`、必須・fail-closed）**: 新しい上流
  SHA の `on.workflow_call.inputs` / `secrets` に無いキーを wrapper の
  `with:` / `secrets:` が渡していたら、そのリポは bump せずスキップする。
  reusable workflow は未知の input を渡されるとジョブ起動前に
  `Invalid input, <name> is not defined in the referenced workflow` で失敗するため、
  これを踏むと対象リポ全体の同期が一斉停止する
- 冒頭の「参照 SHA の検証記録」コメントブロックは自動編集しない。最新の検証記録は
  PR 本文に載せる
- `BUMP_LIMIT`（既定 5）で 1 run あたりの PR 数を上限化する。18 本同時発火は
  下流 CI の並列負荷・cancel 残存 check によるマージブロックを招く（既知の
  失敗パターン）
- **auto-merge は付けない。** PR は人間がレビューしてマージする
- `--dry-run`（`workflow_dispatch` の既定値。schedule 実行は常に非 dry-run）で
  対象一覧と契約ゲート結果だけを出力し、書き込み API を呼ばない
- 書き込み API が 403/422 を返したら、作成済みブランチを削除して失敗として報告する
  （下記「PAT 権限が不足していた場合」参照）

### I/O 手順（対象リポごと）

1. 既存 open PR 確認 `GET /repos/{repo}/pulls?head={org}:{branch}&state=open`
   → あればスキップ（冪等）
2. `GET /repos/{repo}/contents/{path}`（blob sha 取得）
3. 置換 + 自己検証 + 入力契約ゲート
4. `GET /repos/{repo}` の `default_branch` → `GET /repos/{repo}/git/ref/heads/{default}`
   で base sha（`main` 決め打ち禁止）
5. `POST /repos/{repo}/git/refs`（422 = 既存 → そのブランチを使い回す）
6. `PUT /repos/{repo}/contents/{path}`（`branch` 指定、`sha` は 2 の blob）
7. `POST /repos/{repo}/pulls`

書き込み系の `gh api` 呼び出しはリクエストボディを `--input -` で stdin から渡す
（`-f key=value` の文字列連結・シェル展開を経由させない。OWASP A03）。

## PAT 権限

この workflow は専用シークレット **`WORKFLOW_PIN_PAT` を必須**とし、組織共有の
`SUBMODULE_PAT` へはフォールバックしない（イシュー #343 Review P1 指摘）。日次 schedule で
組織内の複数リポジトリへブランチ・`.github/workflows/**`・PR を書き込む新しい経路であり、
既存の共有資格情報を転用すると `SUBMODULE_PAT` の実効的な用途面が広がるため。#251 で
スコープを狭めた方向とも逆行する。

### 導入手順（この workflow を有効化する前に必要）

1. pin bump 専用の fine-grained PAT を発行する。権限は `Contents: write` /
   `Pull requests: write` / `Workflows: write`、対象リポジトリは pin 追従の対象に絞る
   （組織全体へ広げない）
2. 本リポジトリのシークレット `WORKFLOW_PIN_PAT` として登録する
3. **既存 `SUBMODULE_PAT` のスコープは広げない**

`WORKFLOW_PIN_PAT` が未設定の間、この workflow は最初のステップで fail-closed に停止する
（「対象 0 件」の成功に化けない）。

### PAT 権限が不足していた場合

`bump_update_external_pin.py` の `PUT` が 403 / 422 を返すと、そのリポの
bump は失敗として報告され（この実行が作成したブランチのみ削除される）、他リポの処理は
継続する（1 リポの失敗が全体を止めない）。`WORKFLOW_PIN_PAT` の権限・対象リポジトリ
の割り当てを見直して再実行する。

実効差分ゲート（C′）自体はこの PAT 権限に依存しない（読み取りのみ）ため、A が
権限不足で止まっても受入条件のうち「レポートのノイズ削減」は独立に成立する。

## 想定されるレビュー指摘と回答

| 指摘 | 回答 |
|------|------|
| 「内容一致で等価と言い切れるのか」 | E5 で上流 workflow 内の全 `uses:` が絶対参照 + SHA 固定・ローカル `./` 参照 0 件であることを実測済み。さらに `has_local_uses` を実行時の前提条件チェックとして実装し、将来ローカル参照が入ったら自動的に従来判定へ戻る |
| 「検知が甘くなるのでは」 | 上流 workflow が 1 バイトでも変われば必ず `PIN-STALE` が出る。むしろ従来より鋭い（コミット数と実効差分が一致しないケースを正しく分離する） |
| 「18 リポ分の PR が一気に出る」 | `BUMP_LIMIT`（既定 5）で日次分割。auto-merge なし |
| 「pin bump で同期が壊れないか」 | 入力契約ゲートが `workflow_call` の inputs / secrets を照合し、契約外キーを渡す wrapper はスキップする |
| 「wrapper 冒頭の検証記録が古くなる」 | 自動編集はせず、最新の検証記録を PR 本文に載せる方針を wrapper コメントと本ドキュメントに明記する |
| 「#302（上流 `uses` の SHA 固定検査を軸 4 へ追加）と重複では」 | 本設計の `has_local_uses` は「内容一致ゲートの健全性前提」を守るためのもので、軸 4 のマーカー追加とは目的が異なる。#302 はスコープ外として維持する |

## 未実測・フォローアップ（受入条件 3 の実測は本リポの実装作業では完結しない）

以下は `gh workflow run --ref <branch>` 等ネットワーク操作を伴い、実装コミット
（ローカルブランチへのコミットのみ・push なし）の範囲では実行できない。push・PR
作成後のフォローアップとして別途実施する:

- 乖離検知 CI の再実行と `PIN-STALE` 件数の実測（変更前 22 件 → 実効差分ゲート適用後の
  期待値・根拠は pin 側 blob sha と main 側 blob sha の比較）
- `update-external-pin-bump.yml` の `dry-run=true` 実行と対象一覧・契約ゲート結果の確認
- 専用 PAT `WORKFLOW_PIN_PAT` の発行とシークレット登録（未登録の間、この workflow は
  最初のステップで fail-closed に停止する。「PAT 権限」節の導入手順を参照）
- 1 リポへの `dry-run=false` 実行による `WORKFLOW_PIN_PAT` の Workflows: write 権限プローブ
  （403/422 なら「PAT 権限が不足していた場合」の手順へ）

## スコープ外

- #302（軸 4 への上流 action SHA 固定マーカー追加）
- #256（`.claude/skills` が実ディレクトリのリポへの同期 CI 導入）
- #299（reusable workflow の `timeout-minutes` を input 化 — 上流リポの変更）
- 下流リポの `.github/workflows/update-external.yml` の手編集（bump workflow が
  PR で行う）
- `Fandhe-AI/actions` リポジトリ自体への変更
