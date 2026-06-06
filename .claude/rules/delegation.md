---
description: 調査・設計フェーズで適用する委譲ルール。main は対話・計画・委譲・報告に徹し、token 消費作業はサブエージェントへ委譲する。
---

# 委譲ルール（調査・設計フェーズ）

## 委譲の原則

main の役割は **対話・計画・委譲・報告** に徹することで、token 消費作業（調査・ファイル作成・編集・レビュー）はサブエージェントへ委譲する。

## パスベースの目安

| 操作対象パス | モード | 適用ルール |
|------------|--------|-----------|
| `_/`・`docs/`・`.claude/` の**閲覧のみ** | 調査・設計モード | 本ファイル（`./delegation.md`） |
| `skills/`・`.claude/agents/`・`.claude/rules/` を**作成・編集** | 作成・編集モード | `./delegation-impl.md` |

## 委譲先マッピング（調査系）

| やりたいこと | subagent_type | model |
|------------|--------------|-------|
| skills/ の横断調査・仕様把握 | `skill-explorer` | sonnet |
| gh / git / CLI / フック失敗の調査 | `sub-investigator` | sonnet |
| 外部ドキュメントや仕様の調査 | `reference-researcher` | sonnet |
| 計画の完了検証 | `plan-verifier` | sonnet |

呼び出し例:

```
subagent_type: skill-explorer
prompt: "skills/ 配下の全スキルの frontmatter を読み、name・description・model を一覧化して"
```

## 並列化

独立したタスクは**同一メッセージ内で複数 Agent を起動**して並列実行する。依存関係がある場合のみ逐次実行。

例: 「skill-explorer で横断調査」と「reference-researcher で外部仕様確認」は並列起動可。

## main が直接やってよいこと

- ユーザーとの対話・要件確認
- 計画立案と `_/local-plans/` への計画ファイル作成
- サブエージェントへの委譲プロンプト生成
- サブエージェントの報告を統合してユーザーへ返答
- 短いコマンド（`git status`・`ls` 程度）の直接実行

## main がやってはいけないこと

- `skills/`・`.claude/agents/`・`.claude/rules/` の直接編集（→ 作成・編集モードの Agent へ委譲）
- 大量ファイルの逐次 Read（→ skill-explorer 等へ委譲）
- セキュリティ監査（→ security-auditor へ委譲）
