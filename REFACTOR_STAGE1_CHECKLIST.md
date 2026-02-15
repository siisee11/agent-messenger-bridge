# Refactor Stage 1 Checklist

리팩터링 이전 동작 고정을 위한 안전망 체크리스트입니다.

## 자동화 테스트 (우선)

- [x] `new` 핵심 플로우: daemon 기동 + 프로젝트 setup 호출 검증
- [x] `attach` 핵심 플로우: 인스턴스 지정 시 tmux attach target 검증
- [x] `stop` 핵심 플로우: 인스턴스 단위 정지 시 tmux/window 종료 및 state 갱신 검증

관련 테스트 파일:

- `tests/discode-cli.test.ts`

## 수동 확인 (권장)

- [ ] `discode new claude --name demo --attach false` 실행 시 정상 생성
- [ ] `discode attach demo --instance claude-2` 실행 시 올바른 window attach
- [ ] `discode stop demo --instance claude-2 --keep-channel` 실행 시 해당 인스턴스만 제거
- [ ] 에러 케이스에서 종료 코드/메시지 확인

## 다음 단계 입력 조건

- [x] 핵심 흐름(`new/attach/stop`)에 최소 회귀 테스트 존재
- [x] 구조 분리를 시작해도 기존 동작을 확인할 기준점 확보
