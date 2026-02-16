# Slack 설정 가이드

Discode를 Discord 대신 Slack에 연결하는 방법을 안내합니다.

## 사전 준비

- Node.js 18+ 또는 Bun 1.3+
- Discode 설치 완료 (`npm install -g @siisee11/discode`)
- 앱 설치 권한이 있는 Slack 워크스페이스

## 1. Slack App 생성

1. [api.slack.com/apps](https://api.slack.com/apps)에서 **Create New App** 클릭
2. **From scratch** 선택
3. 이름 입력 (예: `Discode Bot`), 워크스페이스 선택
4. **Create App** 클릭

## 2. Socket Mode 활성화

1. 앱 설정에서 **Socket Mode** (왼쪽 사이드바) 이동
2. **Enable Socket Mode** 토글 On
3. **App-Level Token** 생성 프롬프트가 나타남:
   - Name: `discode-socket`
   - Scope: `connections:write`
   - **Generate** 클릭
4. **`xapp-...` 토큰을 복사** — 나중에 필요함

## 3. Bot Token Scope 설정

1. **OAuth & Permissions** (왼쪽 사이드바) 이동
2. **Scopes → Bot Token Scopes**에서 다음 scope 추가:

| Scope | 용도 |
|-------|------|
| `channels:history` | 공개 채널 메시지 읽기 |
| `channels:manage` | 채널 생성 및 아카이브 |
| `channels:read` | 채널 목록 조회 |
| `groups:read` | 비공개 채널 목록 조회 |
| `chat:write` | 메시지 전송 |
| `files:read` | 공유 파일 접근 |
| `files:write` | 파일 업로드 |
| `reactions:read` | 이모지 리액션 읽기 |
| `reactions:write` | 이모지 리액션 추가/제거 |

## 4. Event Subscriptions 활성화

1. **Event Subscriptions** (왼쪽 사이드바) 이동
2. **Enable Events** 토글 On
3. **Subscribe to bot events**에서 추가:
   - `message.channels` — 공개 채널 메시지

> Socket Mode가 이벤트 전달을 처리하므로 Request URL은 필요 없습니다.

## 5. 워크스페이스에 앱 설치

1. **Install App** (왼쪽 사이드바) 이동
2. **Install to Workspace** 클릭
3. 권한을 확인하고 **Allow** 클릭
4. **`xoxb-...` Bot User OAuth Token을 복사**

## 6. Discode 설정

온보딩 명령어 실행:

```bash
discode onboard --platform slack
```

다음 항목을 입력받습니다:
- **Slack Bot Token** (`xoxb-...`) — 5단계에서 복사
- **Slack App-Level Token** (`xapp-...`) — 2단계에서 복사

또는 토큰을 직접 전달:

```bash
discode onboard --platform slack \
  --slack-bot-token xoxb-your-bot-token \
  --slack-app-token xapp-your-app-token
```

## 7. 사용 시작

```bash
cd your-project
discode new claude
```

Discode가 수행하는 작업:
1. Slack 채널 생성 (예: `#your-project-claude`)
2. tmux 세션에서 AI 에이전트 실행
3. Slack과 에이전트 간 메시지 브릿지

## Discord와의 차이점

| 항목 | Discord | Slack |
|------|---------|-------|
| 메시지 길이 제한 | 2,000자 | 40,000자 |
| 채널 삭제 | 완전 삭제 | 아카이브 (소프트 삭제) |
| 파일 다운로드 | 공개 CDN URL | `Authorization` 헤더 필요 |
| 리액션 | 유니코드 이모지 | Slack 이모지 이름 |
| 서버/워크스페이스 | Guild | Workspace |
| 메시지 ID | Snowflake ID | Timestamp (`ts`) |

## 환경 변수

환경 변수로도 설정 가능:

```bash
export MESSAGING_PLATFORM=slack
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
```

## 문제 해결

### 봇이 메시지에 응답하지 않음
- 봇이 채널에 초대되었는지 확인 (`@Discode Bot` 멘션 또는 `/invite` 사용)
- `message.channels` 이벤트 구독이 활성화되어 있는지 확인
- Socket Mode가 활성화되어 있는지 확인

### 채널을 생성할 수 없음
- 봇에 `channels:manage` scope가 있는지 확인
- 워크스페이스 관리자가 봇의 채널 생성을 허용해야 할 수 있음

### 파일 업로드 실패
- 봇에 `files:write` scope가 있는지 확인
- 파일 크기 제한 확인 (Slack 플랜에 따라 최대 1GB)
