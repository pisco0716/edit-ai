"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";

type Job = { id: string; status: "queued" | "processing" | "completed" | "failed"; progress: number; step: string; error?: string; output_url?: string; title?: string; duration?: number };
type Project = { id: string; name: string; status: string; date: string; output?: string };
type ApiHealth = { ffmpeg: boolean; ffprobe: boolean; openai_configured: boolean };
const EMPTY_PROJECTS: Project[] = [];
let projectsCacheRaw: string | null = null;
let projectsCache: Project[] = EMPTY_PROJECTS;

function subscribeProjects(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener("edit-ai-projects-change", onChange);
  return () => { window.removeEventListener("storage", onChange); window.removeEventListener("edit-ai-projects-change", onChange); };
}
function getStoredProjects(): Project[] {
  const raw = localStorage.getItem("edit-ai-projects") || "[]";
  if (raw !== projectsCacheRaw) {
    projectsCacheRaw = raw;
    try { projectsCache = JSON.parse(raw); } catch { projectsCache = EMPTY_PROJECTS; }
  }
  return projectsCache;
}

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const styles = [
  { id: "youtube", label: "유튜브", sub: "몰입감 있는 롱폼", icon: "▶" },
  { id: "shorts", label: "쇼츠", sub: "빠르고 임팩트 있게", icon: "▯" },
  { id: "vlog", label: "브이로그", sub: "자연스럽고 감성 있게", icon: "◉" },
  { id: "cinema", label: "시네마틱", sub: "영화 같은 무드", icon: "▰" },
  { id: "variety", label: "예능", sub: "리듬감 있는 편집", icon: "✦" },
  { id: "ad", label: "광고", sub: "메시지를 선명하게", icon: "↗" },
];

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<string, React.ReactNode> = {
    spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z"/></>,
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1V10Z"/></>,
    folder: <><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.7-1.4-2.4 1.4-1.1A8 8 0 0 1 7 13.2l-1.8-.3v-2.8l1.8-.3a8 8 0 0 1 .7-1.7L6.6 6.7 8 4.3l1.7.7a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1 .7 1.7l1.8.3v2.8l-1.8.3a8 8 0 0 1-.7 1.7Z"/></>,
    help: <><circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 0 1 4.8.8c0 1.7-2.4 2-2.4 3.7M12 17h.01"/></>,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></>,
    download: <><path d="M12 4v12m0 0 5-5m-5 5-5-5"/><path d="M4 19h16"/></>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    video: <><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/></>,
  };
  return <svg {...common}>{paths[name] || paths.spark}</svg>;
}

function formatTime(s: number) { if (!Number.isFinite(s)) return "00:00"; return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`; }

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("youtube");
  const [ratio, setRatio] = useState("16:9");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const projects = useSyncExternalStore(subscribeProjects, getStoredProjects, () => EMPTY_PROJECTS);
  const [activeNav, setActiveNav] = useState("새 프로젝트");
  const [toast, setToast] = useState("");
  const [duration, setDuration] = useState(0);
  const [apiStatus, setApiStatus] = useState<"checking" | "ready" | "setup" | "offline">("checking");

  useEffect(() => { if (previewUrl) return () => URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(""), 3200); return () => window.clearTimeout(t); }, [toast]);
  useEffect(() => {
    let active = true;
    fetch(`${API}/health`).then(r => { if (!r.ok) throw new Error("API unavailable"); return r.json() as Promise<ApiHealth>; }).then(health => {
      if (active) setApiStatus(health.ffmpeg && health.ffprobe && health.openai_configured ? "ready" : "setup");
    }).catch(() => { if (active) setApiStatus("offline"); });
    return () => { active = false; };
  }, []);

  function chooseFile(f?: File) {
    if (!f) return;
    if (!f.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm)$/i.test(f.name)) { setError("MP4, MOV, M4V, WEBM 형식의 영상 파일을 선택해 주세요."); return; }
    setError(""); setJob(null); setFile(f); setDuration(0);
    setPreviewUrl(URL.createObjectURL(f));
  }
  function onDrop(e: DragEvent<HTMLDivElement>) { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }
  function onChange(e: ChangeEvent<HTMLInputElement>) { chooseFile(e.target.files?.[0]); e.target.value = ""; }

  async function startEdit() {
    if (!file) { setError("먼저 편집할 영상을 업로드해 주세요."); return; }
    if (!prompt.trim()) { setError("원하는 편집 내용을 한 줄 이상 입력해 주세요."); return; }
    setBusy(true); setError(""); setJob({ id: "", status: "queued", progress: 0, step: "영상 업로드 중" });
    try {
      const healthResponse = await fetch(`${API}/health`);
      if (!healthResponse.ok) throw new Error("편집 서버 상태를 확인할 수 없습니다. FastAPI 서버를 확인해 주세요.");
      const health = await healthResponse.json() as ApiHealth;
      setApiStatus(health.ffmpeg && health.ffprobe && health.openai_configured ? "ready" : "setup");
      if (!health.ffmpeg || !health.ffprobe) throw new Error("편집 서버에서 FFmpeg/ffprobe를 찾을 수 없습니다. 설치 상태와 PATH를 확인해 주세요.");
      if (!health.openai_configured) throw new Error("OpenAI API 키가 설정되지 않았습니다. backend/.env 파일의 OPENAI_API_KEY= 뒤에 키를 입력한 다음 다시 시도해 주세요. API 키 발급: https://platform.openai.com/api-keys");
      const form = new FormData(); form.append("file", file); form.append("prompt", prompt); form.append("style", style); form.append("ratio", ratio);
      const res = await fetch(`${API}/jobs`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "작업을 시작하지 못했습니다.");
      setJob(data);
      const id = data.id;
      const poll = async () => {
        try {
          const result = await fetch(`${API}/jobs/${id}`).then(r => r.json());
          setJob(result);
          if (result.status === "completed") {
            const next = [{ id, name: file.name.replace(/\.[^.]+$/, ""), status: "완성", date: new Date().toLocaleDateString("ko-KR"), output: `${API}${result.output_url}` }, ...getStoredProjects().filter(p => p.id !== id)].slice(0, 12);
            localStorage.setItem("edit-ai-projects", JSON.stringify(next)); window.dispatchEvent(new Event("edit-ai-projects-change")); setBusy(false); setToast("편집이 완료됐어요. 결과를 확인해 보세요."); return;
          }
          if (result.status === "failed") { setError(result.error || "편집 작업에 실패했습니다."); setBusy(false); return; }
          window.setTimeout(poll, 1800);
        } catch { setError("편집 서버와 연결이 끊겼습니다. 서버 상태를 확인해 주세요."); setBusy(false); }
      };
      window.setTimeout(poll, 900);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message.includes("Failed to fetch") || message.includes("fetch")) setApiStatus("offline");
      setError(message && message !== "Failed to fetch" ? message : `편집 서버에 연결할 수 없습니다. ${API}에서 FastAPI 서버가 실행 중인지 확인해 주세요. 설정 방법은 프로젝트 README의 ‘Run locally’를 참고하세요.`);
      setJob(null); setBusy(false);
    }
  }

  function clearCurrent() { setFile(null); setPreviewUrl(""); setJob(null); setError(""); setDuration(0); }
  function openProject(p: Project) { setActiveNav("내 프로젝트"); if (p.output) { setToast(`${p.name} 프로젝트 · 다운로드 링크를 열었어요.`); window.open(p.output, "_blank", "noopener,noreferrer"); } }
  const completed = job?.status === "completed" && job.output_url;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="EDIT AI 홈"><span className="brand-mark"><Icon name="spark" size={19} /></span><span>EDIT<span className="brand-ai">AI</span></span><span className="brand-beta">STUDIO</span></a>
        <div className="workspace-switch"><div className="workspace-avatar">S</div><div className="workspace-copy"><b>Studio workspace</b><span>Free plan</span></div><span className="chevrons">⌃<br/>⌄</span></div>
        <div className="side-label">WORKSPACE</div>
        <nav className="nav-list">
          {[{ label: "새 프로젝트", icon: "spark" }, { label: "대시보드", icon: "home" }, { label: "내 프로젝트", icon: "folder", count: projects.length ? String(projects.length).padStart(2, "0") : undefined }].map(item => <button key={item.label} className={`nav-item ${activeNav === item.label ? "selected" : ""}`} onClick={() => setActiveNav(item.label)}><Icon name={item.icon} /><span>{item.label}</span>{item.count && <small>{item.count}</small>}</button>)}
        </nav>
        {projects.length > 0 && <><div className="side-label recent-label">최근 프로젝트</div><div className="recent-projects">{projects.slice(0, 3).map(p => <button key={p.id} onClick={() => openProject(p)}><span className="recent-dot" />{p.name}</button>)}</div></>}
        <div className="sidebar-spacer" />
        <div className="plan-card"><div className="plan-orb"><Icon name="spark" size={16}/></div><b>더 큰 프로젝트를<br/>만들어 보세요</b><span>Pro로 업그레이드하고<br/>더 길게, 더 선명하게.</span><button onClick={() => setToast("Pro 플랜은 서비스 출시와 함께 제공될 예정이에요.")}>플랜 둘러보기 <span>↗</span></button></div>
        <button className="nav-item bottom-nav" onClick={() => setToast("설정은 API 연결 후 이용할 수 있어요.")}><Icon name="settings"/><span>설정</span></button>
        <div className="profile"><div className="profile-avatar">J</div><div><b>Jiyoon Park</b><span>무료 플랜</span></div><button aria-label="프로필 메뉴">···</button></div>
      </aside>

      <main className="main-area" id="top">
        <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><i>/</i><b>{activeNav}</b></div><div className="top-actions"><span className={`api-status api-${apiStatus}`}><i/>{apiStatus === "checking" ? "서버 확인 중" : apiStatus === "ready" ? "AI 연결됨" : apiStatus === "setup" ? "API 키 설정 필요" : "서버 연결 안 됨"}</span><button className="icon-button help-button" onClick={() => setToast("영상은 브라우저에서 편집 서버로 전송됩니다. 키 설정과 실행 방법은 README를 확인해 주세요.")} aria-label="도움말"><Icon name="help"/></button><span className="top-divider"/><button className="avatar-small" aria-label="내 계정">J</button></div></header>
        <div className="content-wrap">
          <section className="intro-row"><div><div className="eyebrow"><span className="eyebrow-line"/> AI VIDEO STUDIO <span className="eyebrow-live"><i/> BETA</span></div><h1>영상 편집, 이제<br className="mobile-break"/> <span>말로 완성하세요.</span></h1><p>아이디어만 적어주세요. EDIT AI가 편집부터 자막까지 알아서 만들어요.</p></div><button className="shortcut-button" onClick={() => inputRef.current?.click()}><span>⌘</span> 새 영상 업로드</button></section>

          <div className="editor-grid">
            <section className="panel upload-panel">
              <div className="panel-heading"><div className="heading-left"><span className="step-number">01</span><div><h2>영상 업로드</h2><p>편집할 원본 영상을 선택해 주세요.</p></div></div><span className="required-chip">필수</span></div>
              {!file ? <div className={`dropzone ${dragging ? "is-dragging" : ""}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={e => e.key === "Enter" && inputRef.current?.click()}><input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mov,.mp4,.m4v,.webm" hidden onChange={onChange}/><div className="upload-illustration"><div className="upload-ring"><Icon name="upload" size={22}/></div><span className="upload-spark">✦</span></div><b>영상을 여기에 드롭하세요</b><span className="drop-copy">또는 <em>파일 찾아보기</em></span><div className="format-row"><span>MP4</span><span>MOV</span><span>WEBM</span><i/> 최대 2GB</div></div> : <div className="file-card"><div className="video-preview">{previewUrl && <video src={previewUrl} controls playsInline onLoadedMetadata={e => setDuration(e.currentTarget.duration)} />}{!previewUrl && <div className="preview-placeholder"><Icon name="video" size={28}/></div>}<span className="preview-badge">원본 영상</span></div><div className="file-meta"><div className="file-type-icon"><Icon name="video" size={19}/></div><div className="file-info"><b title={file.name}>{file.name}</b><span>{(file.size / (1024 * 1024)).toFixed(1)} MB <i/> {duration ? formatTime(duration) : "영상"}</span></div><button className="remove-file" onClick={clearCurrent} aria-label="영상 제거"><Icon name="close" size={16}/></button></div><button className="replace-button" onClick={() => inputRef.current?.click()}>다른 영상 선택</button><input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mov,.mp4,.m4v,.webm" hidden onChange={onChange}/></div>}
              <div className="privacy-note"><span className="lock-icon">⌑</span> 업로드한 영상은 편집 작업에만 사용됩니다.</div>
            </section>

            <section className="panel request-panel">
              <div className="panel-heading"><div className="heading-left"><span className="step-number">02</span><div><h2>AI 편집 요청</h2><p>원하는 결과를 편하게 설명해 주세요.</p></div></div><span className="ai-chip"><Icon name="spark" size={13}/> AI POWERED</span></div>
              <div className="prompt-box"><label htmlFor="edit-prompt">어떤 영상으로 만들까요?</label><textarea id="edit-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="예) 말이 끊기거나 조용한 부분은 잘라내고, 제품을 보여주는 장면을 강조해 주세요. 핵심 내용으로 1분 이내의 유튜브 영상으로 만들어 주세요." maxLength={1200}/><div className="prompt-footer"><div className="prompt-hint"><Icon name="spark" size={13}/> 구체적으로 적을수록 더 잘 편집해요</div><span>{prompt.length}<i>/ 1,200</i></span></div></div>
              <div className="style-section"><div className="mini-section-heading"><b>편집 스타일</b><span>하나를 선택해 주세요</span></div><div className="style-grid">{styles.map(s => <button key={s.id} onClick={() => setStyle(s.id)} className={`style-option ${style === s.id ? "active" : ""}`}><span className="style-icon">{s.icon}</span><span className="style-text"><b>{s.label}</b><small>{s.sub}</small></span>{style === s.id && <span className="selected-check">✓</span>}</button>)}</div></div>
              <div className="output-options"><div className="mini-section-heading"><b>화면 비율</b><span>플랫폼에 맞게 선택</span></div><div className="ratio-options">{[{v:"16:9",t:"가로",ico:"▭"},{v:"9:16",t:"세로",ico:"▯"},{v:"1:1",t:"정사각",ico:"□"}].map(r => <button key={r.v} className={ratio === r.v ? "active" : ""} onClick={() => setRatio(r.v)}><span>{r.ico}</span>{r.t}<small>{r.v}</small></button>)}</div></div>
              <button className="create-button" disabled={busy} onClick={startEdit}><span className="button-spark"><Icon name="spark" size={17}/></span>{busy ? "AI가 영상을 편집하고 있어요" : "AI 편집 시작하기"}<span className="button-arrow">{busy ? <span className="spinner"/> : "→"}</span></button>
              <div className="button-footnote"><span>✦</span> AI가 분석하고 직접 편집합니다 <i/> 보통 영상 길이에 따라 수 분 소요</div>
            </section>
          </div>

          {error && <div className="error-banner"><span>!</span><div><b>작업을 진행할 수 없어요</b><p>{error}</p></div><button onClick={() => setError("")} aria-label="오류 닫기"><Icon name="close" size={16}/></button></div>}

          {job && <section className={`job-panel ${completed ? "job-complete" : ""}`}><div className="job-top"><div className="job-icon"><Icon name={completed ? "video" : "spark"}/></div><div className="job-copy"><b>{completed ? "편집이 완료됐어요" : "AI가 영상을 만들고 있어요"}</b><span>{job.step || "작업 준비 중"}</span></div><span className="job-percent">{completed ? "완료" : `${job.progress || 0}%`}</span></div>{!completed && <div className="progress-track"><span style={{ width: `${job.progress || 4}%` }}/></div>}{completed && <div className="result-box"><video src={`${API}${job.output_url}`} controls playsInline /><div className="result-details"><div><b>완성된 영상</b><span>MP4 · {ratio} · 자막 포함</span></div><a className="download-button" href={`${API}${job.output_url}?download=1`}><Icon name="download" size={16}/> 다운로드</a></div><p className="subtitle-note">자막은 MP4 안에 선택형 자막 트랙으로 포함되어 있습니다.</p></div>}</section>}

          <section className="bottom-info"><div className="info-title"><div><span className="eyebrow-line"/> HOW IT WORKS</div><b>복잡한 편집은 AI에게 맡기세요.</b></div><div className="how-steps"><div className="how-step"><span className="how-num">01</span><b>영상 업로드</b><small>편집할 원본 파일을<br/>안전하게 업로드해요.</small></div><span className="step-connector"/><div className="how-step"><span className="how-num">02</span><b>원하는 편집 설명</b><small>자연어로 원하는 편집을<br/>자유롭게 요청해요.</small></div><span className="step-connector"/><div className="how-step"><span className="how-num">03</span><b>완성본 다운로드</b><small>AI가 편집한 영상을<br/>바로 다운로드해요.</small></div></div></section>
          <footer><span>© 2026 EDIT AI STUDIO</span><span>Made for stories that matter <i>✦</i></span><button onClick={() => setToast("서비스 문의: hello@editai.studio")}>도움이 필요하신가요?</button></footer>
        </div>
      </main>
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
  );
}
