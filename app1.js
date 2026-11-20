"use strict";
const $ = (s) => document.querySelector(s);
const STORE = "wanstudio.v1";
const DEFAULT_BASE = "https://api.runpod.ai/v2";
const MAX_REQ = 9.5 * 1024 * 1024;   // /run 요청 최대 10MB

function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
function save(o) { try { localStorage.setItem(STORE, JSON.stringify({ ...load(), ...o })); } catch {} }
let cfg = load();

// ── 모드 정의 ─────────────────────────────────────────────
const MODES = {
  i2v: { slots: [{ id: "image", label: "움직일 사진", kind: "image", req: true }],
         promptLbl: "어떻게 움직일지", ph: "The woman slowly turns her head and smiles, hair blowing in the wind, camera slowly zooms in",
         hint: "사진 한 장을 넣고, 어떻게 움직일지 적어 주세요.", video: true },
  v2v: { slots: [{ id: "video", label: "원본 영상 (움직임 기준)", kind: "video", req: true },
                 { id: "image", label: "시작 이미지 (겉모습 기준)", kind: "image", req: true }],
         promptLbl: "결과 장면 설명", ph: "An anime girl dancing in a sunny park, Studio Ghibli style",
         hint: "원본 영상의 움직임은 그대로, 겉모습은 시작 이미지처럼 바뀌어요. 시작 이미지는 원본 첫 장면과 구도가 비슷할수록 좋아요 (첫 장면을 I2I로 바꿔서 쓰면 편해요). 영상은 크기 상관없이 넣으면 돼요. 필요한 5초만 16fps로 잘라서 작게 줄여 보내요.", video: true },
  i2i: { slots: [{ id: "image", label: "고칠 사진", kind: "image", req: true },
                 { id: "image2", label: "참고 이미지 (선택)", kind: "image" },
                 { id: "image3", label: "참고 이미지 2 (선택)", kind: "image" }],
         promptLbl: "어떻게 고칠지", ph: "Change the background to a snowy mountain at sunset",
         hint: "말로 사진을 고쳐요. 참고 이미지를 넣으면 'image 2의 옷을 입혀줘'처럼 쓸 수 있어요.", video: false },
  t2v: { slots: [], promptLbl: "장면 설명", ph: "A red fox running through a snowy forest at dawn, cinematic, slow motion",
         hint: "글만으로 영상을 만들어요. (볼륨에 t2v 모델을 받아둬야 해요)", video: true },
};
let mode = "i2v";
const files = {};          // slot id -> {kind, dataUrl, name, w, h, size}
let quality = "fast";

function renderSlots() {
  const m = MODES[mode];
  const box = $("#slots"); box.innerHTML = "";
  box.style.display = m.slots.length ? "" : "none";
  for (const s of m.slots) {
    const d = document.createElement("div");
    d.className = "drop";
    const f = files[mode + ":" + s.id];
    if (f && f.busy) {
      d.innerHTML = `<div>⏳<br><b>${esc(f.busy)}</b></div>`;
      d.style.cursor = "default";
      box.appendChild(d);
      continue;
    }
    if (f && f.kind === "video") {
      d.innerHTML = `<video src="${f.dataUrl}" muted loop autoplay playsinline></video><button class="x" title="지우기">✕</button>` +
        `<button class="x ff" style="right:auto;left:6px" title="첫 장면을 I2I로 보내기">🖼️ 첫 장면 → I2I</button>` +
        `<span class="tag">${f.w}×${f.h} · ${f.frames}프레임(16fps) · ${(f.size / 1048576).toFixed(1)}MB${f.orig ? ` <s style="opacity:.6">${(f.orig / 1048576).toFixed(0)}MB</s>` : ""}</span>`;
      d.querySelector(".x").onclick = (e) => { e.stopPropagation(); delete files[mode + ":" + s.id]; renderSlots(); updateSize(); };
      d.querySelector(".ff").onclick = async (e) => {
        e.stopPropagation();
        const blob = await (await fetch(f.firstFrame)).blob();
        files["i2i:image"] = { kind: "image", ...(await imageToJpeg(blob, 1536)) };
        setMode("i2i"); toast("원본 첫 장면을 넣었어요. 어떻게 바꿀지 적고 생성한 뒤, 결과에서 'V2V 시작 이미지로'를 누르세요.");
      };
    } else if (f) {
      d.innerHTML = (f.kind === "video" ? `<video src="${f.dataUrl}" muted loop autoplay playsinline></video>` : `<img src="${f.dataUrl}" alt="">`) +
        `<button class="x" title="지우기">✕</button><span class="tag">${s.label}${f.w ? ` · ${f.w}×${f.h}` : ""}${f.size ? ` · ${(f.size / 1048576).toFixed(1)}MB` : ""}</span>`;
      d.querySelector(".x").onclick = (e) => { e.stopPropagation(); delete files[mode + ":" + s.id]; renderSlots(); updateSize(); };
    } else {
      d.innerHTML = `<div>${s.kind === "video" ? "🎞️" : "🖼️"}<br><b>${s.label}</b>${s.req ? "" : ""}<br>눌러서 선택 또는 끌어다 놓기</div>`;
    }
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = s.kind === "video" ? "video/*" : "image/*";
    inp.onchange = () => inp.files[0] && takeFile(s, inp.files[0]);
    d.appendChild(inp);
    d.onclick = () => inp.click();
    d.ondragover = (e) => { e.preventDefault(); d.classList.add("drag"); };
    d.ondragleave = () => d.classList.remove("drag");
    d.ondrop = (e) => { e.preventDefault(); d.classList.remove("drag"); const fl = e.dataTransfer.files[0]; fl && takeFile(s, fl); };
    box.appendChild(d);
  }
}

async function takeFile(slot, file) {
  try {
    if (slot.kind === "video") {
      if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name)) throw new Error("영상 파일을 골라 주세요.");
      const key = mode + ":" + slot.id;
      files[key] = { kind: "video", busy: "영상 준비 중…", src: file };
      renderSlots();
      try {
        files[key] = { kind: "video", src: file, ...(await prepareVideo(file, +$("#vStart").value || 0, (msg) => { files[key].busy = msg; renderSlots(); })) };
      } catch (e) { delete files[key]; renderSlots(); throw e; }
    } else {
      const img = await imageToJpeg(file, 1536);
      files[mode + ":" + slot.id] = { kind: "image", ...img };
    }
    renderSlots(); updateSize();
  } catch (e) { toast(e.message || String(e)); }
}

// ── 영상 변환: 필요한 부분만 잘라 16fps · 긴 변 832px · H.264 mp4 로 다시 만든다 ──
// Wan 은 최대 81프레임(16fps 5초)만 쓰므로, 수백 MB 영상도 보통 1~3MB 로 줄어든다.
const V_FPS = 16, V_MAX_FRAMES = 81, V_LONG = 832;
async function prepareVideo(file, startSec, progress) {
  if (!("VideoEncoder" in window) || typeof Mp4Muxer === "undefined") {
    if (file.size > 7 * 1048576) throw new Error("이 브라우저는 영상 자동 변환을 지원하지 않아요. 7MB 이하 영상을 넣거나, iOS·브라우저를 최신으로 업데이트해 주세요.");
    const dataUrl = await readAsDataURL(file);
    return { dataUrl, ext: (file.name.split(".").pop() || "mp4").toLowerCase(), size: file.size, w: "?", h: "?", frames: "?" };
  }
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  try {
    await new Promise((ok, no) => {
      v.onloadeddata = ok;
      v.onerror = () => no(new Error("이 영상은 브라우저에서 열 수 없는 형식이에요. mp4(H.264)로 바꿔서 넣어 주세요."));
    });
    try { await v.play(); v.pause(); } catch {}   // iOS Safari: 한 번 재생해야 프레임을 그릴 수 있음
    const dur = isFinite(v.duration) ? v.duration : 5;
    const start = Math.max(0, Math.min(startSec, dur - 0.2));
    const frames = Math.max(5, Math.min(V_MAX_FRAMES, Math.floor((dur - start) * V_FPS) + 1));
    const sc = Math.min(1, V_LONG / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(2, Math.round(v.videoWidth * sc / 2) * 2), h = Math.max(2, Math.round(v.videoHeight * sc / 2) * 2);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const g = cv.getContext("2d");

    let codec = null;
    for (const c of ["avc1.640028", "avc1.4d0028", "avc1.42001f"]) {
      try { if ((await VideoEncoder.isConfigSupported({ codec: c, width: w, height: h, bitrate: 3e6, framerate: V_FPS })).supported) { codec = c; break; } } catch {}
    }
    if (!codec) throw new Error("이 브라우저에서 H.264 인코딩을 할 수 없어요. iOS·브라우저를 최신으로 업데이트해 주세요.");

    const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: "avc", width: w, height: h, frameRate: V_FPS }, fastStart: "in-memory" });
    let encErr = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (encErr = e) });
    enc.configure({ codec, width: w, height: h, bitrate: 3e6, framerate: V_FPS, avc: { format: "avc" } });

    const seek = (t) => new Promise((ok) => { v.onseeked = () => ok(); v.currentTime = t; });
    let firstFrame = null;
    for (let i = 0; i < frames; i++) {
      await seek(Math.min(dur - 0.001, start + i / V_FPS + 0.001));
      g.drawImage(v, 0, 0, w, h);
      if (i === 0) firstFrame = cv.toDataURL("image/jpeg", 0.95);
      const fr = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / V_FPS), duration: Math.round(1e6 / V_FPS) });
      enc.encode(fr, { keyFrame: i % 32 === 0 }); fr.close();
      if (encErr) throw encErr;
      while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
      if (i % 4 === 0) progress && progress(`영상 변환 중… ${i + 1}/${frames}`);
    }
    await enc.flush(); enc.close();
    if (encErr) throw encErr;
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
    return { dataUrl: await readAsDataURL(blob), ext: "mp4", size: blob.size, orig: file.size, w, h, frames, start, firstFrame };
  } finally { URL.revokeObjectURL(url); v.removeAttribute("src"); }
}

function readAsDataURL(blob) {
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
}
async function imageToJpeg(blob, maxSide) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
  return { dataUrl: c.toDataURL("image/jpeg", 0.92), w, h, size: 0 };
}

// ── 해상도 계산 ───────────────────────────────────────────
function videoSize() {
  const px = $("#res").value === "720" ? 1280 * 720 : 832 * 480;
  let r = parseFloat($("#aspect").value);
  if (isNaN(r)) {
    const vf = mode === "v2v" && files["v2v:video"] && typeof files["v2v:video"].w === "number" ? files["v2v:video"] : null;
    const f = vf || files[mode + ":image"];
    r = f && f.w && f.h ? f.w / f.h : 1;
  }
  r = Math.min(2.4, Math.max(0.42, r));
  const r16 = (v) => Math.max(256, Math.round(v / 16) * 16);
  const h = Math.sqrt(px / r);
  return { width: r16(h * r), height: r16(h) };
}
function updateSize() {
  const m = MODES[mode];
  if (!m.video) { $("#sizeInfo").textContent = "결과는 입력 사진과 비슷한 크기(약 1MP)로 나와요."; return; }
  const { width, height } = videoSize();
  const sec = +$("#seconds").value;
  $("#sizeInfo").textContent = `출력: ${width}×${height}, ${sec}초 (${Math.round(sec * 16 / 4) * 4 + 1}프레임, 16fps) · ${quality === "fast" ? "4스텝 고속" : "20스텝 고품질 — 약 4~5배 오래 걸려요"}`;
}

function setMode(m) {
  mode = m;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.mode === m));
  const M = MODES[m];
  $("#promptLbl").textContent = M.promptLbl;
  $("#prompt").placeholder = M.ph;
  $("#modeHint").textContent = M.hint;
  document.querySelectorAll(".vidOnly").forEach((e) => (e.style.display = M.video ? "" : "none"));
  $("#v2vOpts").style.display = m === "v2v" ? "" : "none";
  updateAdv();
  const aspectSel = $("#aspect");
  aspectSel.options[0].disabled = !(m === "i2v" || m === "v2v");
  if (aspectSel.options[0].disabled && aspectSel.value === "auto") aspectSel.value = "1";
  renderSlots(); updateSize();
}

// ── RunPod API ───────────────────────────────────────────
function base() { return (cfg.apiBase || DEFAULT_BASE).replace(/\/+$/, ""); }
async function rp(path, body, method) {
  if (!cfg.apiKey || !cfg.endpointId) throw new Error("먼저 ⚙️ 설정에서 API Key와 Endpoint ID를 넣어 주세요.");
  let res;
  try {
    res = await fetch(`${base()}/${encodeURIComponent(cfg.endpointId.trim())}/${path}`, {
      method: method || (body ? "POST" : "GET"),
      headers: { Authorization: "Bearer " + cfg.apiKey.trim(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("RunPod 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요. (브라우저가 요청을 막은 경우일 수도 있어요)");
  }
  const txt = await res.text();
  let j; try { j = JSON.parse(txt); } catch { j = null; }
  if (res.status === 401 || res.status === 403) throw new Error("API Key가 맞지 않아요 (401). 설정을 확인해 주세요.");
  if (res.status === 404) throw new Error("Endpoint ID를 찾을 수 없어요 (404). 설정을 확인해 주세요.");
  if (res.status === 413) throw new Error("요청이 너무 커요. 이미지/영상 크기를 줄여 주세요.");
  if (!res.ok) throw new Error(`RunPod 오류 ${res.status}: ${(j && (j.error || j.message)) || txt.slice(0, 300)}`);
  return j;
}

async function checkConn(showIn) {
  const dot = $("#connDot"), txt = $("#connText");
  try {
    const h = await rp("health");
    const w = h.workers || {};
    const ready = (w.idle || 0) + (w.ready || 0), running = w.running || 0;
    dot.className = "dot ok";
    txt.textContent = ready + running > 0 ? `연결됨 · GPU ${ready + running}대 켜짐` : "연결됨 · GPU 대기(첫 요청 시 켜짐)";
    if (showIn) showIn.textContent = "✅ 연결 성공! " + txt.textContent;
    return true;
  } catch (e) {
    dot.className = "dot bad"; txt.textContent = "연결 안 됨";
    if (showIn) showIn.textContent = "❌ " + e.message;
    return false;
  }
}

