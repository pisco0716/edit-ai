from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from dotenv import dotenv_values, load_dotenv


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("EDIT_AI_DATA_DIR", str(ROOT / "data"))).resolve()
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
for directory in (UPLOAD_DIR, OUTPUT_DIR):
    directory.mkdir(parents=True, exist_ok=True)

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
MAX_UPLOAD_BYTES = int(os.getenv("EDIT_AI_MAX_UPLOAD_BYTES", str(2 * 1024**3)))
ALLOWED_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm"}
STYLE_NOTES = {
    "youtube": "유튜브 롱폼: 앞뒤의 불필요한 공백과 침묵을 줄이고, 설명의 흐름과 문맥은 충분히 보존합니다.",
    "shorts": "쇼츠: 가장 핵심적인 부분 위주로 빠른 템포의 짧은 세로 영상을 만듭니다. 요청이 없으면 약 60초 이내를 목표로 합니다.",
    "vlog": "브이로그: 자연스러운 호흡과 일상의 맥락을 살리고 지나친 컷 편집을 피합니다.",
    "cinema": "시네마틱: 문맥을 유지하면서 강한 장면과 감정적인 흐름이 살아나도록 편집합니다.",
    "variety": "예능: 반복, 긴 침묵, 말실수를 줄이고 재미와 반응이 살아나는 부분을 선택합니다.",
    "ad": "광고: 제품/서비스의 핵심 메시지와 이점이 잘 전달되는 부분을 중심으로 압축합니다.",
}

app = FastAPI(title="EDIT AI API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_ORIGIN", "http://localhost:3000"), "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def update_job(job_id: str, **values: Any) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(values)


def load_app_env() -> None:
    env_path = ROOT / ".env"
    load_dotenv(env_path, override=False)
    # An initially empty OPENAI_API_KEY= is common during setup. Refresh that
    # value from the file if the user adds a key while the local API is running.
    if not os.getenv("OPENAI_API_KEY", "").strip():
        key = dotenv_values(env_path).get("OPENAI_API_KEY")
        if isinstance(key, str) and key.strip():
            os.environ["OPENAI_API_KEY"] = key.strip()


def run(command: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise RuntimeError("FFmpeg/ffprobe를 찾을 수 없습니다. 설치 후 PATH에 추가하고 API 서버를 다시 시작해 주세요. https://ffmpeg.org/download.html") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "알 수 없는 FFmpeg 오류").strip()
        raise RuntimeError(f"미디어 처리에 실패했습니다: {detail[-1800:]}")
    return result


def probe_duration(video: Path) -> float:
    result = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(video)])
    return max(0.1, float(json.loads(result.stdout)["format"]["duration"]))


def transcribe_video(video: Path, work_dir: Path, client: Any) -> list[dict[str, Any]]:
    audio_dir = work_dir / "audio"
    audio_dir.mkdir(exist_ok=True)
    audio_pattern = audio_dir / "chunk_%03d.mp3"
    # Short, low-bitrate chunks stay below the transcription upload limit even for long recordings.
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-vn",
        "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "segment", "-segment_time", "600",
        "-reset_timestamps", "1", str(audio_pattern),
    ])
    audio_files = sorted(audio_dir.glob("chunk_*.mp3"))
    if not audio_files:
        raise RuntimeError("영상에서 오디오를 추출하지 못했습니다. 영상에 음성이 있는지 확인해 주세요.")

    all_segments: list[dict[str, Any]] = []
    for index, audio_path in enumerate(audio_files):
        with audio_path.open("rb") as audio:
            response = client.audio.transcriptions.create(
                model=os.getenv("OPENAI_TRANSCRIPTION_MODEL", "whisper-1"),
                file=audio,
                language="ko",
                response_format="verbose_json",
                timestamp_granularities=["segment"],
            )
        offset = index * 600
        segments = getattr(response, "segments", None) or []
        for item in segments:
            text = str(getattr(item, "text", "")).strip()
            start = max(0.0, float(getattr(item, "start", 0)) + offset)
            end = max(start + 0.08, float(getattr(item, "end", start + 0.1)) + offset)
            if text:
                all_segments.append({"start": start, "end": end, "text": text})
    if not all_segments:
        raise RuntimeError("음성 인식 결과가 비어 있습니다. 오디오가 포함된 영상인지 확인해 주세요.")
    return all_segments


def make_edit_plan(segments: list[dict[str, Any]], prompt: str, style: str, duration: float, client: Any) -> list[dict[str, float]]:
    transcript = "\n".join(f"[{s['start']:.2f}-{s['end']:.2f}] {s['text']}" for s in segments)
    instructions = f"""
당신은 영상 편집 어시스턴트입니다. 주어진 전사와 사용자의 요청을 바탕으로 원본 영상에서 유지할 구간만 선택합니다.
사용자 편집 요청: {prompt}
스타일: {STYLE_NOTES.get(style, STYLE_NOTES['youtube'])}
전체 길이: {duration:.2f}초
반드시 JSON 객체 하나만 반환하세요. 형식: {{"keep": [{{"start": 0.0, "end": 12.3}}]}}
규칙: 시간은 초 단위 원본 기준이며 0 이상 {duration:.2f} 이하입니다. 유지할 구간은 시작 순서로 정렬하고 서로 겹치지 않게 합니다.
문장 중간을 자르지 말고 전사 구간 경계 근처를 사용하세요. 요청이 명확하지 않다면 핵심 내용을 보존하고 긴 침묵/반복만 소폭 제거하세요.
사용자가 특정 장면을 강조하거나 길이를 줄여 달라고 한 경우 그 의도를 우선하세요. 의미 없는 아주 짧은 구간은 만들지 마세요.
"keep"은 영상에서 실제로 남길 구간입니다. 가능한 한 전사된 내용을 담되 요청된 목표 길이에 맞게 선택하세요.
""".strip()
    # Keep the prompt bounded for long source recordings.
    transcript = transcript[:100000]
    response = client.chat.completions.create(
        model=os.getenv("OPENAI_EDIT_MODEL", "gpt-4o-mini"),
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": "정확하고 보수적으로 편집 구간을 선택하세요. 결과는 요청한 JSON 형식만 반환합니다."},
            {"role": "user", "content": f"{instructions}\n\n전사(시간, 텍스트):\n{transcript}"},
        ],
        temperature=0.2,
    )
    try:
        data = json.loads(response.choices[0].message.content or "{}")
        raw = data.get("keep", [])
    except (ValueError, TypeError, AttributeError, IndexError) as exc:
        raise RuntimeError("AI가 유효한 편집 계획을 반환하지 않았습니다. 다시 시도해 주세요.") from exc
    keep: list[dict[str, float]] = []
    for segment in raw:
        try:
            start = max(0.0, float(segment["start"]))
            end = min(duration, float(segment["end"]))
        except (KeyError, TypeError, ValueError):
            continue
        if end - start >= 0.35:
            keep.append({"start": start, "end": end})
    keep.sort(key=lambda item: item["start"])
    normalized: list[dict[str, float]] = []
    for span in keep:
        if normalized and span["start"] <= normalized[-1]["end"] + 0.12:
            normalized[-1]["end"] = max(normalized[-1]["end"], span["end"])
        else:
            normalized.append(span)
    if not normalized:
        raise RuntimeError("AI 편집 계획에서 남길 구간을 찾지 못했습니다. 요청을 조금 더 구체적으로 적어 주세요.")
    return normalized[:80]


def make_srt(segments: list[dict[str, Any]], keep: list[dict[str, float]], target: Path) -> None:
    entries: list[tuple[float, float, str]] = []
    timeline_offset = 0.0
    for span in keep:
        for segment in segments:
            start = max(float(segment["start"]), span["start"])
            end = min(float(segment["end"]), span["end"])
            text = str(segment["text"]).strip()
            if end > start + 0.05 and text:
                entries.append((timeline_offset + start - span["start"], timeline_offset + end - span["start"], text))
        timeline_offset += span["end"] - span["start"]

    def stamp(seconds: float) -> str:
        ms = max(0, round(seconds * 1000))
        hours, ms = divmod(ms, 3_600_000)
        minutes, ms = divmod(ms, 60_000)
        secs, ms = divmod(ms, 1000)
        return f"{hours:02}:{minutes:02}:{secs:02},{ms:03}"

    body = "\n\n".join(f"{i}\n{stamp(start)} --> {stamp(end)}\n{text}" for i, (start, end, text) in enumerate(entries, 1))
    target.write_text(body + ("\n" if body else ""), encoding="utf-8-sig")


def render_video(source: Path, work_dir: Path, output: Path, keep: list[dict[str, float]], segments: list[dict[str, Any]], ratio: str) -> None:
    dimensions = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
    width, height = dimensions.get(ratio, dimensions["16:9"])
    parts_dir = work_dir / "parts"
    parts_dir.mkdir(exist_ok=True)
    concat_file = work_dir / "concat.txt"
    list_lines: list[str] = []
    for index, span in enumerate(keep):
        part = parts_dir / f"part_{index:03d}.mp4"
        video_filter = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1"
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{span['start']:.3f}",
            "-i", str(source), "-t", f"{span['end'] - span['start']:.3f}", "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", video_filter, "-c:v", "libx264", "-preset", os.getenv("FFMPEG_PRESET", "veryfast"),
            "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
            "-ac", "2", "-movflags", "+faststart", str(part),
        ])
        list_lines.append(f"file '{part.as_posix().replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'")
    concat_file.write_text("\n".join(list_lines) + "\n", encoding="utf-8")
    joined = work_dir / "joined.mp4"
    # Re-encode the join to avoid timestamp discontinuities between separately rendered cuts.
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(joined)])
    srt = work_dir / "captions.srt"
    make_srt(segments, keep, srt)
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(joined), "-i", str(srt),
        "-map", "0:v:0", "-map", "0:a:0?", "-map", "1:0", "-c:v", "copy", "-c:a", "copy",
        "-c:s", "mov_text", "-metadata:s:s:0", "language=kor", "-metadata:s:s:0", "title=한국어 자막",
        "-movflags", "+faststart", str(output),
    ])


def process_job(job_id: str, video: Path, prompt: str, style: str, ratio: str) -> None:
    work_dir = DATA_DIR / "work" / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        # Load local secrets at request time as well, so a local .env can be filled
        # after the API server is started without restarting the process.
        load_app_env()
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY가 설정되지 않았습니다. backend/.env.example을 복사해 .env를 만들고 OpenAI API 키를 입력한 뒤 서버를 다시 시작해 주세요.")
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise RuntimeError("FFmpeg/ffprobe를 찾을 수 없습니다. FFmpeg를 설치하고 PATH에 추가한 뒤 API 서버를 다시 시작해 주세요.")
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError("OpenAI Python SDK가 없습니다. backend 폴더에서 pip install -r requirements.txt를 실행해 주세요.") from exc

        client = OpenAI()
        update_job(job_id, status="processing", progress=5, step="영상 길이와 오디오 확인 중")
        duration = probe_duration(video)
        update_job(job_id, progress=12, step="영상에서 음성을 추출하는 중")
        transcript = transcribe_video(video, work_dir, client)
        update_job(job_id, progress=42, step="한국어 음성을 인식했어요 · AI가 편집 구간을 분석 중")
        keep = make_edit_plan(transcript, prompt, style, duration, client)
        update_job(job_id, progress=56, step=f"편집 구간 {len(keep)}개를 정리했어요 · 영상 렌더링 중")
        output = OUTPUT_DIR / f"{job_id}.mp4"
        render_video(video, work_dir, output, keep, transcript, ratio)
        update_job(job_id, status="completed", progress=100, step="편집과 한국어 자막 생성 완료", output_url=f"/jobs/{job_id}/download", duration=duration, output_name=output.name)
    except Exception as exc:  # Report actionable service errors to the UI; never return a fabricated result.
        update_job(job_id, status="failed", progress=0, step="편집을 완료하지 못했습니다", error=str(exc))


@app.get("/health")
def health() -> dict[str, Any]:
    load_app_env()
    return {"status": "ok", "ffmpeg": bool(shutil.which("ffmpeg")), "ffprobe": bool(shutil.which("ffprobe")), "openai_configured": bool(os.getenv("OPENAI_API_KEY"))}


@app.post("/jobs", status_code=202)
async def create_job(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    prompt: str = Form(...),
    style: str = Form("youtube"),
    ratio: str = Form("16:9"),
) -> dict[str, Any]:
    suffix = Path(file.filename or "video.mp4").suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=415, detail="지원하지 않는 영상 형식입니다. MP4, MOV, M4V, WEBM 파일을 사용해 주세요.")
    if not prompt.strip():
        raise HTTPException(status_code=422, detail="편집 요청을 입력해 주세요.")
    if len(prompt) > 1200:
        raise HTTPException(status_code=422, detail="편집 요청은 1,200자 이하로 입력해 주세요.")
    job_id = uuid.uuid4().hex
    target = UPLOAD_DIR / f"{job_id}{suffix}"
    size = 0
    try:
        with target.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail=f"파일이 업로드 용량 제한({MAX_UPLOAD_BYTES // (1024**3)}GB)을 초과했습니다.")
                destination.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    if not size:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="비어 있는 파일입니다.")
    job = {"id": job_id, "status": "queued", "progress": 1, "step": "영상 업로드 완료 · 작업 대기 중", "filename": Path(file.filename or target.name).name, "output_url": None}
    with JOBS_LOCK:
        JOBS[job_id] = job
    background_tasks.add_task(process_job, job_id, target, prompt.strip(), style, ratio if ratio in {"16:9", "9:16", "1:1"} else "16:9")
    return job


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다. API 서버를 재시작했다면 작업 상태가 초기화되었을 수 있습니다.")
        return dict(job)


@app.get("/jobs/{job_id}/download")
def download_job(job_id: str, download: bool = False):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job or job.get("status") != "completed":
        raise HTTPException(status_code=404, detail="완성된 영상이 없습니다.")
    path = OUTPUT_DIR / f"{job_id}.mp4"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")
    filename = re.sub(r"[^\w.-]+", "_", Path(job.get("filename", "edit-ai")).stem)[:70] or "edit-ai"
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"{filename}_EDIT_AI.mp4" if download else None,
        content_disposition_type="attachment" if download else "inline",
    )
