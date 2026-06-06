---
description: 作成・編集フェーズの委譲ルール。skills/・.claude/agents/・.claude/rules/ などを変更する際に適用する。
paths:
  - "skills/**"
  - ".claude/agents/**"
  - ".claude/rules/**"
  - "CLAUDE.md"
  - "README.md"
---

# 委譲ルール（作成・編集フェーズ）

調査・設計モードの概要は `./delegation.md` を参照。本ファイルは**作成・編集モード**に特化する。

## 委譲先マッピング（作成・編集系）

| 対象 | subagent_type | model | 適用ルール |
|-----|--------------|-------|-----------|
| `skills/<name>/SKILL.md` の作成・編集 | `skill-author` | sonnet | `./skill-authoring.md` |
| `.claude/agents/` の作成・編集 | `agent-author` | sonnet | `./agent-authoring.md` |
| `.claude/rules/` の作成・編集 | `rules-author` | sonnet | — |
| `CLAUDE.md`・`README.md` の一覧・ツリー更新 | `docs-writer` | haiku | — |
| SKILL.md の品質レビュー（読み取り専用） | `skill-reviewer` | sonnet | `./skill-authoring.md` |
| セキュリティ監査（読み取り専用） | `security-auditor` | sonnet | `./security.md` |
| frontmatter・symlink の機械検証 | `frontmatter-linter` | haiku | — |

## 委譲プロンプト必須項目

サブエージェントへの委譲プロンプトには必ず以下を含める:

1. **目的**: 何を作成・編集するか
2. **入力**: 参照すべきファイルパス・既存の仕様
3. **出力先**: 作成・編集するファイルの絶対パス
4. **観点**: 品質基準・チェックすべき観点
5. **適用ルール**: 遵守すべきルールファイルの相対パス

例:

```
subagent_type: skill-author
prompt: |
  目的: create-foo スキルの SKILL.md を作成する
  入力: skills/create-commit/SKILL.md（既存スキルの参考）
  出力先: skills/create-foo/SKILL.md
  観点: ./skill-authoring.md に従った frontmatter・本文構成
  適用ルール: .claude/rules/skill-authoring.md, .claude/rules/conventional-commits.md
```

## .claude/ 配下の編集について

`.claude/agents/`・`.claude/rules/` を編集する Agent は `./dotclaude-via-temp.md` に従い、**直接書き込まず `_/dotclaude/` を経由**して最終配置する。
