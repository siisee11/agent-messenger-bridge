# LLM CLI 도구별 Hook 시스템 비교 분석

> 작성일: 2026-02-20

## 목차

1. [개요](#개요)
2. [Claude Code](#1-claude-code)
3. [OpenAI Codex CLI](#2-openai-codex-cli)
4. [Google Gemini CLI](#3-google-gemini-cli)
5. [Cursor](#4-cursor)
6. [Windsurf (Codeium)](#5-windsurf-codeium)
7. [GitHub Copilot CLI](#6-github-copilot-cli)
8. [Amazon Q Developer CLI](#7-amazon-q-developer-cli)
9. [Cline](#8-cline)
10. [Aider / Continue.dev](#9-aider--continuedev)
11. [종합 비교표](#종합-비교표)
12. [공통 패턴과 인사이트](#공통-패턴과-인사이트)

---

## 개요

Hook은 LLM 코딩 에이전트의 라이프사이클 특정 시점에서 사용자 정의 스크립트를 실행하는 메커니즘이다. 도구 실행 전후에 검증/차단/수정을 수행하거나, 세션 시작/종료 시 컨텍스트를 주입하거나, 에이전트 응답을 검증하는 등의 용도로 사용된다.

**Hook의 핵심 가치:**
- **가드레일**: 위험한 명령어 차단, 시크릿 유출 방지
- **자동화**: 파일 수정 후 자동 포맷팅/린트, 테스트 실행
- **컨텍스트 주입**: 세션 시작 시 프로젝트 규칙/상태 주입
- **알림**: 에이전트 완료/오류 시 데스크톱 알림, Slack 전송
- **감사(Audit)**: 모든 도구 실행을 로깅

---

## 1. Claude Code

**상태:** 가장 성숙한 hook 시스템. 14개 이벤트, 3가지 핸들러 타입(command, prompt, agent).

### 이벤트 목록

| 이벤트 | 시점 | 차단 가능 |
|---|---|---|
| `SessionStart` | 세션 시작/재개 | X |
| `SessionEnd` | 세션 종료 | X |
| `UserPromptSubmit` | 사용자 프롬프트 제출 시 | O |
| `PreToolUse` | 도구 실행 전 | O |
| `PostToolUse` | 도구 실행 후 | X |
| `PostToolUseFailure` | 도구 실행 실패 후 | X |
| `PermissionRequest` | 권한 요청 대화상자 표시 시 | O |
| `Notification` | 알림 전송 시 | X |
| `SubagentStart` | 서브에이전트 생성 시 | X |
| `SubagentStop` | 서브에이전트 종료 시 | O |
| `Stop` | Claude 응답 완료 시 | O |
| `TeammateIdle` | 팀 에이전트 유휴 상태 진입 시 | O |
| `TaskCompleted` | 태스크 완료 시 | O |
| `PreCompact` | 컨텍스트 압축 전 | X |

### 설정 파일 위치 (우선순위 순)

| 위치 | 범위 | 공유 가능 |
|---|---|---|
| `.claude/settings.json` | 프로젝트 | O (커밋 가능) |
| `.claude/settings.local.json` | 프로젝트 | X (gitignored) |
| `~/.claude/settings.json` | 전체 | X |
| 관리 정책 설정 | 조직 전체 | O |
| 플러그인 `hooks/hooks.json` | 플러그인 활성화 시 | O |

### 설정 형식

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/block-dangerous.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

### 3가지 핸들러 타입

**`command`** -- 셸 명령어 실행. stdin으로 JSON 수신, stdout으로 JSON 반환.
```json
{ "type": "command", "command": "node .claude/hooks/validate.js", "timeout": 600, "async": false }
```

**`prompt`** -- 단일 턴 LLM 평가. `$ARGUMENTS`에 hook 입력 JSON이 대체됨.
```json
{ "type": "prompt", "prompt": "이 도구 호출이 안전한지 평가하라: $ARGUMENTS", "timeout": 30 }
```

**`agent`** -- 다중 턴 서브에이전트. Read, Grep, Glob 도구 접근 가능. 최대 50턴.
```json
{ "type": "agent", "prompt": "테스트를 실행하고 결과를 확인하라. $ARGUMENTS", "timeout": 120 }
```

### stdin 입력 (공통 필드)

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/project/root",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

도구 관련 이벤트는 `tool_name`, `tool_input`, `tool_use_id` 추가.

### stdout 출력 (PreToolUse 예시)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "프로덕션 DB 접근 차단",
    "updatedInput": { "command": "npm run lint" },
    "additionalContext": "현재 환경: production"
  }
}
```

### 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 성공. stdout JSON 파싱 |
| 2 | 차단. stderr가 Claude에게 전달 |
| 기타 | 비차단 오류. verbose 모드에서만 표시 |

### 매처 패턴

도구 이벤트는 정규식 (예: `"Bash"`, `"Edit\|Write"`, `"mcp__.*"`). 라이프사이클 이벤트는 정확한 문자열 (예: `"startup"`, `"resume"`).

### 환경 변수

- `$CLAUDE_PROJECT_DIR` -- 프로젝트 루트
- `${CLAUDE_PLUGIN_ROOT}` -- 플러그인 루트 (플러그인 hook에서만)
- `$CLAUDE_ENV_FILE` -- SessionStart에서 환경변수 영속화용 파일 경로

### 실전 예시

**파일 수정 후 자동 포맷팅:**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write"
          }
        ]
      }
    ]
  }
}
```

**Stop hook으로 테스트 검증 (agent 타입):**
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "agent",
            "prompt": "단위 테스트가 모두 통과하는지 확인하라. 테스트를 실행하고 결과를 검사하라. $ARGUMENTS",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

---

## 2. OpenAI Codex CLI

**상태:** 개발 중. 현재 `notify`(안정), `pre_turn`(커뮤니티), `AfterToolUse`(v0.102.0) 지원. 전체 hook 시스템 PR 진행 중.

### 현재 사용 가능한 Hook

**`notify`** -- 에이전트 턴 완료 후 알림 (안정)
```toml
# ~/.codex/config.toml
notify = ["python3", "/path/to/notify.py"]
```

수신 JSON 필드: `type` ("agent-turn-complete"), `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`

**`pre_turn`** -- 응답 생성 전 지시사항 주입 (커뮤니티)
```toml
[hooks]
pre_turn = ["${CODEX_HOME:-$HOME/.codex}/hooks/instruct/hook_instruct.sh"]
```

stdout 출력이 에이전트 컨텍스트에 주입됨. 비정상 종료 시 응답 생성 차단.

**`AfterToolUse`** -- 도구 실행 후 (v0.102.0, 2026년 2월 출시)

### 개발 중인 전체 Hook 시스템 (PR #11067)

5개 라이프사이클 이벤트 제안:

| 이벤트 | 시점 | 결과 타입 |
|---|---|---|
| `PreToolUse` | 도구 실행 전 | Proceed / Block / Modify |
| `PostToolUse` | 도구 실행 후 | Proceed / Block / Modify |
| `SessionStop` | 세션 종료 | Proceed / Block |
| `UserPromptSubmit` | 사용자 입력 제출 | Proceed / Block |
| `AfterAgent` | 에이전트 작업 후 | Proceed / Block |

설정 형식 (TOML):
```toml
[hooks.PreToolUse]
command = "./hooks/validate-tool.sh"
timeout = 30
pattern = "shell:*"
```

Hook 결과 (stdout JSON):
```json
{ "outcome": "Block", "message": "이 명령은 허용되지 않습니다" }
// 또는
{ "outcome": "Modify", "content": { "command": "npm run lint" } }
```

### 기타 확장 메커니즘

- **MCP 서버**: 주요 확장 포인트. `config.toml`의 `[mcp_servers]` 섹션에서 설정
- **Skills**: `~/.codex/skills/` 또는 `.codex/skills/`에 설치. `SKILL.md` + 에이전트 설정 + 스크립트
- **AGENTS.md**: 프로젝트별 에이전트 지시사항
- **OpenTelemetry**: 읽기 전용 관측 이벤트 (`codex.tool_decision`, `codex.tool_result` 등)

---

## 3. Google Gemini CLI

**상태:** 완전한 hook 시스템. 11개 이벤트, 4개 카테고리 (도구/에이전트/모델/라이프사이클).

### 이벤트 목록

| 이벤트 | 카테고리 | 시점 | 차단 가능 |
|---|---|---|---|
| `BeforeTool` | 도구 | 도구 실행 전 | O |
| `AfterTool` | 도구 | 도구 실행 후 | O (결과 숨기기) |
| `BeforeAgent` | 에이전트 | 에이전트 계획 수립 전 | O |
| `AfterAgent` | 에이전트 | 에이전트 응답 후 | O (재시도 강제) |
| `BeforeModel` | 모델 | LLM 요청 전 | O |
| `AfterModel` | 모델 | LLM 응답 청크 후 | O |
| `BeforeToolSelection` | 모델 | 도구 선택 전 | X (도구 필터만) |
| `SessionStart` | 라이프사이클 | 시작/재개/초기화 | X |
| `SessionEnd` | 라이프사이클 | 종료 | X |
| `PreCompress` | 라이프사이클 | 컨텍스트 압축 전 | X |
| `Notification` | 시스템 | 알림 발생 시 | X |

### 설정 형식

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "write_file|replace",
        "sequential": false,
        "hooks": [
          {
            "name": "secret-scanner",
            "type": "command",
            "command": "$GEMINI_PROJECT_DIR/.gemini/hooks/block-secrets.sh",
            "timeout": 5000,
            "description": "시크릿 커밋 방지"
          }
        ]
      }
    ]
  }
}
```

설정 파일 위치 (우선순위 순):
1. `.gemini/settings.json` (프로젝트)
2. `~/.gemini/settings.json` (사용자)
3. `/etc/gemini-cli/settings.json` (시스템)
4. `~/.gemini/extensions/<name>/hooks/hooks.json` (확장)

### 고유 기능: 모델 레벨 Hook

**`BeforeModel`** -- LLM 요청 파라미터(모델, temperature, 메시지)를 수정하거나 합성 응답을 반환하여 LLM 호출 자체를 건너뛸 수 있음.

```json
{
  "hookSpecificOutput": {
    "llm_response": {
      "candidates": [{ "content": { "parts": [{ "text": "합성 응답" }] } }]
    }
  }
}
```

**`BeforeToolSelection`** -- 에이전트가 사용 가능한 도구를 필터링.

```json
{
  "hookSpecificOutput": {
    "toolConfig": {
      "mode": "ANY",
      "allowedFunctionNames": ["read_file", "search"]
    }
  }
}
```

### 환경 변수

- `GEMINI_PROJECT_DIR` -- 프로젝트 루트
- `GEMINI_SESSION_ID` -- 세션 ID
- `GEMINI_CWD` -- 작업 디렉토리
- `CLAUDE_PROJECT_DIR` -- 호환성 별칭

### 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 성공 |
| 2 | 시스템 차단 (stderr가 거부 사유) |
| 기타 | 경고 (원래 동작 계속) |

### Hook 관리 명령어

- `/hooks panel` -- 실행 횟수, 성공/실패, 타이밍 조회
- `/hooks enable-all` / `/hooks disable-all` -- 일괄 토글
- `/hooks enable <name>` / `/hooks disable <name>` -- 개별 토글

---

## 4. Cursor

**상태:** v1.7(2025.10)에서 Hook 도입, v2.5(2026.02)에서 Plugin Marketplace 추가.

### 이벤트 목록

| 이벤트 | 시점 | 차단 가능 |
|---|---|---|
| `beforeSubmitPrompt` | 프롬프트 전송 전 | X |
| `beforeShellExecution` | 셸 명령 실행 전 | O |
| `beforeMCPExecution` | MCP 도구 호출 전 | O |
| `beforeReadFile` | 파일 읽기 전 | O |
| `afterFileEdit` | 파일 수정 후 | X |
| `stop` | 태스크 완료 시 | X |

### 설정 형식

```json
{
  "$schema": "https://unpkg.com/cursor-hooks@latest/schema/hooks.schema.json",
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      { "command": "bun run hooks/before-shell-execution.ts" }
    ],
    "afterFileEdit": [
      { "command": "hooks/format.sh" }
    ]
  }
}
```

설정 파일: `[project]/.cursor/hooks.json`, `~/.cursor/hooks.json`, `/etc/cursor/hooks.json` (모두 실행됨)

### stdout 프로토콜 (차단 hook)

```json
{
  "continue": true,
  "permission": "allow|deny|ask",
  "userMessage": "사용자에게 표시할 메시지",
  "agentMessage": "AI 에이전트에게 전달할 메시지"
}
```

---

## 5. Windsurf (Codeium)

**상태:** 11개 이벤트로 가장 세분화된 hook 시스템.

### 이벤트 목록

| 이벤트 | 시점 | 차단 가능 |
|---|---|---|
| `pre_read_code` | 파일 읽기 전 | O |
| `post_read_code` | 파일 읽기 후 | X |
| `pre_write_code` | 파일 수정 전 | O |
| `post_write_code` | 파일 수정 후 | X |
| `pre_run_command` | 명령 실행 전 | O |
| `post_run_command` | 명령 실행 후 | X |
| `pre_mcp_tool_use` | MCP 도구 전 | O |
| `post_mcp_tool_use` | MCP 도구 후 | X |
| `pre_user_prompt` | 프롬프트 처리 전 | O |
| `post_cascade_response` | AI 응답 후 | X |
| `post_setup_worktree` | git worktree 생성 후 | X |

### 설정 형식

```json
{
  "hooks": {
    "pre_run_command": [
      {
        "command": "python3 /path/to/guard.py",
        "show_output": true,
        "working_directory": "/opt/scripts"
      }
    ],
    "post_write_code": [
      { "command": "prettier --write", "show_output": false }
    ]
  }
}
```

설정 파일 (4단계 병합): 엔터프라이즈 클라우드 > 시스템 > 사용자(`~/.codeium/windsurf/hooks.json`) > 워크스페이스(`.windsurf/hooks.json`)

### 차단 메커니즘

exit code 2로 차단. stderr 내용이 사용자에게 표시됨.

---

## 6. GitHub Copilot CLI

**상태:** 6개 이벤트, 전체 플러그인 시스템 포함.

### 이벤트 목록

| 이벤트 | 시점 | 차단 가능 |
|---|---|---|
| `sessionStart` | 세션 시작 | X |
| `sessionEnd` | 세션 종료 | X |
| `userPromptSubmitted` | 프롬프트 제출 | X |
| `preToolUse` | 도구 실행 전 | O |
| `postToolUse` | 도구 실행 후 | X |
| `errorOccurred` | 오류 발생 시 | X |

### 설정 형식

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "./scripts/guard.sh",
        "powershell": "./scripts/guard.ps1",
        "cwd": "scripts",
        "timeoutSec": 30
      }
    ]
  }
}
```

설정 파일: `.github/hooks/*.json`

### 크로스 플랫폼

`bash`와 `powershell` 명령어를 별도로 지정할 수 있어 Windows/macOS/Linux 모두 지원.

### 차단 프로토콜

```json
{
  "permissionDecision": "deny",
  "permissionDecisionReason": "정책에 의해 차단됨"
}
```

---

## 7. Amazon Q Developer CLI

**상태:** Custom Agent 내부에서 5개 hook 지원. 컨텍스트 주입 중심.

### 이벤트 목록

| 이벤트 | 시점 | 특징 |
|---|---|---|
| `agentSpawn` | 에이전트 초기화 | 출력이 세션 전체에 영속 |
| `userPromptSubmit` | 사용자 메시지마다 | 출력이 해당 턴에만 추가 |
| `preToolUse` | 도구 실행 전 | 차단 가능 |
| `postToolUse` | 도구 실행 후 | 후처리 |
| `stop` | 응답 완료 시 | 정리/알림 |

### 설정 형식 (agent.json 내부)

```json
{
  "name": "dev-workflow",
  "hooks": {
    "agentSpawn": [
      { "command": "git branch --show-current", "timeout_ms": 3000 },
      { "command": "git status --porcelain", "timeout_ms": 5000 }
    ],
    "preToolUse": [
      { "matcher": "execute_bash", "command": "echo 'logged' >> /tmp/audit" }
    ],
    "postToolUse": [
      { "matcher": "fs_write", "command": "cargo fmt --all" }
    ]
  }
}
```

### 고유 기능: 컨텍스트 주입

`agentSpawn` hook 출력은 세션 전체에 걸쳐 에이전트 컨텍스트에 영속됨. `userPromptSubmit` hook 출력은 해당 프롬프트에만 추가됨. 이는 가드레일보다 **동적 컨텍스트 주입**에 초점을 맞춘 설계.

### 추가 설정 필드

- `cache_ttl_seconds` -- 반복 실행 방지용 캐시 (기본 0)
- `max_output_size` -- 최대 출력 크기 (기본 10KB)

---

## 8. Cline

**상태:** 4개 이벤트, 파일시스템 기반 디스커버리.

### 이벤트 목록

| 이벤트 | 시점 | 차단 가능 |
|---|---|---|
| `TaskStart` | 태스크 시작 | X |
| `PreToolUse` | 도구 실행 전 | O |
| `PostToolUse` | 도구 실행 후 | X |
| `PreCompact` | 컨텍스트 압축 전 | X |

### 설정 방식

JSON 설정 파일이 아닌 **파일시스템 디스커버리**:
- 전역: `~/.cline/hooks/`
- 워크스페이스: `.cline/hooks/`

실행 가능한 스크립트를 해당 디렉토리에 배치하면 자동 감지됨.

---

## 9. Aider / Continue.dev

### Aider

**Hook 시스템 없음.** 대신 다음 메커니즘 제공:

| 기능 | 설정 | 용도 |
|---|---|---|
| Git commit hook | `--git-commit-verify` | pre-commit hook 실행 여부 |
| 자동 린트 | `--lint-cmd "python: black"` | 파일 변경 후 자동 린트 |
| 자동 테스트 | `--test-cmd "pytest"` | 파일 변경 후 자동 테스트 |
| 파일 감시 | `--watch-files` | AI 코딩 주석 감지 |

### Continue.dev

**Hook 시스템 없음.** 확장은 선언적 설정 모델:
- **Context Provider**: `@` 구문으로 컨텍스트 주입 (diff, terminal, http 등)
- **Prompts/Slash Commands**: `.prompt` 파일로 정의
- **Rules**: 시스템 메시지에 규칙 연결
- **MCP 서버**: 도구 확장
- **config.ts**: TypeScript로 프로그래밍적 확장

---

## 종합 비교표

| 도구 | 이벤트 수 | 설정 형식 | 차단 가능 | 핸들러 타입 | 모델 레벨 Hook | 플러그인/확장 |
|---|---|---|---|---|---|---|
| **Claude Code** | 14 | JSON (settings.json) | O (6개) | command, prompt, agent | X | 플러그인 |
| **Gemini CLI** | 11 | JSON (settings.json) | O (5개) | command, plugin | O | 확장(Extension) |
| **Windsurf** | 11 | JSON (hooks.json) | O (5개) | command | X | MCP만 |
| **Cursor** | 6 | JSON (hooks.json) | O (3개) | command | X | Marketplace |
| **Copilot CLI** | 6 | JSON (.github/hooks/) | O (1개) | command | X | 플러그인 |
| **Amazon Q CLI** | 5 | JSON (agent.json) | O (1개) | command | X | MCP |
| **Cline** | 4 | 파일시스템 | O (1개) | command | X | MCP |
| **Codex CLI** | 1-3* | TOML (config.toml) | 개발 중 | command | X | MCP, Skills |
| **Aider** | 0 | YAML | X | - | X | X |
| **Continue.dev** | 0 | YAML/TS | X | - | X | Context Provider |

*Codex CLI: 안정 1개(notify), 커뮤니티 1개(pre_turn), 출시 1개(AfterToolUse), 전체 시스템 PR 진행 중

---

## 공통 패턴과 인사이트

### 1. 통신 프로토콜: stdin/stdout JSON

거의 모든 도구가 동일한 패턴을 사용:
- **입력**: JSON을 stdin으로 전달
- **출력**: JSON을 stdout으로 반환
- **차단**: exit code 2 또는 JSON 내 `decision: "deny"` / `permissionDecision: "deny"`
- **로깅**: stderr로 (stdout은 반드시 순수 JSON만)

### 2. Pre/Post 도구 Hook이 보편적

모든 hook 시스템이 `PreToolUse`/`PostToolUse`(또는 동등한 이름)를 지원. 이것이 hook의 핵심 사용 사례.

### 3. 3단계 설정 계층

프로젝트 > 사용자 > 시스템 (또는 역순 우선순위)이 표준 패턴. Windsurf는 엔터프라이즈 클라우드 단계를 추가하여 4단계.

### 4. 차별화 포인트

| 도구 | 고유 기능 |
|---|---|
| **Claude Code** | `prompt`/`agent` 핸들러 -- LLM이 hook 판단을 수행 |
| **Gemini CLI** | `BeforeModel`/`AfterModel` -- LLM 요청/응답 자체를 가로채고 수정 |
| **Amazon Q CLI** | `agentSpawn` 컨텍스트 영속화 + `cache_ttl_seconds` 캐싱 |
| **Windsurf** | 파일 읽기/쓰기를 별도 이벤트로 분리 (가장 세분화) |
| **Copilot CLI** | `bash`/`powershell` 크로스 플랫폼 명령어 분리 |
| **Cline** | JSON 설정 없이 파일시스템 기반 자동 발견 |

### 5. Hook 시스템 성숙도 스펙트럼

```
성숙 ←─────────────────────────────────────────→ 초기/없음

Claude Code > Gemini CLI > Windsurf > Cursor ≈ Copilot CLI > Amazon Q > Cline > Codex CLI > Aider ≈ Continue.dev
```

### 6. 트렌드

- **Hook + 플러그인 번들링**: Cursor Marketplace, Copilot 플러그인 -- hook을 MCP 서버/스킬과 함께 패키지로 배포
- **LLM 기반 Hook**: Claude Code의 `prompt`/`agent` 핸들러 -- 정적 스크립트가 아닌 LLM이 판단
- **모델 레벨 가로채기**: Gemini CLI의 `BeforeModel` -- 에이전트가 아닌 LLM 요청 자체를 수정/모킹
- **Hook 가시성**: Gemini CLI의 `/hooks panel` -- 실행 통계, 성공/실패율 대시보드
