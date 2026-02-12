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

### Step 1.2: 봇 토큰 복사

1. Bot 페이지에서 **"TOKEN"** 섹션을 찾습니다
2. **"Reset Token"** (처음) 또는 **"Copy"** (이미 생성된 경우)를 클릭합니다
3. **중요**: 이 토큰을 안전하게 저장하세요 - 온보딩 시 필요합니다
4. **경고**: 이 토큰을 공개적으로 공유하거나 git에 커밋하지 마세요

### Step 1.3: Privileged Gateway Intents 활성화

**필수**: 봇이 메시지 내용을 읽으려면 특정 인텐트가 필요합니다.

1. **"Privileged Gateway Intents"** 섹션으로 스크롤합니다
2. 다음 인텐트를 활성화합니다:
   - ✅ **MESSAGE CONTENT INTENT** (필수 - 메시지 텍스트 읽기)
   - ✅ **SERVER MEMBERS INTENT** (선택)
3. 하단의 **"Save Changes"**를 클릭합니다

> **참고**: 봇은 인터랙티브 승인 요청을 위해 `GuildMessageReactions` 인텐트도 사용합니다 (비특권 인텐트, 자동 활성화).

---

## 2. 봇을 서버에 초대하기

### Step 2.1: 초대 URL 생성

1. [Discord Developer Portal](https://discord.com/developers/applications)로 돌아갑니다
2. 애플리케이션을 선택합니다
3. 좌측 사이드바의 **"OAuth2"**를 클릭합니다
4. **"URL Generator"**를 클릭합니다

### Step 2.2: 범위 선택

**"SCOPES"** 섹션에서 다음을 체크합니다:
- ✅ **bot**

### Step 2.3: 봇 권한 선택

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

### Step 2.4: 봇 초대하기

1. 페이지 하단의 **생성된 URL**을 복사합니다
2. 웹 브라우저에서 URL을 엽니다
3. 드롭다운에서 봇을 추가할 **서버**를 선택합니다
4. **"계속하기"**를 클릭합니다
5. 권한을 확인하고 **"승인"**을 클릭합니다
6. CAPTCHA 인증을 완료합니다
7. "Success! [Bot Name] has been added to [Server Name]" 메시지가 표시됩니다

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
