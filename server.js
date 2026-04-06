import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const UP = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const FILES = "https://generativelanguage.googleapis.com/v1beta/files";

const LIM = {
  v: 500 * 1024 * 1024,
  r: 5 * 1024 * 1024,
  h: 10 * 1024 * 1024,
};

const MIME = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ext = (n) => {
  const i = String(n || "").lastIndexOf(".");
  return i >= 0 ? String(n).slice(i).toLowerCase() : "";
};

const guessMime = (name, fallback) => MIME[ext(name)] || fallback || "application/octet-stream";

const normalizeUrl = (u) => {
  if (u == null) return "";
  let t = String(u).trim();
  if (!t) return "";
  if (t.startsWith("//")) return "https:" + t;
  if (!/^https?:\/\//i.test(t)) return "https://" + t.replace(/^\/+/, "");
  return t;
};

const fetchOpts = {
  redirect: "follow",
  headers: { "User-Agent": "CastingRenderService/1" },
};

const s = (v) => (v == null ? "" : String(v).replace(/\0/g, ""));

const roleCharsText = (rc) => {
  try {
    if (rc == null) return "";
    if (Array.isArray(rc)) return rc.map((x) => s(x)).join("\n");
    return s(rc);
  } catch {
    return "";
  }
};

async function fetchBinary(url) {
  const abs = normalizeUrl(url);
  console.log("Fetching:", abs);
  if (!abs) throw new Error("Missing file URL");

  const res = await fetch(abs, fetchOpts);
  if (!res.ok) throw new Error(`Fetch ${res.status}: ${abs}`);

  const ab = await res.arrayBuffer();
  let name = "file";

  try {
    const parsed = new URL(abs);
    const last = parsed.pathname.split("/").pop();
    if (last) name = decodeURIComponent(last.split("?")[0]);
  } catch {}

  const buffer = Buffer.from(ab);
  return { buffer, name, size: buffer.length };
}

async function upload(apiKey, fileBuffer, displayName, mimeType) {
  const mid = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer);
  const size = mid.length;
  if (!size) throw new Error("Empty file buffer");

  let base = String(displayName || "file").split(/[\\/]/).pop() || "file";
  base = base.split("?")[0].split("#")[0];
  base = base.replace(/[^\x20-\x7E]/g, "_").replace(/["\\\r\n]/g, "_");
  if (!base || base === "." || base === "..") base = "file.bin";

  let safeName = base.slice(0, 80);
  let meta = JSON.stringify({ file: { display_name: safeName, mime_type: mimeType } });

  while (meta.length > 520 && safeName.length > 8) {
    safeName = safeName.slice(0, Math.max(8, safeName.length - 12));
    meta = JSON.stringify({ file: { display_name: safeName, mime_type: mimeType } });
  }

  if (meta.length > 600) {
    meta = JSON.stringify({ file: { display_name: "upload.bin", mime_type: mimeType } });
  }

  const startRes = await fetch(`${UP}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: meta,
  });

  const uploadUrl = startRes.headers.get("x-goog-upload-url") || startRes.headers.get("X-Goog-Upload-Url");
  if (!uploadUrl) {
    const t = await startRes.text();
    throw new Error(`Upload start ${startRes.status}: ${t.slice(0, 800)}`);
  }

  const upRes = await fetch(uploadUrl.trim(), {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Type": mimeType,
    },
    body: mid,
  });

  const text = await upRes.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Upload bytes ${upRes.status}: ${text.slice(0, 800)}`);
  }

  if (!upRes.ok) {
    const msg = json?.error?.message || text;
    if (upRes.status === 400 && /quicktime|mov|unsupported|codec|hevc|h\.265/i.test(msg)) {
      throw new Error("Video format appears unsupported by Gemini. Convert to MP4 H.264 + AAC, then retry.");
    }
    throw new Error(msg);
  }

  const file = json.file || json;
  if (!file.name || !file.uri) throw new Error(`Bad upload: ${text.slice(0, 400)}`);

  return { name: file.name, uri: file.uri, mimeType };
}

async function uploadVideoWithMovFallback(apiKey, buffer, filename, preferredMime) {
  try {
    return await upload(apiKey, buffer, filename || "audition.mp4", preferredMime);
  } catch (e) {
    const em = String(e?.message || e);
    const fn = String(filename || "");
    const looksMov = /\.mov$/i.test(fn);
    const wasQuicktime = /quicktime/i.test(preferredMime || "");

    if (looksMov && wasQuicktime && /400|codec|unsupported|invalid|failed|quicktime|process/i.test(em)) {
      const altName = fn.replace(/\.mov$/i, ".mp4");
      return await upload(apiKey, buffer, altName || "audition.mp4", "video/mp4");
    }
    throw e;
  }
}

async function waitActive(apiKey, fileName) {
  const id = String(fileName).replace(/^files\//, "");
  const url = `${FILES}/${encodeURIComponent(id)}?key=${encodeURIComponent(apiKey)}`;
  const t0 = Date.now();

  while (Date.now() - t0 < 600000) {
    const res = await fetch(url, fetchOpts);
    const text = await res.text();

    let json;
    try {
      consiole.log("-----------------------------------------------");
    console.log(text);
      json = JSON.parse(text);
    } catch {
      throw new Error(`File status ${res.status}`);
    }

    if (!res.ok) throw new Error(json?.error?.message || text);
    if (json.state === "ACTIVE") return json;
    if (json.state === "FAILED") throw new Error(`File FAILED: ${text}`);

    await sleep(2000);
  }

  throw new Error("Timeout waiting for file ACTIVE");
}

async function analyzeCasting(properties) {
  const p = properties || {};
  const apiKey = p.gemini_api_key || p.api_key || process.env.GEMINI_API_KEY;
  const model = p.model || "gemini-2.5-flash";
  const videoUrl = normalizeUrl(p.video_url);

  if (!apiKey) throw new Error("gemini_api_key required or set GEMINI_API_KEY env var");
  if (!videoUrl) throw new Error("video_url required");

  const resumeUrl = p.resume_url ? normalizeUrl(p.resume_url) : "";
  const headshotUrl = p.headshot_url ? normalizeUrl(p.headshot_url) : "";

  const vf = await fetchBinary(videoUrl);
  if (vf.size > LIM.v) throw new Error("Video too large");

  const parts = [];
  const videoMime = p.video_mime ? String(p.video_mime).trim() : guessMime(vf.name, "video/mp4");

  const vUp = await uploadVideoWithMovFallback(apiKey, vf.buffer, vf.name || "audition.mp4", videoMime);
  await waitActive(apiKey, vUp.name);
  parts.push({ file_data: { mime_type: vUp.mimeType, file_uri: vUp.uri } });

  let resumeProvided = false;
  let headshotProvided = false;

  if (resumeUrl) {
    const rf = await fetchBinary(resumeUrl);
    if (rf.size > LIM.r) throw new Error("Resume too large");
    const rUp = await upload(apiKey, rf.buffer, rf.name || "resume.pdf", guessMime(rf.name, "application/pdf"));
    await waitActive(apiKey, rUp.name);
    parts.push({ file_data: { mime_type: rUp.mimeType, file_uri: rUp.uri } });
    resumeProvided = true;
  }

  if (headshotUrl) {
    const hf = await fetchBinary(headshotUrl);
    if (hf.size > LIM.h) throw new Error("Headshot too large");
    const hUp = await upload(apiKey, hf.buffer, hf.name || "headshot.jpg", guessMime(hf.name, "image/jpeg"));
    await waitActive(apiKey, hUp.name);
    parts.push({ file_data: { mime_type: hUp.mimeType, file_uri: hUp.uri } });
    headshotProvided = true;
  }

  const drive = p.drive_folder_link ? normalizeUrl(p.drive_folder_link) : "";
  const headshotText = headshotUrl || "";

  const prompt =
    "You are an expert casting evaluator. You MUST watch and reason over the ENTIRE audition video from start to finish (all relevant moments), including audio and visuals—not only the opening seconds. " +
    (resumeProvided
      ? "Use the resume file for relevant experience, training, credits, and skills.\n\n"
      : "No resume file was supplied; base experience assessment only on the text fields and video.\n\n") +
    (headshotProvided
      ? "A headshot image is included as a separate file; use it only for general presentation reference if helpful.\n\n"
      : "No headshot image file was supplied.\n\n") +
    (drive
      ? "Additional materials may exist at this Drive folder link (you cannot browse it; treat as context only): " + drive + "\n\n"
      : "") +
    "VIDEO TYPES (handle all): The submission may be a plain self-introduction, a short skit or monologue, a cold read, an improvisation, a slate, a reel excerpt, or something minimal with little performance. Adapt your criteria accordingly. If the clip contains little or no performative content (e.g., only introduction, reading ID, or a static talking head with no acting task), say so explicitly and score conservatively based on what is actually demonstrated.\n\n" +
    "WHAT TO ANALYZE (be specific and evidence-based):\n" +
    "- Performance and presence: energy, pacing, confidence, clarity, believability, connection to camera or scene partner if applicable.\n" +
    "- Voice and speech: articulation, intelligibility given the recording, tone, emotional coloring when applicable.\n" +
    "- Face and body: facial expressiveness range (subtle vs broad), micro-expressions, emotional authenticity, eye focus and eye contact, posture, gesture appropriateness, and physical suitability hints for the role only when visible.\n" +
    "- Facial-expression evidence: cite specific moments when expressions change (for example neutral -> concern -> relief), and clearly state when visibility, framing, or lighting prevents reliable judgment.\n" +
    "- Fit to THIS role and project: compare against the role description, requirements, characteristics, age and height constraints, location, and casting type.\n\n" +
    "SCORING AND OUTPUT RULES:\n" +
    "- ai_score: integer 0-100 for fit and suitability for THIS specific role, using BOTH video and resume (weight the video heavily when it contains real performance; weight the resume more if the video is non-performative).\n" +
    "- strengths: ONLY positive, specific observations grounded in what you saw, heard, or read. Put facial-expression positives here only when genuinely supported.\n" +
    "- considerations: concerns, risks, gaps, or weaknesses grounded in what you saw, heard, or read. Put facial-expression limitations here when applicable. Do not duplicate the same point in strengths and considerations.\n" +
    "- overall_assessment: concise but detailed summary of fit for the role.\n" +
    "- recommendation: clear next step (for example callback, request more material, or not a fit) with brief rationale.\n\n" +
    "If something cannot be judged from the footage (for example poor mic, face not visible, clip too short), state that limitation in considerations rather than inventing facts.\n\n" +
    "Project Title: " + s(p.PROJECT_TITLE) +
    "\nProject Overview: " + s(p.project_overview) +
    "\nCasting for: " + s(p.casting_for) +
    "\n\nROLE\n" +
    "Role Type: " + s(p.role_type) +
    "\nRole Gender: " + s(p.role_gender) +
    "\nRole Description: " + s(p.role_description) +
    "\nRole Requirements: " + s(p.role_requirements) +
    "\nRole Characteristics: " + roleCharsText(p.role_characteristics) +
    "\nAge Range: " + s(p.age_range) +
    "\nCountry: " + s(p.country) +
    "\nCity: " + s(p.city) +
    "\nMinimum Height: " + s(p.minimum_height) +
    "\nMaximum Height: " + s(p.maximum_height) +
    "\nMinimum AI Score: " + s(p.minimum_ai_score) +
    "\n\nAPPLICANT\n" +
    "Gender: " + s(p.user_gender) +
    "\nAge: " + s(p.user_age) +
    "\nCity: " + s(p.user_city) +
    "\nCountry: " + s(p.user_country) +
    "\nHeight: " + s(p.user_height) +
    "\nHeadshot URL (text field): " + (headshotText || "(not provided)") +
    "\nDrive Folder Link: " + (drive || "(not provided)") +
    "\nAbout: " + s(p.about_person) +
    "\nBio: " + s(p.bio) +
    "\n\nReturn ONLY a JSON object with keys: ai_score (integer 0-100), overall_assessment (string), strengths (array of strings), considerations (array of strings), recommendation (string). No markdown, no code fences, no extra text.";
  console.log("prompt");
  console.log(prompt);
  parts.push({ text: prompt });

  const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const genRes = await fetch(genUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  const genText = await genRes.text();

  let genJson;
  try {
    consiole.log("-----------------------------------------------");
    console.log(genText);
    genJson = JSON.parse(genText);
  } catch {
    throw new Error(`generateContent ${genRes.status}: ${genText.slice(0, 800)}`);
  }

  if (!genRes.ok) throw new Error(genJson?.error?.message || genText);
  if (!genJson.candidates?.length) {
    const br = genJson?.promptFeedback?.blockReason || "";
    throw new Error(`Gemini returned no candidates. ${br}`);
  }

  const cand = genJson.candidates[0];
  const outParts = cand?.content?.parts || [];
  let outText = "";
  for (const part of outParts) outText += part.text || "";
  outText = outText.trim();

  if (!outText) throw new Error(`Empty model text: ${genText.slice(0, 500)}`);

  let parsed;
  try {
    parsed = JSON.parse(outText);
  } catch {
    throw new Error(`Invalid JSON: ${outText.slice(0, 1200)}`);
  }

  const toStrList = (v) => Array.isArray(v) ? v.map((x) => s(x)) : v == null ? [] : [s(v)];
  const rawScore = Number(parsed.ai_score);
  const aiScore = Number.isFinite(rawScore) ? Math.round(Math.max(0, Math.min(100, rawScore))) : 0;

  return {
    overall_assessment: s(parsed.overall_assessment),
    strengths: toStrList(parsed.strengths),
    considerations: toStrList(parsed.considerations),
    recommendation: s(parsed.recommendation),
    ai_score: aiScore,
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const jobs = new Map();

app.get("/", (req, res) => {
  res.json({ ok: true, service: "casting-render-service" });
});

app.post("/jobs", (req, res) => {
  const jobId = uuidv4();

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    createdAt: new Date().toISOString(),
    result: null,
    error: null,
  });

  res.json({ job_id: jobId, status: "queued" });

  setImmediate(async () => {
    jobs.set(jobId, { ...jobs.get(jobId), status: "processing" });

    try {
      const result = await analyzeCasting(req.body);
      jobs.set(jobId, { ...jobs.get(jobId), status: "completed", result });
    } catch (err) {
      jobs.set(jobId, {
        ...jobs.get(jobId),
        status: "failed",
        error: String(err?.message || err),
      });
    }
  });
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
