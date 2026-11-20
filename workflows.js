// Wan 2.2 / Qwen Image Edit ComfyUI API workflows (ComfyUI v0.34 core nodes only)
// 각 함수는 RunPod worker-comfyui 의 input.workflow 로 그대로 보낼 수 있는 API 형식 JSON을 만든다.

const NEG_WAN =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

const FPS = 16;
const lengthFrom = (sec) => Math.max(1, Math.round(sec * FPS / 4)) * 4 + 1; // 4n+1 프레임
const rndSeed = () => Math.floor(Math.random() * 2 ** 48);

const num = (v, d) => (v === undefined || v === null || v === "" || isNaN(+v) ? d : +v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 기본값 (빠르게 = Lightning LoRA 4스텝 / 고품질 = 20스텝)
const DEFAULTS = {
  wan: { fast: { steps: 4, cfg: 1 }, hq: { steps: 20, cfg: 3.5 } },
  qwen: { fast: { steps: 4, cfg: 1 }, hq: { steps: 40, cfg: 4 } },
};

// 두 단계(high noise → low noise) Wan 2.2 샘플러 공통 부분
// denoise < 1 이면 앞쪽 스텝을 건너뛰어 latentRef(원본을 인코딩한 latent)를 일부 유지한다.
// 건너뛴 구간이 high-noise 단계 전체를 덮으면 low-noise 모델만으로 노이즈를 넣고 시작한다.
function wanTwoStage(w, { high, low, loraHigh, loraLow, fast, shift, seed, posRef, negRef, latentRef, steps, cfg, loraStrength, denoise }) {
  const d = fast ? DEFAULTS.wan.fast : DEFAULTS.wan.hq;
  steps = Math.round(clamp(num(steps, d.steps), 1, 100));
  cfg = clamp(num(cfg, d.cfg), 0, 20);
  denoise = clamp(num(denoise, 1), 0.05, 1);
  const split = Math.max(1, Math.round(steps / 2));
  const start = Math.min(steps - 1, Math.round(steps * (1 - denoise)));
  w["10"] = { class_type: "UNETLoader", inputs: { unet_name: high, weight_dtype: "default" } };
  w["11"] = { class_type: "UNETLoader", inputs: { unet_name: low, weight_dtype: "default" } };
  let hi = ["10", 0], lo = ["11", 0];
  if (fast) {
    const s = clamp(num(loraStrength, 1), 0, 2);
    w["12"] = { class_type: "LoraLoaderModelOnly", inputs: { model: hi, lora_name: loraHigh, strength_model: s } };
    w["13"] = { class_type: "LoraLoaderModelOnly", inputs: { model: lo, lora_name: loraLow, strength_model: s } };
    hi = ["12", 0]; lo = ["13", 0];
  }
  w["15"] = { class_type: "ModelSamplingSD3", inputs: { model: lo, shift } };
  const common = { steps, cfg, sampler_name: "euler", scheduler: "simple", positive: posRef, negative: negRef };
  if (start < split) {
    w["14"] = { class_type: "ModelSamplingSD3", inputs: { model: hi, shift } };
    w["20"] = {
      class_type: "KSamplerAdvanced",
      inputs: { model: ["14", 0], add_noise: "enable", noise_seed: seed, ...common,
        latent_image: latentRef, start_at_step: start, end_at_step: split, return_with_leftover_noise: "enable" },
    };
    w["21"] = {
      class_type: "KSamplerAdvanced",
      inputs: { model: ["15", 0], add_noise: "disable", noise_seed: 0, ...common,
        latent_image: ["20", 0], start_at_step: split, end_at_step: 10000, return_with_leftover_noise: "disable" },
    };
  } else {
    w["21"] = {
      class_type: "KSamplerAdvanced",
      inputs: { model: ["15", 0], add_noise: "enable", noise_seed: seed, ...common,
        latent_image: latentRef, start_at_step: start, end_at_step: 10000, return_with_leftover_noise: "disable" },
    };
  }
}

function wanCommon(w, prompt) {
  w["1"] = { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" } };
  w["2"] = { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } };
  w["3"] = { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: prompt } };
  w["4"] = { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: NEG_WAN } };
}

function wanOutput(w, prefix) {
  w["30"] = { class_type: "VAEDecode", inputs: { samples: ["21", 0], vae: ["2", 0] } };
  w["31"] = { class_type: "CreateVideo", inputs: { images: ["30", 0], fps: FPS } };
  w["32"] = { class_type: "SaveVideo", inputs: { video: ["31", 0], filename_prefix: prefix, format: "mp4", codec: "h264" } };
}

// 이미지 → 영상
function i2v({ image, prompt, width = 640, height = 640, seconds = 5, fast = true, seed = rndSeed(), steps, cfg, loraStrength }) {
  const w = {};
  wanCommon(w, prompt);
  w["5"] = { class_type: "LoadImage", inputs: { image } };
  w["6"] = {
    class_type: "WanImageToVideo",
    inputs: { positive: ["3", 0], negative: ["4", 0], vae: ["2", 0], start_image: ["5", 0], width, height, length: lengthFrom(seconds), batch_size: 1 },
  };
  wanTwoStage(w, {
    high: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
    low: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
    loraHigh: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
    loraLow: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
    fast, shift: 5.0, seed, posRef: ["6", 0], negRef: ["6", 1], latentRef: ["6", 2], steps, cfg, loraStrength,
  });
  wanOutput(w, "video/i2v");
  return w;
}

// 텍스트 → 영상
function t2v({ prompt, width = 640, height = 640, seconds = 5, fast = true, seed = rndSeed(), steps, cfg, loraStrength }) {
  const w = {};
  wanCommon(w, prompt);
  w["6"] = { class_type: "EmptyHunyuanLatentVideo", inputs: { width, height, length: lengthFrom(seconds), batch_size: 1 } };
  wanTwoStage(w, {
    high: "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
    low: "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors",
    loraHigh: "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
    loraLow: "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors",
    fast, shift: 5.0, seed, posRef: ["3", 0], negRef: ["4", 0], latentRef: ["6", 0], steps, cfg, loraStrength,
  });
  wanOutput(w, "video/t2v");
  return w;
}

// 영상 → 영상 (원본 영상의 윤곽선 + 시작 이미지의 겉모습)
// denoise < 1 이면 원본 영상 자체를 latent 로 인코딩해서 시작점으로 쓴다 → 색·질감이 원본에 더 가까워진다.
// maxFrames: 원본 영상에 실제로 있는 프레임 수 (그보다 길게 만들 수 없다)
function v2v({ video, image, prompt, width = 640, height = 640, seconds = 5, fast = true, seed = rndSeed(),
  cannyLow = 0.1, cannyHigh = 0.6, denoise = 1, steps, cfg, loraStrength, maxFrames }) {
  const w = {};
  wanCommon(w, prompt);
  let length = lengthFrom(seconds);
  if (maxFrames) length = Math.min(length, Math.max(1, Math.floor((maxFrames - 1) / 4)) * 4 + 1);
  w["5"] = { class_type: "LoadImage", inputs: { image } };
  w["7"] = { class_type: "LoadVideo", inputs: { file: video } };
  w["8"] = { class_type: "GetVideoComponents", inputs: { video: ["7", 0] } };
  w["9"] = { class_type: "Canny", inputs: { image: ["8", 0], low_threshold: clamp(num(cannyLow, 0.1), 0.01, 0.99), high_threshold: clamp(num(cannyHigh, 0.6), 0.01, 0.99) } };
  w["6"] = {
    class_type: "Wan22FunControlToVideo",
    inputs: {
      positive: ["3", 0], negative: ["4", 0], vae: ["2", 0], ref_image: ["5", 0], control_video: ["9", 0],
      width, height, length, batch_size: 1,
    },
  };
  let latentRef = ["6", 2];
  denoise = clamp(num(denoise, 1), 0.05, 1);
  if (denoise < 1) {
    w["16"] = { class_type: "ImageFromBatch", inputs: { image: ["8", 0], batch_index: 0, length } };
    w["17"] = { class_type: "ImageScale", inputs: { image: ["16", 0], upscale_method: "lanczos", width, height, crop: "center" } };
    w["18"] = { class_type: "VAEEncode", inputs: { pixels: ["17", 0], vae: ["2", 0] } };
    latentRef = ["18", 0];
  }
  wanTwoStage(w, {
    high: "wan2.2_fun_control_high_noise_14B_fp8_scaled.safetensors",
    low: "wan2.2_fun_control_low_noise_14B_fp8_scaled.safetensors",
    loraHigh: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
    loraLow: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
    fast, shift: 8.0, seed, posRef: ["6", 0], negRef: ["6", 1], latentRef, steps, cfg, loraStrength, denoise,
  });
  wanOutput(w, "video/v2v");
  return w;
}

// 이미지 → 이미지 (Qwen Image Edit 2511, 참고 이미지 최대 2장 추가)
// denoise: 1 = 지시대로 크게 바꿈, 낮출수록 원본 사진을 더 많이 유지
function i2i({ image, image2 = null, image3 = null, prompt, fast = true, seed = rndSeed(), denoise = 1, steps, cfg, loraStrength }) {
  const d = fast ? DEFAULTS.qwen.fast : DEFAULTS.qwen.hq;
  const w = {};
  w["1"] = { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", device: "default" } };
  w["2"] = { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } };
  w["5"] = { class_type: "LoadImage", inputs: { image } };
  w["6"] = { class_type: "FluxKontextImageScale", inputs: { image: ["5", 0] } };
  const refs = { clip: ["1", 0], vae: ["2", 0], image1: ["6", 0] };
  if (image2) { w["7"] = { class_type: "LoadImage", inputs: { image: image2 } }; refs.image2 = ["7", 0]; }
  if (image3) { w["8"] = { class_type: "LoadImage", inputs: { image: image3 } }; refs.image3 = ["8", 0]; }
  w["3"] = { class_type: "TextEncodeQwenImageEditPlus", inputs: { ...refs, prompt } };
  w["4"] = { class_type: "TextEncodeQwenImageEditPlus", inputs: { ...refs, prompt: "" } };
  w["40"] = { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["3", 0], reference_latents_method: "index_timestep_zero" } };
  w["41"] = { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["4", 0], reference_latents_method: "index_timestep_zero" } };
  w["10"] = { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511_fp8mixed.safetensors", weight_dtype: "default" } };
  w["11"] = { class_type: "ModelSamplingAuraFlow", inputs: { model: ["10", 0], shift: 3.1 } };
  w["12"] = { class_type: "CFGNorm", inputs: { model: ["11", 0], strength: 1 } };
  let model = ["12", 0];
  if (fast) {
    w["13"] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", strength_model: clamp(num(loraStrength, 1), 0, 2) } };
    model = ["13", 0];
  }
  w["14"] = { class_type: "VAEEncode", inputs: { pixels: ["6", 0], vae: ["2", 0] } };
  w["20"] = {
    class_type: "KSampler",
    inputs: {
      model, seed, steps: Math.round(clamp(num(steps, d.steps), 1, 100)), cfg: clamp(num(cfg, d.cfg), 0, 20), sampler_name: "euler", scheduler: "simple",
      positive: ["40", 0], negative: ["41", 0], latent_image: ["14", 0], denoise: clamp(num(denoise, 1), 0.05, 1),
    },
  };
  w["30"] = { class_type: "VAEDecode", inputs: { samples: ["20", 0], vae: ["2", 0] } };
  w["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: "i2i" } };
  return w;
}

