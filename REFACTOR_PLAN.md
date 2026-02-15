# Refactor Plan

## 배경

현재 코드베이스는 일부 핵심 파일에 책임이 집중되어 있습니다.

- `bin/discode.ts`: CLI 엔트리, 명령 파싱, 온보딩, daemon 제어, tmux 제어, 프로젝트 생명주기 로직이 혼재
- `src/index.ts` (`AgentBridge`): Discord 라우팅, HTTP 훅 서버, 프로젝트 초기화, 플러그인/훅 설치, 반응 상태 추적까지 단일 클래스에서 처리

이로 인해 변경 영향 범위가 넓고, 테스트 없이 구조 변경 시 회귀 위험이 큽니다.

## 목표

1. 파일별 책임을 명확히 분리한다.
2. 구조 변경 전후 기능 동작을 테스트로 고정한다.
3. 리팩터링 단위를 작게 나눠 안전하게 진행한다.
4. 향후 기능 추가 시 파일 복잡도가 다시 증가하지 않도록 경계를 문서화한다.

## 범위

### 포함

- `bin/discode.ts` 명령 로직 분리
- `src/index.ts`의 `AgentBridge` 내부 책임 분리
- 중복 유틸(환경변수 export 문자열, 창 이름 규칙, 플러그인 설치 분기) 공통화
- 테스트 보강

### 제외

- 사용자 기능/CLI UX의 의도적 변경
- 프로토콜/저장 포맷의 파괴적 변경
- 외부 패키지 교체를 동반한 대규모 마이그레이션

## 실행 전략 (점진적)

## 1단계: 리팩터링 안전망 구축

목적: 구조 변경 전에 현재 동작을 고정

- 핵심 플로우 우선 테스트 고정: `new`, `stop`, `attach`
- 검증 대상
  - 종료 코드/에러 처리
  - 상태 저장(`stateManager`) 변경
  - daemon/tmux/discord 호출 순서와 조건
  - 주요 사용자 출력 메시지(필요 최소한)

산출물

- CLI 동작 회귀를 잡아줄 테스트 추가
- 리팩터링 대상 동작 체크리스트

## 2단계: CLI 엔트리 분리

목적: `bin/discode.ts`를 조립 전용으로 축소

- `src/cli/commands/*.ts`로 명령별 분리
  - 예: `new.ts`, `stop.ts`, `attach.ts`, `onboard.ts`, `daemon.ts`, `config.ts`
- 공통 모듈 분리
  - `src/cli/common/options.ts` (yargs 옵션 조립)
  - `src/cli/common/output.ts` (출력 포맷/공통 메시지)
  - `src/cli/common/interactive.ts` (prompt/confirm)
- `bin/discode.ts`에는 명령 등록 + 핸들러 연결만 남김

산출물

- `bin/discode.ts` 라인 수 대폭 감소
- 명령별 파일 단위 테스트 가능 구조 확보

## 3단계: 애플리케이션 서비스 계층 도입

목적: CLI와 도메인 로직 분리

- `src/app/project-service.ts`
  - 프로젝트 생성/재개/중지
  - 인스턴스 ID 계산 및 상태 반영
- `src/app/daemon-service.ts`
  - daemon start/stop/status/wait 래핑
- `src/app/channel-service.ts` (필요 시)
  - Discord 채널 생성/삭제 및 매핑 동기화

산출물

- CLI는 서비스 호출 + 출력 책임만 유지
- 로직 테스트를 CLI 파서 없이 독립 실행 가능

## 4단계: AgentBridge 분해

목적: `src/index.ts` 단일 클래스 과책임 해소

- 제안 모듈
  - `src/bridge/message-router.ts`
    - Discord → agent 전송 라우팅, 첨부파일 처리, 입력 검증
  - `src/bridge/hook-server.ts`
    - HTTP 서버 시작/종료, `/reload`, `/opencode-event` 처리
  - `src/bridge/project-bootstrap.ts`
    - 시작 시 상태 로드, 플러그인/훅 설치, 채널 매핑 초기화
  - `src/bridge/pending-message-tracker.ts`
    - ⏳/✅/❌ 반응 상태 추적
- `AgentBridge`는 위 컴포넌트 조립 및 라이프사이클만 담당

산출물

- `src/index.ts` 복잡도 및 변경 영향도 감소
- 기능 단위 테스트/디버깅 용이성 향상

## 5단계: 중복 제거 및 규칙 통합

목적: CLI/Bridge 간 중복 로직 제거

- 공통 유틸로 통합
  - env export prefix 생성
  - project/instance window naming 규칙
  - 에이전트별 플러그인/훅 설치 분기
- 네이밍/에러 메시지/로깅 포맷 일관화

산출물

- 중복 코드 감소
- 동일 정책의 단일 소스 유지

## 6단계: 마무리

- dead code 정리
- 모듈 경계 문서화 (`README` 또는 개발 문서)
- 회귀 테스트 전체 실행 및 안정화

## 품질 게이트

각 단계 완료 기준

1. 테스트 통과
2. 기존 사용자 시나리오 동작 유지
3. 변경 파일 책임이 이전보다 명확해짐
4. 단계별 PR이 작고 리뷰 가능 범위 유지

## 리스크 및 대응

- 리스크: 분리 중 미세한 동작 차이(특히 `new/stop/attach`)
  - 대응: 1단계 테스트 고정 + 단계별 작은 PR
- 리스크: CLI 출력/흐름 변경으로 사용성 혼선
  - 대응: 출력 메시지 스냅샷/핵심 문구 유지
- 리스크: 모듈 분리 후 의존성 순환
  - 대응: `cli -> app -> infra` 단방향 의존 규칙 유지

## 권장 작업 단위 (PR 제안)

1. PR-1: 핵심 CLI 플로우 테스트 고정
2. PR-2: CLI 명령 파일 분리 (`new/attach/stop` 우선)
3. PR-3: 서비스 계층 도입 (`project-service`, `daemon-service`)
4. PR-4: AgentBridge 모듈 분해 (`hook-server`, `message-router`)
5. PR-5: 공통 유틸 통합 + 문서화/정리

## 완료 정의 (Definition of Done)

- `bin/discode.ts`는 엔트리/등록 역할 중심으로 축소됨
- `src/index.ts`는 브리지 조립/수명주기 중심으로 축소됨
- 핵심 흐름(`new`, `stop`, `attach`, bridge start/stop/event`)에 테스트가 존재함
- 구조 변경 후 기능 회귀가 없고 운영 절차(daemon 재시작 등)와 충돌하지 않음
