# Discord Agent Bridge

English version: [README.md](README.md)

AI 에이전트 CLI를 Discord에 연결하여 원격 모니터링 및 협업을 가능하게 합니다.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-129%20passing-brightgreen.svg)](./tests)

## 개요

Discord Agent Bridge는 AI 코딩 어시스턴트(Claude Code, OpenCode)를 Discord에 연결하여 원격 모니터링과 협업을 가능하게 합니다. Discord 채널을 통해 AI 에이전트의 작업을 실시간으로 관찰하고, 팀과 진행 상황을 공유하며, 여러 프로젝트를 동시에 추적할 수 있습니다.

이 브리지는 폴링 기반 아키텍처를 사용하여 30초마다 tmux 패인 내용을 캡처하고, 상태 변화를 감지하여, 전용 Discord 채널로 업데이트를 스트리밍합니다. 각 프로젝트는 고유한 채널을 가지며, 단일 글로벌 데몬이 모든 연결을 효율적으로 관리합니다.

## 기능

- **다중 에이전트 지원**: Claude Code와 OpenCode 지원
- **자동 검색**: 시스템에 설치된 AI 에이전트 자동 감지
- **실시간 스트리밍**: tmux 출력을 캡처하여 30초마다 Discord로 스트리밍
- **프로젝트 격리**: 각 프로젝트가 전용 Discord 채널 보유
- **단일 데몬**: 하나의 Discord 봇 연결로 모든 프로젝트 관리
- **세션 관리**: 연결 해제에도 유지되는 지속적인 tmux 세션
- **YOLO 모드**: 에이전트 자율성을 위한 `--dangerously-skip-permissions` 플래그 옵션
- **풍부한 CLI**: 설정, 제어, 모니터링을 위한 직관적인 명령어
- **타입 안전성**: 의존성 주입 패턴을 사용한 TypeScript 작성
- **충분한 테스트**: Vitest를 사용한 129개의 단위 테스트

## 사전 요구사항

- **Node.js**: 버전 18 이상
- **tmux**: 버전 3.0 이상
- **Discord Bot**: [Discord 봇 설정 가이드](docs/DISCORD_SETUP.ko.md)를 따라 봇 생성
  - 필수 권한: Send Messages, Manage Channels, Read Message History, Embed Links, Add Reactions
  - 필수 인텐트: Guilds, GuildMessages, MessageContent, GuildMessageReactions
- **AI 에이전트**: 다음 중 하나 이상:
  - [Claude Code](https://claude.ai/claude-code) (API 키 필요)
  - [OpenCode](https://github.com/OpenCodeAI/opencode) (API 키 필요)

## 설치

### npm을 통한 설치

```bash
npm install -g discord-agent-bridge
```

### 소스에서 설치

```bash
git clone https://github.com/DoBuDevel/discord-agent-bridge.git
cd discord-agent-bridge
npm install
npm run build
npm link
```

## 빠른 시작

### 1. Discord 봇 설정

```bash
# Discord 봇 토큰으로 일회성 설정
agent-discord setup YOUR_DISCORD_BOT_TOKEN
```

### 2. 프로젝트 초기화

```bash
# 프로젝트 디렉토리로 이동
cd ~/projects/my-app

# Claude Code로 초기화 (또는 'opencode')
agent-discord init claude "멋진 애플리케이션"
```

### 3. 작업 시작

```bash
# 빠른 시작: 데몬 + 프로젝트 + 연결을 한 번에
agent-discord go

# 또는 단계별로:
agent-discord daemon start    # 글로벌 데몬 시작
agent-discord start          # 이 프로젝트 시작
agent-discord attach         # tmux 세션에 연결
```

이제 AI 에이전트가 tmux에서 실행되며, 30초마다 Discord로 출력이 스트리밍됩니다.

## CLI 참조

### 글로벌 명령어

#### `setup <token>`

일회성 설정: 봇 토큰 저장, Discord 연결하여 서버 자동 감지, 설치된 에이전트 확인.

```bash
agent-discord setup YOUR_BOT_TOKEN
```

설정 과정:
1. 봇 토큰을 `~/.discord-agent-bridge/config.json`에 저장
2. Discord에 연결하여 봇이 참여한 서버를 자동 감지
3. 봇이 여러 서버에 있으면 선택 프롬프트 표시
4. 서버 ID 자동 저장

#### `daemon <action>`

글로벌 데몬 프로세스 제어.

```bash
agent-discord daemon start    # 데몬 시작
agent-discord daemon stop     # 데몬 중지
agent-discord daemon restart  # 데몬 재시작
agent-discord daemon status   # 데몬 상태 확인
```

#### `list`

등록된 모든 프로젝트 목록 표시.

```bash
agent-discord list
```

#### `agents`

시스템에서 감지된 사용 가능한 AI 에이전트 목록 표시.

```bash
agent-discord agents
```

#### `config [options]`

글로벌 설정 조회 및 수정.

```bash
agent-discord config --show              # 현재 설정 표시
agent-discord config --token NEW_TOKEN   # 봇 토큰 변경
agent-discord config --server SERVER_ID  # Discord 서버 ID 수동 설정
agent-discord config --port 18470        # 훅 서버 포트 설정
```

### 프로젝트 명령어

`init` 이후 프로젝트 디렉토리에서 이 명령어들을 실행합니다.

#### `init <agent> <description>`

현재 디렉토리를 프로젝트로 초기화.

```bash
agent-discord init claude "풀스택 웹 애플리케이션"
agent-discord init opencode "데이터 파이프라인 프로젝트"
```

#### `start [options]`

이 프로젝트의 AI 에이전트 시작.

```bash
agent-discord start                    # 일반 모드
agent-discord start --yolo            # YOLO 모드 (권한 확인 스킵)
agent-discord start --dangerously-skip-permissions  # --yolo와 동일
```

#### `stop`

이 프로젝트의 AI 에이전트 중지.

```bash
agent-discord stop
```

#### `status`

프로젝트 상태 표시.

```bash
agent-discord status
```

#### `attach`

이 프로젝트의 tmux 세션에 연결.

```bash
agent-discord attach
```

에이전트를 중지하지 않고 tmux에서 분리하려면 `Ctrl-b d`를 누르세요.

#### `go [options]`

빠른 시작: 데몬 시작, 프로젝트 시작, 연결을 한 번에 수행.

```bash
agent-discord go              # 일반 모드
agent-discord go --yolo      # YOLO 모드
agent-discord go --sandbox   # 샌드박스 모드 (Docker 컨테이너에서 Claude Code 실행)
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
         │ tmux capture-pane (30초마다)
         │
    ┌────▼─────────────┐
    │  CapturePoller   │  상태 변화 감지
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
- **Capture Poller**: 30초마다 tmux 패인을 폴링하고, 변화를 감지하여 Discord로 전송
- **Agent Registry**: 다중 에이전트 지원을 위한 팩토리 패턴 (Claude, OpenCode)
- **State Manager**: 프로젝트 상태, 세션, 채널 추적
- **Dependency Injection**: 스토리지, 실행, 환경을 위한 인터페이스 (테스트 가능, 모킹 가능)

### 폴링 모델

브리지는 훅 대신 **폴링 기반** 아키텍처를 사용합니다:

1. 30초마다(설정 가능) 폴러가 `tmux capture-pane` 실행
2. 캡처한 내용을 이전 스냅샷과 비교
3. 변화가 감지되면 새 내용을 Discord로 전송
4. 멀티라인 출력, ANSI 코드, 속도 제한 처리

이 접근 방식은 훅 기반 시스템보다 간단하고 안정적이며, 성능 영향이 최소화됩니다.

### 프로젝트 라이프사이클

1. **Init**: 프로젝트 메타데이터와 함께 `.agent-discord.json` 생성
2. **Start**: 명명된 tmux 세션에서 AI 에이전트 실행
3. **Polling**: 데몬이 tmux 출력을 캡처하여 Discord로 스트리밍
4. **Stop**: tmux 세션 종료 및 정리
5. **Attach**: 사용자가 tmux 세션에 참여하여 직접 상호작용 가능

## 지원되는 에이전트

| 에이전트 | 바이너리 | 자동 감지 | YOLO 지원 | 비고 |
|-------|--------|-------------|--------------|-------|
| **Claude Code** | `claude-code` | 예 | 예 | 공식 Anthropic CLI |
| **OpenCode** | `opencode` | 예 | 예 | 오픈소스 대안 |

### 에이전트 감지

CLI는 `which <binary>`를 사용하여 설치된 에이전트를 자동으로 감지합니다. `agent-discord agents`를 실행하여 시스템에서 사용 가능한 에이전트를 확인하세요.

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

`~/.discord-agent-bridge/config.json`에 저장:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "serverId": "YOUR_SERVER_ID",
  "hookServerPort": 18470
}
```

`token`과 `serverId` 모두 필요합니다. `setup` 명령이 서버 ID를 자동 감지하며, 수동 설정도 가능합니다:

```bash
agent-discord config --show               # 현재 설정 확인
agent-discord config --server SERVER_ID    # 서버 ID 수동 설정
```

### 프로젝트 상태

프로젝트 상태는 `~/.discord-agent-bridge/state.json`에 저장되며 자동으로 관리됩니다.

### 환경 변수

환경 변수로 설정을 오버라이드할 수 있습니다:

```bash
DISCORD_BOT_TOKEN=token agent-discord daemon start
DISCORD_GUILD_ID=server_id agent-discord go
HOOK_SERVER_PORT=18470 agent-discord go
```

## 개발

### 빌드

```bash
npm install
npm run build          # TypeScript 컴파일
npm run build:watch    # 워치 모드
```

### 테스트

```bash
npm test              # 모든 테스트 실행
npm run test:watch    # 워치 모드
npm run test:coverage # 커버리지 리포트
```

테스트 스위트는 다음을 포함하는 129개의 테스트로 구성:
- 에이전트 어댑터
- 상태 관리
- Discord 클라이언트
- 캡처 폴링
- CLI 명령어
- 스토리지 및 실행 모킹

### 프로젝트 구조

```
discord-agent-bridge/
├── src/
│   ├── agents/           # 에이전트 어댑터 (Claude, OpenCode)
│   ├── core/             # 핵심 로직 (데몬, 폴러, 상태)
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

1. 토큰 확인: `agent-discord config --show`
2. Discord Developer Portal에서 봇 권한 확인
3. MessageContent 인텐트가 활성화되어 있는지 확인
4. 데몬 재시작: `agent-discord daemon stop && agent-discord daemon start`

### 에이전트가 감지되지 않음

1. 사용 가능한 에이전트 확인: `agent-discord agents`
2. 에이전트 바이너리가 PATH에 있는지 확인: `which claude-code`
3. 누락된 에이전트를 설치하고 재시도

### tmux 세션 문제

1. 세션이 존재하는지 확인: `tmux ls`
2. 오래된 세션 종료: `tmux kill-session -t <session-name>`
3. 프로젝트 재시작: `agent-discord stop && agent-discord start`

### Discord에 메시지가 없음

1. 데몬 상태 확인: `agent-discord daemon status`
2. 데몬 로그 확인
3. Discord 채널 권한 확인 (봇에게 Send Messages 권한 필요)

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
- [Claude Code](https://claude.ai/claude-code)와 [OpenCode](https://github.com/OpenCodeAI/opencode) 기반
- [OpenClaw](https://github.com/nicepkg/openclaw)의 메신저 기반 명령 시스템에서 영감을 받았습니다. 원격에서 오래 걸리는 AI 에이전트 작업을 Discord로 컨트롤하고 모니터링하고 싶었습니다.

## 지원

- 이슈: [GitHub Issues](https://github.com/DoBuDevel/discord-agent-bridge/issues)
- Discord 봇 설정: [설정 가이드](docs/DISCORD_SETUP.ko.md)
