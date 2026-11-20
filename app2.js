"use strict";
// ── 작업 ──────────────────────────────────────────────────
const jobs = [];   // {id, mode, prompt, status, t0, el, result, error}
const STATUS_KO = { IN_QUEUE: "대기 중", IN_PROGRESS: "생성 중", COMPLETED: "완료", FAILED: "실패", CANCELLED: "취소됨", TIMED_OUT: "시간 초과" };
const MODE_KO = { i2v: "이미지→영상", v2v: "영상→영상", i2i: "이미지→이미지", t2v: "텍스트→영상" };

function stamp() { const d = new Date(); return d.toTimeString().slice(0, 8).replace(/:/g, ""); }

async function generate() {
  const M = MODES[mode];
  const prompt = $("#prompt").value.trim();
  if (!prompt) return toast("프롬프트를 적어 주세요.");
  for (const s of M.slots) if (s.req && !files[mode + ":" + s.id]) return toast(`'${s.label}'을(를) 넣어 주세요.`);
  if (M.slots.some((s) => files[mode + ":" + s.id] && files[mode + ":" + s.id].busy)) return toast("영상 변환이 끝날 때까지 잠깐만 기다려 주세요.");

  const seedV = $("#seed").value.trim();
  const opts = { prompt, fast: quality === "fast" };
  if (seedV) opts.seed = Math.abs(parseInt(seedV, 10)) || 0;
  if ($("#steps").value) opts.steps = +$("#steps").value;
  if ($("#cfg").value) opts.cfg = +$("#cfg").value;
  if (quality === "fast") opts.loraStrength = +$("#loraStrength").value;
  if (mode === "i2i" || mode === "v2v") opts.denoise = +$("#denoise").value;
  if (mode === "v2v") {
    opts.cannyLow = +$("#cannyLow").value; opts.cannyHigh = +$("#cannyHigh").value;
    const vf = files["v2v:video"]; if (vf && typeof vf.frames === "number") opts.maxFrames = vf.frames;
  }
  const images = [];
  const tag = stamp() + "_" + Math.random().toString(36).slice(2, 6);
  for (const s of M.slots) {
    const f = files[mode + ":" + s.id]; if (!f) continue;
    const name = f.kind === "video" ? `in_${tag}_${s.id}.${f.ext}` : `in_${tag}_${s.id}.jpg`;
    images.push({ name, image: f.dataUrl });
    opts[s.id] = name;
  }
  let workflow;
  if (M.video) Object.assign(opts, videoSize(), { seconds: +$("#seconds").value });
  if (mode === "i2v") workflow = i2v(opts);
  else if (mode === "v2v") workflow = v2v(opts);
  else if (mode === "i2i") workflow = i2i(opts);
  else workflow = t2v(opts);

  const payload = { input: { workflow, images } };
  const size = new Blob([JSON.stringify(payload)]).size;
  if (size > MAX_REQ) return toast(`보낼 데이터가 ${(size / 1048576).toFixed(1)}MB예요. 10MB를 넘으면 RunPod가 받지 않아요. 영상이나 이미지를 줄여 주세요.`);

  const btn = $("#goBtn"); btn.disabled = true; btn.textContent = "보내는 중…";
  try {
    const r = await rp("run", payload);
    const pt = [quality === "fast" ? "빠르게" : "고품질"];
    if (opts.denoise !== undefined && opts.denoise !== 1) pt.push("디노이즈 " + opts.denoise.toFixed(2));
    if (opts.loraStrength !== undefined && opts.loraStrength !== 1) pt.push("LoRA " + opts.loraStrength.toFixed(2));
    if (opts.steps) pt.push("스텝 " + opts.steps);
    if (opts.cfg !== undefined) pt.push("CFG " + opts.cfg);
    if (opts.seed !== undefined && seedV) pt.push("시드 " + opts.seed);
    addJob({ id: r.id, mode, prompt, params: pt.join(" · "), status: r.status || "IN_QUEUE", t0: Date.now() });
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "생성하기"; }
}

function persistJobs() {
  save({ pending: jobs.filter((j) => !["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(j.status) || (j.status === "COMPLETED" && !j.result))
    .map(({ id, mode, prompt, params, t0 }) => ({ id, mode, prompt, params, t0 })) });
}

function addJob(j) {
  jobs.unshift(j);
  $("#noJobs").style.display = "none";
  j.el = document.createElement("div");
  j.el.className = "card job";
  $("#jobs").insertBefore(j.el, $("#noJobs").nextSibling);
  persistJobs(); renderJob(j); poll(j);
}

function fmt(ms) { const s = Math.floor(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`; }

function renderJob(j) {
  const st = j.status;
  const cls = st === "COMPLETED" ? "done" : ["FAILED", "CANCELLED", "TIMED_OUT"].includes(st) ? "fail" : "run";
  const busy = cls === "run";
  let waitMsg = "";
  if (st === "IN_QUEUE") waitMsg = Date.now() - j.t0 > 20000 ? "GPU를 켜고 모델을 불러오는 중이에요. 처음이거나 한동안 안 썼다면 몇 분 걸릴 수 있어요." : "GPU 배정 대기 중…";
  if (st === "IN_PROGRESS") waitMsg = "생성 중이에요. 이 창을 닫아도 30분 안에 다시 열면 결과를 받아올 수 있어요.";
  let html = `<div class="top"><span class="badge ${cls}">${STATUS_KO[st] || st}</span><b>${MODE_KO[j.mode]}</b>
    <span class="hint" style="margin:0">${fmt((j.t1 || Date.now()) - j.t0)}</span><div class="spacer"></div>
    ${busy ? `<button class="cancel" style="font-size:13px;padding:5px 10px">취소</button>` : ""}</div>`;
  if (busy) html += `<div class="bar"><i></i></div><div class="hint" style="margin:0">${waitMsg}</div>`;
  if (j.result) {
    for (const r of j.result) {
      html += r.isVideo ? `<video class="media" src="${r.url}" controls loop playsinline autoplay muted></video>` : `<img class="media" src="${r.url}" alt="결과">`;
    }
    html += `<div class="acts">` + j.result.map((r, i) => `<a href="${r.url}" download="${r.name}">⬇️ 저장${j.result.length > 1 ? " " + (i + 1) : ""}</a>`).join("") +
      (j.result.some((r) => !r.isVideo) ? `<button class="toI2V">🎬 이 이미지로 영상 만들기</button><button class="toV2V">🎞️ V2V 시작 이미지로</button>` : "") + `</div>`;
  }
  if (j.error) html += `<div class="err">${esc(j.error)}</div>`;
  html += `<div class="prompt">${esc(j.prompt)}${j.params ? `<br><span style="opacity:.75">${esc(j.params)}</span>` : ""}</div>`;
  j.el.innerHTML = html;
  const c = j.el.querySelector(".cancel");
  if (c) c.onclick = async () => { try { await rp("cancel/" + j.id, {}); } catch (e) { toast(e.message); } };
  const img = j.result && j.result.find((r) => !r.isVideo);
  if (img) {
    j.el.querySelector(".toI2V").onclick = () => useImage(img, "i2v");
    j.el.querySelector(".toV2V").onclick = () => useImage(img, "v2v");
  }
}

async function useImage(r, target) {
  const blob = await (await fetch(r.url)).blob();
  const out = await imageToJpeg(blob, 1536);
  files[target + ":image"] = { kind: "image", ...out };
  setMode(target); window.scrollTo({ top: 0, behavior: "smooth" });
  toast("결과 이미지를 넣었어요. 프롬프트를 적고 생성하세요.");
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function b64ToUrl(b64, mime) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([u], { type: mime }));
}
const MIME = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

async function poll(j) {
  let fails = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, j.status === "IN_QUEUE" ? 4000 : 3000));
    try {
      const s = await rp("status/" + j.id);
      fails = 0;
      j.status = s.status;
      if (s.status === "COMPLETED") {
        j.t1 = Date.now();
        const out = s.output || {};
        const imgs = out.images || [];
        j.result = imgs.map((it) => {
          const ext = (it.filename || "").split(".").pop().toLowerCase();
          const mime = MIME[ext] || "application/octet-stream";
          const url = it.type === "s3_url" ? it.data : b64ToUrl(it.data, mime);
          return { url, name: `wan_${j.mode}_${it.filename || "out." + ext}`, isVideo: mime.startsWith("video/") };
        });
        if (!j.result.length) j.error = "결과 파일이 없어요." + (out.errors ? "\n" + out.errors.join("\n") : "") + (out.error ? "\n" + out.error : "");
        else if (out.errors && out.errors.length) j.error = "참고: " + out.errors.join("\n");
        persistJobs(); renderJob(j); return;
      }
      if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(s.status)) {
        j.t1 = Date.now();
        j.error = explainError(s.error || (s.output && (s.output.error || JSON.stringify(s.output))) || "");
        persistJobs(); renderJob(j); return;
      }
    } catch (e) {
      if (/404|찾을 수 없/.test(e.message) && Date.now() - j.t0 > 60000) { j.status = "FAILED"; j.error = "작업 결과가 만료됐어요 (완료 후 30분이 지나면 지워져요)."; persistJobs(); renderJob(j); return; }
      if (++fails > 20) { j.error = e.message; renderJob(j); return; }
    }
    renderJob(j);
  }
}

function explainError(raw) {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (/out of memory|OutOfMemory|CUDA out of memory/i.test(s)) return "GPU 메모리가 부족해요. 해상도나 길이를 줄이거나, 엔드포인트 GPU를 48GB 이상으로 바꿔 주세요.\n\n" + s.slice(0, 600);
  if (/value_not_in_list|not in list|ckpt_name|unet_name|lora_name|clip_name|vae_name/i.test(s)) return "모델 파일을 찾지 못했어요. Network Volume에 모델을 받았는지, 엔드포인트에 Volume을 연결했는지 확인해 주세요.\n\n" + s.slice(0, 600);
  return s.slice(0, 1200) || "알 수 없는 오류";
}

// ── 토스트 ───────────────────────────────────────────────
let toastT;
function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:92vw;background:#2a2f3a;border:1px solid #3a4150;color:#fff;padding:10px 16px;border-radius:12px;z-index:50;font-size:14px;box-shadow:0 8px 30px rgba(0,0,0,.4)"; document.body.appendChild(t); }
  t.textContent = msg; t.style.display = "block";
  clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = "none"), 5000);
}

// ── 이벤트 ───────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setMode(t.dataset.mode)));
document.querySelectorAll("#quality button").forEach((b) => (b.onclick = () => {
  quality = b.dataset.v; document.querySelectorAll("#quality button").forEach((x) => x.classList.toggle("on", x === b)); updateSize(); updateAdv();
}));
$("#seconds").oninput = () => { $("#secText").textContent = $("#seconds").value; updateSize(); };
$("#aspect").onchange = updateSize;
$("#vStart").onchange = () => { const f = files["v2v:video"]; if (f && f.src && !f.busy) takeFile(MODES.v2v.slots[0], f.src); }; $("#res").onchange = updateSize;
$("#goBtn").onclick = generate;

const dlg = $("#settings");
$("#openSettings").onclick = () => {
  $("#apiKey").value = cfg.apiKey || ""; $("#endpointId").value = cfg.endpointId || ""; $("#apiBase").value = cfg.apiBase || "";
  $("#testMsg").textContent = ""; dlg.showModal();
};
function readSettings() { cfg = { ...cfg, apiKey: $("#apiKey").value.trim(), endpointId: $("#endpointId").value.trim(), apiBase: $("#apiBase").value.trim() }; }
$("#testConn").onclick = async () => { readSettings(); $("#testMsg").textContent = "확인 중…"; await checkConn($("#testMsg")); };
$("#saveSettings").onclick = () => { readSettings(); save({ apiKey: cfg.apiKey, endpointId: cfg.endpointId, apiBase: cfg.apiBase }); dlg.close(); checkConn(); };

// ── 고급 설정 ────────────────────────────────────────────
const DEN_HINT = {
  i2i: "1.0 = 지시대로 크게 바꿈. 낮출수록 원본 사진을 더 많이 남겨요 (0.5~0.7: 색감·분위기만 살짝 바꾸기).",
  v2v: "1.0 = 시작 이미지 스타일로 새로 그림. 낮추면 원본 영상의 색·질감을 남겨요 (0.6~0.8 추천). '빠르게'에서는 0.25 단위로 적용돼요.",
};
function updateAdv() {
  const fast = quality === "fast";
  const hasDen = mode === "i2i" || mode === "v2v";
  document.querySelectorAll(".denoiseOnly").forEach((e) => (e.style.display = hasDen ? "" : "none"));
  document.querySelectorAll(".fastOnly").forEach((e) => (e.style.display = fast ? "" : "none"));
  document.querySelectorAll(".v2vOnly").forEach((e) => (e.style.display = mode === "v2v" ? "" : "none"));
  $("#denoiseHint").textContent = DEN_HINT[mode] || "";
  const d = mode === "i2i" ? DEFAULTS.qwen : DEFAULTS.wan;
  const dd = fast ? d.fast : d.hq;
  $("#steps").placeholder = `기본 ${dd.steps}`;
  $("#cfg").placeholder = `기본 ${dd.cfg}`;
  $("#denoiseText").textContent = (+$("#denoise").value).toFixed(2);
  $("#loraText").textContent = (+$("#loraStrength").value).toFixed(2);
  const changed = +$("#denoise").value !== 1 || (fast && +$("#loraStrength").value !== 1) || $("#steps").value || $("#cfg").value || $("#seed").value;
  $("#adv").querySelector("summary").textContent = "고급 설정 (디노이즈 · 강도 · 스텝 · CFG · 시드)" + (changed ? " • 변경됨" : "");
}
["denoise", "loraStrength", "steps", "cfg", "seed"].forEach((id) => ($("#" + id).oninput = updateAdv));
$("#resetAdv").onclick = () => {
  $("#denoise").value = 1; $("#loraStrength").value = 1; $("#steps").value = ""; $("#cfg").value = ""; $("#seed").value = "";
  $("#cannyLow").value = 0.1; $("#cannyHigh").value = 0.6; updateAdv();
};

// 시작
setMode("i2v");
if (cfg.apiKey && cfg.endpointId) {
  checkConn();
  for (const p of (cfg.pending || []).reverse()) if (Date.now() - p.t0 < 35 * 60000) addJob({ ...p, status: "IN_QUEUE" });
} else {
  setTimeout(() => $("#openSettings").click(), 300);
}
setInterval(() => jobs.forEach((j) => ["IN_QUEUE", "IN_PROGRESS"].includes(j.status) && renderJob(j)), 1000);
