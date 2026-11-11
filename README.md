# EDIT AI

Next.js · FastAPI · OpenAI · FFmpeg 기반 AI 영상 편집 스튜디오입니다. 현재 MVP는 영상 업로드 → 한국어 음성 전사 → 요청과 전사를 바탕으로 AI가 편집 구간 선택 → FFmpeg 컷 편집 및 한국어 자막 트랙 추가 → 미리보기/MP4 다운로드까지 실제로 처리합니다.

> **현재 범위:** 초기 1인용 MVP입니다. 작업 상태는 FastAPI 프로세스 메모리, 원본/결과 파일은 API 서버 디스크에 저장하고, 브라우저의 프로젝트 바로가기는 localStorage를 씁니다. PostgreSQL 기반 계정·프로젝트 저장, 결제, 자동 배경음악 생성/믹싱, 화면에 구워지는 스타일 자막, 4K 렌더링은 아직 구현하지 않았습니다. 스타일 선택은 AI 편집 계획을 안내하며 별도의 효과·음악을 만들지는 않습니다. 실패한 경우 가짜 편집 결과를 보여주지 않고 오류를 표시합니다.

## 준비물

- Node.js 20.9 이상 및 npm
- Python 3.10 이상
- FFmpeg와 ffprobe 설치 및 PATH 등록
- 음성 전사/채팅 모델을 사용할 수 있는 OpenAI API 키 (API 사용료가 발생할 수 있음)

Windows에서는 [Python](https://www.python.org/downloads/windows/)과 [FFmpeg](https://ffmpeg.org/download.html)를 설치하세요. FFmpeg는 신뢰할 수 있는 패키지 관리자를 이용해 설치할 수도 있습니다(예: `winget install Gyan.FFmpeg.Shared`). 터미널을 다시 열고 아래 명령으로 확인하세요.

```powershell
python --version
ffmpeg -version
ffprobe -version
```

## 로컬에서 실행

### 1. API 서버 설정 및 시작

PowerShell 터미널에서:

```powershell
cd C:\Users\user\edit-ai\backend
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

`backend/.env` 파일을 열고 `OPENAI_API_KEY`를 [OpenAI API 키 페이지](https://platform.openai.com/api-keys)에서 발급한 키로 바꾸세요. 키를 웹 앱의 `NEXT_PUBLIC_*` 환경 변수에 넣거나 공개 저장소에 커밋하지 마세요. 같은 PowerShell 창에서 API를 시작합니다.

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
uvicorn main:app --reload --port 8000
```

`http://localhost:8000/health`에 접속해 `ffmpeg`, `ffprobe`, `openai_configured`가 모두 `true`인지 확인하세요.

### 2. 웹 앱 시작 (별도 터미널)

```powershell
cd C:\Users\user\edit-ai
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 여세요. API 주소를 바꾸려면 프로젝트 루트에 `.env.local` 파일을 만들고 `NEXT_PUBLIC_API_URL=http://localhost:8000`을 설정한 뒤 Next.js를 재시작합니다.

## 현재 편집 기능/제한

- 입력: MP4, MOV, M4V, WEBM (기본 최대 2GB, `EDIT_AI_MAX_UPLOAD_BYTES`로 변경 가능)
- 음성 인식: FFmpeg로 오디오를 추출해 OpenAI Whisper에 전송합니다. 전사 텍스트와 요청은 `gpt-4o-mini`에 전달되어 원본의 유지 구간을 고릅니다. 모델은 `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_EDIT_MODEL`로 변경할 수 있습니다.
- 결과: 선택 구간을 H.264/AAC로 렌더링하고 한국어 자막을 MP4 `mov_text` 자막 트랙으로 넣습니다. 자막은 영상에 구워지는 방식이 아니며, 호환 플레이어에서 켜고 끌 수 있습니다.
- 비율: 16:9, 9:16, 1:1, 1080p 크기로 렌더링합니다.
- 작업 파일은 `backend/data`에 저장됩니다. `EDIT_AI_DATA_DIR`로 저장 위치를 변경할 수 있습니다. 현재 작업 큐는 메모리 기반이며 공개 서비스에 바로 배포하기 위한 보안/확장 설정은 포함되어 있지 않습니다.

## API

- `GET /health` — API, FFmpeg, ffprobe, API 키 설정 확인
- `POST /jobs` — multipart 영상 업로드 (`file`, `prompt`, `style`, `ratio`)
- `GET /jobs/{id}` — 실제 처리 상태 확인
- `GET /jobs/{id}/download` — MP4 인라인 미리보기
- `GET /jobs/{id}/download?download=1` — MP4 다운로드
