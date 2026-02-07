# discord-agent-bridge

Discord를 통해 AI 에이전트 CLI (Claude Code, OpenCode, Codex CLI)를 원격으로 모니터링하고 제어하는 브릿지.

## Features

- Discord 채널에서 AI 에이전트로 메시지 전송
- 30초 주기 tmux 캡처 폴링으로 에이전트 상태 모니터링
- 작업 시작/완료 시 자동 Discord 알림
- 완료 시 최종 응답 전체 전송
- 프로젝트별 독립적인 Discord 채널
- 글로벌 데몬으로 여러 프로젝트 동시 관리
- YOLO 모드: 에이전트 권한 확인 없이 자동 실행

## Architecture

```
Discord                    Bridge Daemon                tmux
┌──────────┐              ┌──────────────┐             ┌──────────┐
│ #proj-   │◄─ WebSocket ─►│  Node.js    │─ send-keys ─►│ claude   │
│  claude  │              │  Daemon     │              │ window   │
│          │◄─ notify ────│             │              │          │
│          │              │  Capture    │◄─ capture ───│          │
│          │              │  Poller     │  pane (30s)  │          │
└──────────┘              └──────────────┘             └──────────┘
```

**메시지 흐름:**
- **Discord → Agent**: 사용자 메시지 → Bridge → tmux send-keys
- **Agent → Discord**: 30초 폴링으로 tmux pane 캡처 → 변경 감지 → Discord 전송

**설계 원칙:**
- 의존성 주입(DI) 패턴으로 모든 모듈 테스트 가능
- 인터페이스 기반 추상화: `IStorage`, `ICommandExecutor`, `IEnvironment`, `IStateManager`, `IProcessManager`
- 하위 호환성 유지: 기존 싱글톤 export 유지하면서 생성자 DI 지원

## Installation

```bash
cd discord-agent-bridge
npm install
npm run build

# CLI 전역 등록 (선택)
npm link
```

## Quick Start

### 1. Discord Bot 설정

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 새 Application 생성
2. Bot 탭에서 Bot 추가
3. Bot Token 복사
4. OAuth2 > URL Generator에서:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Manage Channels`, `Add Reactions`
5. 생성된 URL로 서버에 봇 초대

### 2. 초기 설정

```bash
agent-discord setup <YOUR_BOT_TOKEN>
```

토큰 저장, 서버 자동 감지, 에이전트 감지를 한 번에 처리합니다.

### 3. 프로젝트 시작

```bash
cd ~/my-project
agent-discord go claude        # Claude Code로 시작
agent-discord go opencode      # OpenCode로 시작
agent-discord go codex         # Codex CLI로 시작
agent-discord go               # 설치된 에이전트 자동 감지
agent-discord go --yolo        # YOLO 모드 (권한 확인 건너뜀)
```

`go` 명령 하나로 데몬 시작, 프로젝트 설정, tmux 세션 생성, Discord 채널 생성을 모두 처리합니다.

## Discord 알림 방식

30초마다 tmux 터미널 화면을 캡처하여 변경을 감지합니다:

| 상태 | Discord 알림 |
|------|-------------|
| 에이전트 작업 시작 | ⚡ 작업 중... |
| 에이전트 작업 완료 | 💬 최종 응답 전체 전송 |
| 세션 종료 | ⏹️ 세션 종료됨 |
| 변경 없음 | 알림 없음 |

- 변경이 있을 때만 알림 → 메시지 폭탄 없음
- 프로그램이 꺼져 있으면 → 데몬이 안 돌아가므로 알림 없음

## YOLO 모드

`--yolo` 플래그를 사용하면 에이전트가 권한 확인 없이 자동으로 실행됩니다.

```bash
agent-discord go --yolo           # 자동 감지된 에이전트를 YOLO 모드로 시작
agent-discord go claude --yolo    # Claude Code를 YOLO 모드로 시작
```

**동작 방식:**
- Claude Code: `--dangerously-skip-permissions` 플래그 자동 추가
- tmux 세션에 `AGENT_DISCORD_YOLO=1` 환경변수 설정
- 도구 실행 시 사용자 승인 없이 자동 허용

**주의:** YOLO 모드는 에이전트가 파일 수정, 명령 실행 등을 확인 없이 수행합니다. 신뢰할 수 있는 환경에서만 사용하세요.

## CLI Commands

| Command | Description |
|---------|-------------|
| `agent-discord setup <token>` | 초기 설정 (토큰, 서버, 에이전트 감지) |
| `agent-discord go [agent]` | 프로젝트 빠른 시작 (데몬+채널+tmux) |
| `agent-discord init <agent> <desc>` | 프로젝트 초기화 (상세 설정) |
| `agent-discord start` | 브릿지 서버 시작 (포그라운드) |
| `agent-discord config` | 설정 관리 |
| `agent-discord status` | 브릿지 및 프로젝트 상태 확인 |
| `agent-discord list` | 설정된 프로젝트 목록 |
| `agent-discord attach [project]` | tmux 세션 연결 |
| `agent-discord stop [project]` | 프로젝트 중지 (tmux + 채널 삭제) |
| `agent-discord daemon <start\|stop\|status>` | 글로벌 데몬 관리 |
| `agent-discord agents` | 지원 에이전트 목록 |

## Files

```
discord-agent-bridge/
├── bin/agent-discord.ts       # CLI 진입점
├── src/
│   ├── index.ts               # 메인 브릿지 서버 (AgentBridge)
│   ├── daemon.ts              # 글로벌 데몬 매니저
│   ├── capture/               # tmux 캡처 폴링 시스템
│   │   ├── poller.ts          # 30초 폴링 루프
│   │   ├── detector.ts        # 상태 감지 (working/stopped/offline)
│   │   └── parser.ts          # ANSI 제거, Discord 메시지 분할
│   ├── discord/               # Discord 클라이언트
│   ├── tmux/                  # tmux 세션 관리
│   ├── agents/                # 에이전트 어댑터 (claude, opencode, codex)
│   ├── state/                 # 프로젝트 상태 관리
│   ├── config/                # 설정 관리
│   ├── types/                 # 타입 정의 및 DI 인터페이스
│   │   ├── index.ts           # 공통 타입
│   │   └── interfaces.ts      # DI 인터페이스
│   └── infra/                 # 인프라 구현체
│       ├── shell.ts           # ShellCommandExecutor (execSync 래퍼)
│       ├── storage.ts         # FileStorage (fs 래퍼)
│       └── environment.ts     # SystemEnvironment (process.env 래퍼)
├── tests/                     # Vitest 단위 테스트
│   ├── capture/               # parser, detector, poller 테스트
│   ├── agents/                # 에이전트 어댑터 테스트
│   ├── discord/               # Discord 클라이언트 테스트
│   ├── tmux/                  # TmuxManager 테스트
│   ├── state/                 # StateManager 테스트
│   ├── config/                # ConfigManager 테스트
│   ├── daemon.test.ts         # DaemonManager 테스트
│   └── index.test.ts          # AgentBridge 테스트
├── vitest.config.ts           # Vitest 설정
└── dist/                      # 빌드 결과물
```

## State 저장 위치

- 설정 파일: `~/.discord-agent-bridge/config.json`
- 프로젝트 상태: `~/.discord-agent-bridge/state.json`
- 데몬 PID: `~/.discord-agent-bridge/daemon.pid`
- 데몬 로그: `~/.discord-agent-bridge/daemon.log`

## Troubleshooting

### "Not set up yet" 에러
```bash
agent-discord setup <YOUR_BOT_TOKEN>
```

### Discord에 알림이 안 옴
1. 데몬 실행 확인: `agent-discord daemon status`
2. tmux 세션 확인: `agent-discord status`
3. 데몬 로그 확인: `cat ~/.discord-agent-bridge/daemon.log`

### tmux 세션을 찾을 수 없음
```bash
tmux list-sessions
agent-discord status
```

## Development

```bash
npm run dev          # tsx로 개발 모드 실행
npm run build        # tsup으로 빌드
npm run typecheck    # TypeScript 타입 체크
npm test             # Vitest 단위 테스트 (129개)
npm run test:watch   # 테스트 워치 모드
npm run test:coverage # 테스트 커버리지
```

### Testing

Vitest 기반 129개 단위 테스트:

| 테스트 파일 | 테스트 수 | 대상 |
|------------|----------|------|
| capture/parser | 21 | stripAnsi, cleanCapture, splitForDiscord |
| capture/detector | 5 | detectState |
| capture/poller | 12 | CapturePoller 폴링 로직 |
| agents/base | 7 | AgentRegistry |
| agents/claude | 5 | ClaudeAdapter |
| agents/adapters | 4 | OpenCode, Codex |
| tmux/manager | 17 | TmuxManager |
| state/index | 13 | StateManager |
| config/index | 10 | ConfigManager |
| discord/client | 10 | DiscordClient |
| daemon | 12 | DaemonManager |
| index | 13 | AgentBridge |

모든 모듈은 DI 패턴으로 Mock 주입이 가능하여 외부 의존성 없이 테스트됩니다.

## License

MIT
