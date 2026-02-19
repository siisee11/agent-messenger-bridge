# Discode

English version: [README.md](README.md)

AI 에이전트 CLI를 Discord에 연결하여 원격 모니터링 및 협업을 가능하게 합니다.

> 이 프로젝트는 [DoBuDevel/discord-agent-bridge](https://github.com/DoBuDevel/discord-agent-bridge)에서 파생되었습니다. 원 저작자 표기를 유지하며 업스트림 작업을 기반으로 확장합니다.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3+-green.svg)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-129%20passing-brightgreen.svg)](./tests)

## 개요

Discode는 AI 코딩 어시스턴트(Claude Code, OpenCode)를 Discord에 연결하여 원격 모니터링과 협업을 가능하게 합니다. Discord 채널을 통해 AI 에이전트의 작업을 실시간으로 관찰하고, 팀과 진행 상황을 공유하며, 여러 프로젝트를 동시에 추적할 수 있습니다.

이 브리지는 이벤트 훅 기반 아키텍처를 사용하여 에이전트 결과를 Discord/Slack 채널로 즉시 전달합니다. 각 프로젝트는 고유한 채널을 가지며, 단일 글로벌 데몬이 모든 연결을 효율적으로 관리합니다.

## 기능

- **다중 에이전트 지원**: Claude Code와 OpenCode 지원
- **자동 검색**: 시스템에 설치된 AI 에이전트 자동 감지
- **실시간 스트리밍**: 에이전트 이벤트 훅으로 Discord/Slack에 즉시 전달
- **프로젝트 격리**: 각 프로젝트가 전용 Discord 채널 보유
- **단일 데몬**: 하나의 Discord 봇 연결로 모든 프로젝트 관리
- **세션 관리**: 연결 해제에도 유지되는 지속적인 tmux 세션
- **YOLO 모드**: 에이전트 자율성을 위한 `--dangerously-skip-permissions` 플래그 옵션
- **풍부한 CLI**: 설정, 제어, 모니터링을 위한 직관적인 명령어
- **타입 안전성**: 의존성 주입 패턴을 사용한 TypeScript 작성
- **충분한 테스트**: Vitest를 사용한 129개의 단위 테스트

## 사전 요구사항

- **Bun**: 버전 1.3 이상
- **tmux**: 버전 3.0 이상
- **Discord Bot**: [Discord 봇 설정 가이드](docs/DISCORD_SETUP.ko.md)를 따라 봇 생성
  - 필수 권한: Send Messages, Manage Channels, Read Message History, Embed Links, Add Reactions
  - 필수 인텐트: Guilds, GuildMessages, MessageContent, GuildMessageReactions
- **Slack (선택)**: Discord 대신 Slack을 사용하려면 [Slack 설정 가이드](docs/SLACK_SETUP.ko.md)를 참고하세요.
- **AI 에이전트**: 다음 중 하나 이상:
  - [Claude Code](https://code.claude.com/docs/en/overview)
  - [OpenCode](https://github.com/OpenCodeAI/opencode)

## 설치

### 전역 설치 (npm 또는 Bun)

```bash
npm install -g @siisee11/discode
bun add -g @siisee11/discode
```

### 바이너리 설치 (Bun/Node 런타임 없이 사용)

```bash
curl -fsSL https://discode.chat/install | bash
```

대체 경로:

```bash
curl -fsSL https://raw.githubusercontent.com/siisee11/discode/main/install | bash
```

### 소스에서 설치

```bash
git clone https://github.com/siisee11/discode.git
cd discode
bun install
bun run build
```

로컬 런타임 전환과 개발 워크플로우는 [`DEVELOPMENT.md`](./DEVELOPMENT.md)를 참고하세요.

## 빠른 시작

### 1. Discord 봇 설정

```bash
# Discord 봇 토큰으로 일회성 설정
discode onboard
```

### 2. 프로젝트 초기화

```bash
# 프로젝트 디렉토리로 이동
cd ~/projects/my-app

# Claude Code로 초기화 (또는 'opencode')
discode init claude "멋진 애플리케이션"
```

### 3. 작업 시작

```bash
# 빠른 시작: 데몬 + 프로젝트 + 연결을 한 번에
discode new

# 또는 단계별로:
discode daemon start    # 글로벌 데몬 시작
discode start          # 이 프로젝트 시작
discode attach         # tmux 세션에 연결
```

이제 AI 에이전트가 tmux에서 실행되며, 이벤트 훅을 통해 Discord/Slack으로 출력이 실시간 전달됩니다.

## CLI 참조

### 글로벌 명령어

#### `onboard`

최초 온보딩: 봇 토큰 입력, Discord 서버 자동 감지, 기본 AI CLI 선택, OpenCode 권한 모드 설정, 텔레메트리 옵트인 선택.

```bash
discode onboard
# 비대화형 셸에서는 --token 사용
discode onboard --token YOUR_BOT_TOKEN
```

설정 과정:
1. 봇 토큰을 `~/.discode/config.json`에 저장
2. Discord에 연결하여 봇이 참여한 서버를 자동 감지
3. 봇이 여러 서버에 있으면 선택 프롬프트 표시
4. `discode new` 기본 AI CLI 선택
5. OpenCode 권한 `allow` 사용 여부 확인
6. `allow`를 사용하지 않으면 Discord 승인 프롬프트가 잦아 불편할 수 있음을 안내
7. 익명 CLI 텔레메트리 활성화 여부(옵트인) 확인

#### `daemon <action>`

글로벌 데몬 프로세스 제어.

```bash
discode daemon start    # 데몬 시작
discode daemon stop     # 데몬 중지
discode daemon status   # 데몬 상태 확인
```

#### `list`

등록된 모든 프로젝트 목록 표시.

```bash
discode list
```

#### `agents`

시스템에서 감지된 사용 가능한 AI 에이전트 목록 표시.

```bash
discode agents
```

#### `tui`

인터랙티브 터미널 UI를 엽니다. TUI 내부에서 `/new`를 사용해 새로운 agent session을 만들 수 있습니다.

```bash
discode tui
```

#### `config [options]`

글로벌 설정 조회 및 수정.

```bash
discode config --show              # 현재 설정 표시
discode config --token NEW_TOKEN   # 봇 토큰 변경
discode config --server SERVER_ID  # Discord 서버 ID 수동 설정
discode config --port 18470        # 훅 서버 포트 설정
discode config --telemetry on      # 익명 CLI 텔레메트리 활성화(옵트인)
discode config --telemetry-endpoint https://your-worker.example/v1/events
```

### 프로젝트 명령어

`init` 이후 프로젝트 디렉토리에서 이 명령어들을 실행합니다.

#### `init <agent> <description>`

현재 디렉토리를 프로젝트로 초기화.

```bash
discode init claude "풀스택 웹 애플리케이션"
discode init opencode "데이터 파이프라인 프로젝트"
```

#### `start [options]`

등록된 프로젝트의 브리지 서버 시작.

```bash
discode start                        # 모든 프로젝트 시작
discode start -p my-app             # 특정 프로젝트 시작
discode start -p my-app --attach    # 시작 후 tmux에 연결
```

#### `stop [project]`

프로젝트 중지: tmux 세션 종료, Discord 채널 삭제, 프로젝트 상태 제거. 프로젝트를 지정하지 않으면 현재 디렉토리 이름을 사용합니다.

```bash
discode stop                # 현재 디렉토리의 프로젝트 중지
discode stop my-app         # 특정 프로젝트 중지
discode stop --keep-channel # Discord 채널 유지 (tmux만 종료)
```

#### `status`

프로젝트 상태 표시.

```bash
discode status
```

#### `attach [project]`

프로젝트 tmux 세션에 연결. 프로젝트를 지정하지 않으면 현재 디렉토리 이름을 사용합니다.

```bash
discode attach              # 현재 디렉토리의 프로젝트에 연결
discode attach my-app       # 특정 프로젝트에 연결
```

에이전트를 중지하지 않고 tmux에서 분리하려면 `Ctrl-b d`를 누르세요.

#### `new [agent] [options]`

빠른 시작: 데몬 시작, 필요 시 프로젝트 설정, tmux 연결까지 한 번에 수행. `init` 없이도 동작하며, 설치된 에이전트를 자동 감지하고 Discord 채널을 자동 생성합니다.

```bash
discode new              # 에이전트 자동 감지, 설정 및 연결
discode new claude       # 특정 에이전트 사용
discode new --yolo       # YOLO 모드 (권한 확인 스킵, Claude Code 전용)
discode new --sandbox    # 샌드박스 모드 (Docker 컨테이너에서 Claude Code 실행, Claude Code 전용)
discode new --no-attach  # tmux에 연결하지 않고 시작
```

## 작동 원리

### 아키텍처

```
┌─────────────────┐
│  AI Agent CLI   │  (Claude, OpenCode)
│  Running in     │
│  tmux session   │
└────────┬────────┘
         │
         │ HTTP hooks
         │
     ┌────▼─────────────┐
    │  Hook Server     │  이벤트 수신/중계
     └────┬─────────────┘
         │
         │ Discord.js
         │
    ┌────▼──────────────┐
    │  Discord Channel  │  #project-name
    └───────────────────┘
```

### 구성 요소

- **Daemon Manager**: Discord 연결을 관리하는 단일 글로벌 프로세스
- **Hook Server**: 에이전트 훅 이벤트를 받아 Discord/Slack으로 중계
- **Agent Registry**: 다중 에이전트 지원을 위한 팩토리 패턴 (Claude, OpenCode)
- **State Manager**: 프로젝트 상태, 세션, 채널 추적
- **Dependency Injection**: 스토리지, 실행, 환경을 위한 인터페이스 (테스트 가능, 모킹 가능)

### 이벤트 훅 모델

브리지는 에이전트가 보내는 훅 이벤트를 받아 메시지를 중계합니다:

1. 에이전트 플러그인/훅이 완료 이벤트를 로컬 Hook Server로 전송
2. Hook Server가 메시지/파일 payload를 검증
3. Discord/Slack 채널로 결과를 전송
4. Pending reaction을 완료(✅) 또는 실패(❌)로 갱신

### 프로젝트 라이프사이클

1. **Init**: 프로젝트 메타데이터와 함께 `.discode.json` 생성
2. **Start**: 명명된 tmux 세션에서 AI 에이전트 실행
3. **Hooks**: 데몬이 훅 이벤트를 받아 Discord/Slack으로 스트리밍
4. **Stop**: tmux 세션 종료 및 정리
5. **Attach**: 사용자가 tmux 세션에 참여하여 직접 상호작용 가능

## 지원되는 에이전트

| 에이전트 | 바이너리 | 자동 감지 | YOLO 지원 | 비고 |
|-------|--------|-------------|--------------|-------|
| **Claude Code** | `claude` | 예 | 예 | 공식 Anthropic CLI |
| **Gemini CLI** | `gemini` | 예 | 아니오 | Google Gemini CLI |
| **OpenCode** | `opencode` | 예 | 예 | 오픈소스 대안 |

> 참고: Codex 지원은 현재 일시적으로 제거되었으며, Codex에 hook 지원이 추가되면 다시 지원할 예정입니다. 관련 논의: https://github.com/openai/codex/discussions/2150

### 에이전트 감지

CLI는 `which <binary>`를 사용하여 설치된 에이전트를 자동으로 감지합니다. `discode agents`를 실행하여 시스템에서 사용 가능한 에이전트를 확인하세요.

### 커스텀 에이전트 추가

새 에이전트를 추가하려면 `src/agents/`에서 `AgentAdapter` 인터페이스를 구현하세요:

```typescript
export interface AgentAdapter {
  name: string;
  detect(): Promise<boolean>;
  getCommand(projectPath: string, yolo: boolean): string[];
}
```

`src/agents/index.ts`에 어댑터를 등록하세요.

## 설정

### 글로벌 설정

`~/.discode/config.json`에 저장:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "serverId": "YOUR_SERVER_ID",
  "hookServerPort": 18470,
  "telemetryEnabled": false
}
```

`token`과 `serverId` 모두 필요합니다. `onboard` 명령이 서버 ID를 자동 감지하며, 수동 설정도 가능합니다:

```bash
discode config --show               # 현재 설정 확인
discode config --server SERVER_ID    # 서버 ID 수동 설정
discode config --telemetry on        # 익명 텔레메트리 활성화
discode config --telemetry-endpoint https://your-worker.example/v1/events
```

### 프로젝트 상태

프로젝트 상태는 `~/.discode/state.json`에 저장되며 자동으로 관리됩니다.

### 환경 변수

환경 변수로 설정을 오버라이드할 수 있습니다:

```bash
DISCORD_BOT_TOKEN=token discode daemon start
DISCORD_GUILD_ID=server_id discode new
HOOK_SERVER_PORT=18470 discode new
DISCODE_TELEMETRY_ENABLED=true discode new
DISCODE_TELEMETRY_ENDPOINT=https://your-worker.example/v1/events discode new
```

### 텔레메트리 프록시 (GA4)

Cloudflare Worker 프록시 배포:

```bash
npm run telemetry:deploy
npm run telemetry:secret
```

배포된 Worker URL을 CLI에 설정:

```bash
discode config --telemetry-endpoint https://discode-telemetry-proxy.<your-subdomain>.workers.dev
discode config --telemetry on
```

Worker 소스: `workers/telemetry-proxy`

## 개발

아키텍처 모듈 경계: [docs/MODULE_BOUNDARIES.ko.md](docs/MODULE_BOUNDARIES.ko.md)

### 빌드

```bash
bun install
bun run build          # TypeScript 컴파일
bun run dev            # 개발 모드
```

### 테스트

```bash
bun test              # 모든 테스트 실행
bun run test:watch    # 워치 모드
bun run test:coverage # 커버리지 리포트
```

테스트 스위트는 다음을 포함하는 129개의 테스트로 구성:
- 에이전트 어댑터
- 상태 관리
- Discord 클라이언트
- 훅 이벤트 전달
- CLI 명령어
- 스토리지 및 실행 모킹

### 프로젝트 구조

```
discode/
├── src/
│   ├── agents/           # 에이전트 어댑터 (Claude, Gemini, OpenCode)
│   ├── core/             # 핵심 로직 (데몬, 훅 처리, 상태)
│   ├── infra/            # 인프라 (스토리지, 셸, 환경)
│   ├── types/            # TypeScript 인터페이스
│   ├── cli/              # CLI 명령어
│   └── bin/              # 진입점
├── tests/                # Vitest 테스트 스위트
├── package.json
└── tsconfig.json
```

### 의존성 주입

코드베이스는 테스트 가능성을 위해 인터페이스와 생성자 주입을 사용합니다:

```typescript
// 인터페이스
interface IStorage { readFile, writeFile, exists, unlink }
interface ICommandExecutor { execute }
interface IEnvironment { getEnv, getCwd, getHomeDir }

// 사용
class DaemonManager {
  constructor(
    private storage: IStorage = new FileStorage(),
    private executor: ICommandExecutor = new ShellExecutor()
  ) {}
}

// 테스트
const mockStorage = new MockStorage();
const daemon = new DaemonManager(mockStorage);
```

### 코드 품질

- TypeScript strict 모드 활성화
- `.js` 확장자를 사용하는 ESM 모듈
- 129개의 통과 테스트를 가진 Vitest
- 사용하지 않는 지역 변수/매개변수 없음 (`tsconfig.json`으로 강제)

## 문제 해결

### 봇이 연결되지 않음

1. 토큰 확인: `discode config --show`
2. Discord Developer Portal에서 봇 권한 확인
3. MessageContent 인텐트가 활성화되어 있는지 확인
4. 데몬 재시작: `discode daemon stop && discode daemon start`

### 에이전트가 감지되지 않음

1. 사용 가능한 에이전트 확인: `discode agents`
2. 에이전트 바이너리가 PATH에 있는지 확인: `which claude-code`
3. 누락된 에이전트를 설치하고 재시도

### tmux 세션 문제

1. 세션이 존재하는지 확인: `tmux ls`
2. 오래된 세션 종료: `tmux kill-session -t <session-name>`
3. 프로젝트 재시작: `discode stop && discode start`

### Discord에 메시지가 없음

1. 데몬 상태 확인: `discode daemon status`
2. 데몬 로그 확인
3. Discord 채널 권한 확인 (봇에게 Send Messages 권한 필요)

### 팁: 노트북을 닫아도 계속 실행하기 (macOS)

배터리 전원 상태에서 노트북 덮개를 닫아도 Discode가 계속 동작하게 하려면 다음 명령을 실행하세요:

```bash
sudo pmset -b disablesleep 1
```

기본 절전 동작으로 되돌리려면:

```bash
sudo pmset -b disablesleep 0
```

## 기여

기여를 환영합니다! 다음 절차를 따라주세요:

1. 저장소를 포크합니다
2. 기능 브랜치를 생성합니다 (`git checkout -b feature/amazing-feature`)
3. 변경 사항을 커밋합니다 (`git commit -m 'Add amazing feature'`)
4. 브랜치에 푸시합니다 (`git push origin feature/amazing-feature`)
5. Pull Request를 엽니다

### 가이드라인

- 새 기능에 대한 테스트 추가
- TypeScript strict 모드 준수 유지
- 기존 코드 스타일 준수
- 필요에 따라 문서 업데이트

## 라이선스

MIT License - 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

## 감사의 말

- [Discord.js](https://discord.js.org/)로 구축
- [Claude Code](https://code.claude.com/docs/en/overview)와 [OpenCode](https://github.com/OpenCodeAI/opencode) 기반
- [OpenClaw](https://github.com/nicepkg/openclaw)의 메신저 기반 명령 시스템에서 영감을 받았습니다. 원격에서 오래 걸리는 AI 에이전트 작업을 Discord로 컨트롤하고 모니터링하고 싶었습니다.

## 지원

- 이슈: [GitHub Issues](https://github.com/siisee11/discode/issues)
- Discord 봇 설정: [설정 가이드](docs/DISCORD_SETUP.ko.md)
- Slack 설정: [설정 가이드](docs/SLACK_SETUP.ko.md)
