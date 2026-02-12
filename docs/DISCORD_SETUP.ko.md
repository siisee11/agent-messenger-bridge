# Discord Bot 설정 가이드

English version: [DISCORD_SETUP.md](DISCORD_SETUP.md)

Discode를 위한 Discord 봇 설정 완전 가이드입니다.

---

## 1. Discord 봇 생성하기

### Step 1.1: 애플리케이션 생성

1. [Discord Developer Portal](https://discord.com/developers/applications)에 접속합니다
2. 우측 상단의 **"New Application"** 버튼을 클릭합니다
3. 봇의 이름을 입력합니다 (예: "Discode")
4. 서비스 약관에 동의하고 **"Create"**를 클릭합니다

### Step 1.2: 봇 유저 생성

1. 애플리케이션 페이지에서 좌측 사이드바의 **"Bot"** 탭을 클릭합니다
2. **"Add Bot"** 버튼을 클릭합니다
3. **"Yes, do it!"**을 클릭하여 확인합니다
4. "A wild bot has appeared!" 메시지가 표시됩니다

### Step 1.3: 봇 토큰 복사

1. Bot 페이지에서 **"TOKEN"** 섹션을 찾습니다
2. **"Reset Token"** (처음) 또는 **"Copy"** (이미 생성된 경우)를 클릭합니다
3. **중요**: 이 토큰을 안전하게 저장하세요 - 온보딩 시 필요합니다
4. **경고**: 이 토큰을 공개적으로 공유하거나 git에 커밋하지 마세요

### Step 1.4: Privileged Gateway Intents 활성화

**필수**: 봇이 메시지 내용을 읽으려면 특정 인텐트가 필요합니다.

1. **"Privileged Gateway Intents"** 섹션으로 스크롤합니다
2. 다음 인텐트를 활성화합니다:
   - ✅ **MESSAGE CONTENT INTENT** (필수 - 메시지 텍스트 읽기)
   - ✅ **SERVER MEMBERS INTENT** (선택)
3. 하단의 **"Save Changes"**를 클릭합니다

> **참고**: 봇은 인터랙티브 승인 요청을 위해 `GuildMessageReactions` 인텐트도 사용합니다 (비특권 인텐트, 자동 활성화).

---

## 2. 서버 ID 가져오기

### Step 2.1: 개발자 모드 활성화

1. Discord를 열고 좌측 하단의 **톱니바퀴 아이콘** (사용자 설정)을 클릭합니다
2. 좌측 사이드바에서 **"고급"** ("앱 설정" 아래)으로 이동합니다
3. **"개발자 모드"** 토글을 활성화합니다
4. 설정을 닫습니다

### Step 2.2: 서버 ID 복사

1. 서버 목록에서 **서버 이름** (또는 서버 아이콘)을 우클릭합니다
2. 메뉴 하단의 **"서버 ID 복사"**를 클릭합니다
3. 이 ID를 저장하세요 - 수동 설정 시 필요할 수 있습니다

**참고:**
- `discode onboard` 명령은 Discord가 활성화된 상태에서 실행하면 서버 ID를 자동으로 감지합니다
- 수동 설정: `discode config --server YOUR_SERVER_ID`

---

## 3. 봇을 서버에 초대하기

### Step 3.1: 초대 URL 생성

1. [Discord Developer Portal](https://discord.com/developers/applications)로 돌아갑니다
2. 애플리케이션을 선택합니다
3. 좌측 사이드바의 **"OAuth2"**를 클릭합니다
4. **"URL Generator"**를 클릭합니다

### Step 3.2: 범위 선택

**"SCOPES"** 섹션에서 다음을 체크합니다:
- ✅ **bot**

### Step 3.3: 봇 권한 선택

하단에 나타나는 **"BOT PERMISSIONS"** 섹션에서 다음을 체크합니다:

**텍스트 권한:**
- ✅ **Send Messages** - 에이전트 출력 전송에 필요
- ✅ **Send Messages in Threads** - 쓰레드 지원용
- ✅ **Embed Links** - 인터랙티브 질문 임베드에 필수
- ✅ **Read Message History** - 컨텍스트 추적 및 리액션 수집에 필수
- ✅ **Add Reactions** - 도구 승인 요청에 필수

**일반 권한:**
- ✅ **View Channels** - 채널 보기 및 접근에 필요
- ✅ **Manage Channels** - 에이전트 전용 채널 자동 생성에 필수

### Step 3.4: 봇 초대하기

1. 페이지 하단의 **생성된 URL**을 복사합니다
2. 웹 브라우저에서 URL을 엽니다
3. 드롭다운에서 봇을 추가할 **서버**를 선택합니다
4. **"계속하기"**를 클릭합니다
5. 권한을 확인하고 **"승인"**을 클릭합니다
6. CAPTCHA 인증을 완료합니다
7. "Success! [Bot Name] has been added to [Server Name]" 메시지가 표시됩니다

---

## 4. 필수 봇 권한

### 최소 필수 권한

| 권한 | 필수 여부 | 목적 |
|------|----------|------|
| View Channels (채널 보기) | ✅ 필수 | 봇이 작동하려면 채널을 볼 수 있어야 함 |
| Send Messages (메시지 전송) | ✅ 필수 | 에이전트 출력을 Discord로 전송 |
| Read Message History (메시지 기록 읽기) | ✅ 필수 | 대화 컨텍스트 추적 및 리액션 수집 |
| Embed Links (링크 임베드) | ✅ 필수 | 인터랙티브 질문 임베드 포맷팅 |
| Manage Channels (채널 관리) | ✅ 필수 | `init`/`new`/`stop` 시 채널 생성/삭제 |
| Add Reactions (반응 추가) | ✅ 필수 | 도구 승인 요청 인터랙션 |

### 권한 문제

봇이 메시지를 보낼 수 없다면 확인하세요:
1. 서버 레벨 권한이 부여되었는지
2. 채널별 권한 재정의 여부 (채널 설정 확인)
3. 봇 역할이 다른 제한적인 역할보다 아래에 있지 않은지

---

## 5. 설정 확인

### Step 5.1: 온보딩 명령 실행

```bash
discode onboard
```

실행 후 프롬프트가 나오면 Step 1.3에서 복사한 토큰을 입력하세요.

### Step 5.2: 예상 출력

**성공적인 온보딩:**
```
✓ Discord 봇 토큰이 설정되었습니다
✓ Discord에 연결되었습니다
✓ 봇이 온라인입니다: Discode#1234
✓ 서버를 찾았습니다: My Awesome Server (ID: 123456789...)
✓ 설정이 ~/.discode/config.json에 저장되었습니다

설정 완료! 봇을 사용할 준비가 되었습니다.

다음 단계:
1. 실행: discode new
2. 봇이 프로젝트와 선택한 AI CLI에 맞는 채널을 생성합니다
3. 에이전트 출력이 해당 채널로 스트리밍됩니다
```

### Step 5.3: 봇이 온라인인지 확인

1. Discord를 엽니다
2. 서버의 멤버 목록을 확인합니다 (우측 사이드바)
3. "BOT" 태그가 있는 봇 이름을 찾습니다
4. 봇이 **온라인** (초록색 상태)으로 표시되어야 합니다

### Step 5.4: 명령어로 테스트

```bash
discode new
```

터미널에 메시지를 입력하고 Enter를 누르세요. 다음이 보여야 합니다:
- Discord에 새 채널 생성됨 (자동 채널이 활성화된 경우)
- 해당 채널에 메시지가 나타남
- 봇이 에이전트 출력으로 응답함

---

## 문제 해결

### 봇이 오프라인으로 표시됨

- 토큰이 올바른지 확인하세요
- 봇이 서버에 초대되었는지 확인하세요
- 네트워크/방화벽 설정을 확인하세요

### 봇이 메시지를 보낼 수 없음

- "메시지 전송" 권한이 부여되었는지 확인하세요
- 채널별 권한 재정의를 확인하세요
- 봇 역할이 권한을 제한하는 다른 역할보다 위에 있는지 확인하세요

### "액세스 누락" 오류

- 봇이 제대로 초대되지 않았습니다 - 초대 URL을 다시 생성하고 재초대하세요
- "채널 보기" 권한이 부여되었는지 확인하세요

### "잘못된 토큰" 오류

- 토큰이 재생성되었을 수 있습니다 - Developer Portal에서 새 토큰을 받으세요
- 토큰 복사 시 불필요한 공백이 없는지 확인하세요
- 새 토큰으로 `discode onboard --token NEW_BOT_TOKEN`을 실행하세요

### 메시지를 읽거나 명령을 감지할 수 없음

- **중요**: Bot 설정에서 "MESSAGE CONTENT INTENT"를 활성화하세요 (Step 1.4)
- 이 인텐트 없이는 봇이 메시지 내용을 읽을 수 없습니다

---

## 보안 모범 사례

1. **봇 토큰을 절대 git에 커밋하지 마세요**
   - 환경 변수나 `.gitignore`가 적용된 설정 파일을 사용하세요

2. **토큰이 노출되면 즉시 재생성하세요**
   - 실수로 토큰을 공유했다면 Developer Portal에서 즉시 재생성하세요

3. **봇 권한을 제한하세요**
   - 봇이 실제로 필요한 권한만 부여하세요

4. **테스트와 프로덕션에 별도의 봇을 사용하세요**
   - 개발용과 라이브 서버용으로 다른 봇 애플리케이션을 만드세요

---

## 추가 자료

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord.js Guide](https://discordjs.guide/)
- [Discord API Documentation](https://discord.com/developers/docs/intro)
- [Discode README](../README.md)

---

## 빠른 참조 카드

```
1. 봇 생성: https://discord.com/developers/applications

2. 인텐트 활성화: MESSAGE CONTENT INTENT (필수)

3. Bot 탭에서 봇 토큰 복사

4. OAuth2 > URL Generator에서 초대 URL 생성
   - Scope: bot
   - Permissions: View Channels, Send Messages, Read Message History

5. 서버에 봇 초대

6. 실행: discode onboard

7. 사용 시작: discode new
```

---

**최종 업데이트**: 2026-02-09
**버전**: 1.0.0
