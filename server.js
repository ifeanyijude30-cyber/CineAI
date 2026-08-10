import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fal } from "@fal-ai/client";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 8);

if (!process.env.FAL_KEY) {
  console.warn("FAL_KEY is not set. Video generation requests will fail until it is configured.");
}
fal.config({ credentials: process.env.FAL_KEY });

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

function requireSupabase() {
  if (!supabaseAdmin) {
    const e = new Error("Supabase is not configured on the server.");
    e.status = 503;
    throw e;
  }
}

async function authUser(req) {
  requireSupabase();
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    const e = new Error("Sign in is required.");
    e.status = 401;
    throw e;
  }
  const token = header.slice(7);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    const e = new Error("Invalid or expired session.");
    e.status = 401;
    throw e;
  }
  return data.user;
}

async function consumeCredits(userId, amount) {
  const { data, error } = await supabaseAdmin.rpc("consume_credits", {
    p_user_id: userId, p_amount: amount
  });
  if (error) throw error;
  if (!data || data.length === 0 || data[0].success !== true) {
    const e = new Error("Not enough credits.");
    e.status = 402;
    throw e;
  }
  return data[0];
}

async function refundCredits(userId, amount) {
  await supabaseAdmin.rpc("add_credits", { p_user_id: userId, p_amount: amount });
}

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.disable("x-powered-by");
app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPG, PNG and WEBP images are allowed."), ok);
  }
});

// Demo job store. Replace with Redis/Postgres in production.
const jobs = new Map();

function requireKey() {
  if (!process.env.FAL_KEY) {
    const e = new Error("FAL_KEY is not configured on the server.");
    e.status = 503;
    throw e;
  }
}

function imageToDataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

function safeDuration(value, allowed = [3,4,5,6,7,8,9,10,11,12,13,14,15]) {
  const n = Number(value);
  if (!allowed.includes(n)) return String(allowed.includes(10) ? 10 : allowed[0]);
  return String(n);
}

async function submit(model, input) {
  requireKey();
  const result = await fal.queue.submit(model, { input });
  const id = result.request_id;
  jobs.set(id, { model, status: "IN_QUEUE", createdAt: Date.now() });
  return id;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "CineAI backend", falConfigured: Boolean(process.env.FAL_KEY) });
});

app.post("/api/generate/prompt", async (req, res, next) => {
  let user, charged = false, cost = 0;
  try {
    user = await authUser(req);
    const { prompt, duration = 10, aspectRatio = "16:9", generateAudio = true } = req.body || {};
    if (!prompt || prompt.trim().length < 3) return res.status(400).json({ error: "Please provide a video prompt." });
    cost = Number(duration);
    await consumeCredits(user.id, cost); charged = true;

    const id = await submit("fal-ai/kling-video/v3/standard/text-to-video", {
      prompt: prompt.trim().slice(0, 2500),
      duration: safeDuration(duration),
      aspect_ratio: ["16:9","9:16","1:1"].includes(aspectRatio) ? aspectRatio : "16:9",
      generate_audio: Boolean(generateAudio),
      negative_prompt: "blur, distort, low quality, jitter, warped anatomy"
    });
    jobs.set(id, { ...jobs.get(id), userId: user.id, cost });
    await supabaseAdmin.from("generations").insert({
      id, user_id: user.id, type: "prompt", prompt: prompt.trim(), cost, status: "IN_QUEUE"
    });
    res.status(202).json({ jobId: id, creditsCharged: cost });
  } catch (e) {
    if (charged && user) await refundCredits(user.id, cost);
    next(e);
  }
});

app.post("/api/generate/image", upload.single("image"), async (req, res, next) => {
  let user, charged = false, cost = Number(req.body.duration || 10);
  try {
    user = await authUser(req);
    if (!req.file) return res.status(400).json({ error: "Please upload an image." });
    const prompt = (req.body.motionPrompt || "Natural cinematic movement, subtle camera motion, realistic lighting and environmental motion.").slice(0, 2500);
    await consumeCredits(user.id, cost); charged = true;
    const id = await submit("fal-ai/kling-video/v3/standard/image-to-video", {
      prompt, start_image_url: imageToDataUri(req.file),
      duration: safeDuration(cost, [5,10]), generate_audio: false,
      negative_prompt: "blur, distort, low quality, jitter, warped anatomy"
    });
    jobs.set(id, { ...jobs.get(id), userId: user.id, cost });
    await supabaseAdmin.from("generations").insert({
      id, user_id: user.id, type: "image", prompt, cost, status: "IN_QUEUE"
    });
    res.status(202).json({ jobId: id, creditsCharged: cost });
  } catch (e) {
    if (charged && user) await refundCredits(user.id, cost);
    next(e);
  }
});

app.post("/api/generate/talking", upload.single("image"), async (req, res, next) => {
  let user, charged = false, cost = 15;
  try {
    user = await authUser(req);
    if (!req.file) return res.status(400).json({ error: "Please upload a portrait photo." });
    const script = (req.body.script || "").trim();
    if (script.length < 2) return res.status(400).json({ error: "Please enter what the person should say." });
    await consumeCredits(user.id, cost); charged = true;

    const prompt = [
      "Create a realistic talking-photo video using the person in the reference image.",
      "The person looks naturally into the camera, speaks clearly, has realistic facial expressions and accurate mouth movement.",
      `They say, <S>${script.slice(0, 1800)}<E>.`,
      "<AUDCAP>Natural, clear, human-sounding spoken voice, clean recording, accurate pronunciation and natural pacing.<ENDAUDCAP>"
    ].join(" ");

    const id = await submit("fal-ai/ovi/image-to-video", {
      prompt, image_url: imageToDataUri(req.file),
      negative_prompt: "robotic voice, muffled audio, echo, distorted face, jitter, blur, warped mouth",
      audio_negative_prompt: "robotic, muffled, echo, distorted"
    });
    jobs.set(id, { ...jobs.get(id), userId: user.id, cost });
    await supabaseAdmin.from("generations").insert({
      id, user_id: user.id, type: "talking", prompt: script, cost, status: "IN_QUEUE"
    });
    res.status(202).json({ jobId: id, creditsCharged: cost });
  } catch (e) {
    if (charged && user) await refundCredits(user.id, cost);
    next(e);
  }
});

app.get("/api/jobs/:id", async (req, res, next) => {
  try {
    const user = await authUser(req);
    requireKey();
    const id = req.params.id;
    const job = jobs.get(id);
    if (!job || job.userId !== user.id) return res.status(404).json({ error: "Job not found." });

    if (job.status === "COMPLETED" || job.status === "FAILED") return res.json(job);

    const status = await fal.queue.status(job.model, { requestId: id, logs: false });
    if (status.status === "COMPLETED") {
      const result = await fal.queue.result(job.model, { requestId: id });
      const videoUrl = result?.data?.video?.url || result?.video?.url || null;
      job.status = "COMPLETED"; job.videoUrl = videoUrl; job.result = result.data;
      jobs.set(id, job);
      await supabaseAdmin.from("generations").update({
        status: "COMPLETED", video_url: videoUrl
      }).eq("id", id).eq("user_id", user.id);
      return res.json(job);
    }
    if (status.status === "FAILED") {
      job.status = "FAILED"; job.error = status.error || "Generation failed."; jobs.set(id, job);
      await supabaseAdmin.from("generations").update({ status: "FAILED", error: job.error }).eq("id", id).eq("user_id", user.id);
      await refundCredits(user.id, job.cost || 0);
      return res.json(job);
    }
    job.status = status.status || "IN_PROGRESS"; jobs.set(id, job);
    await supabaseAdmin.from("generations").update({ status: job.status }).eq("id", id).eq("user_id", user.id);
    res.json(job);
  } catch (e) { next(e); }
});


app.get("/api/me", async (req, res, next) => {
  try {
    const user = await authUser(req);
    const { data, error } = await supabaseAdmin.from("profiles").select("id,email,credits,plan").eq("id", user.id).single();
    if (error) throw error;
    res.json(data);
  } catch(e) { next(e); }
});

const PACKAGES = {
  starter: { name: "Starter", credits: 120, amountNGN: 5000 },
  creator: { name: "Creator", credits: 400, amountNGN: 12000 },
  pro: { name: "Pro", credits: 1000, amountNGN: 25000 }
};

app.get("/api/plans", (_req, res) => res.json(PACKAGES));

app.post("/api/payments/initialize", async (req, res, next) => {
  try {
    const user = await authUser(req);
    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: "Paystack is not configured." });
    const plan = PACKAGES[req.body?.plan];
    if (!plan) return res.status(400).json({ error: "Invalid plan." });

    const reference = `CINEAI-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: user.email,
        amount: String(plan.amountNGN * 100),
        currency: "NGN",
        reference,
        callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.PUBLIC_URL}/payment/callback`,
        metadata: JSON.stringify({ user_id: user.id, plan: req.body.plan, credits: plan.credits })
      })
    });
    const data = await response.json();
    if (!response.ok || !data.status) return res.status(400).json({ error: data.message || "Unable to initialize payment." });

    await supabaseAdmin.from("payments").insert({
      reference, user_id: user.id, plan: req.body.plan,
      amount_kobo: plan.amountNGN * 100, credits: plan.credits, status: "pending"
    });
    res.json({ authorization_url: data.data.authorization_url, reference });
  } catch(e) { next(e); }
});

app.get("/api/payments/verify/:reference", async (req, res, next) => {
  try {
    const user = await authUser(req);
    if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: "Paystack is not configured." });
    const reference = req.params.reference;
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const data = await response.json();
    if (!response.ok || !data.status || data.data.status !== "success") {
      return res.status(400).json({ error: "Payment has not been verified as successful." });
    }
    const { data: payment } = await supabaseAdmin.from("payments").select("*").eq("reference", reference).eq("user_id", user.id).single();
    if (!payment) return res.status(404).json({ error: "Payment record not found." });
    if (payment.status !== "success") {
      await supabaseAdmin.from("payments").update({ status: "success", paid_at: new Date().toISOString() }).eq("reference", reference);
      await supabaseAdmin.rpc("add_credits", { p_user_id: user.id, p_amount: payment.credits });
    }
    const { data: profile } = await supabaseAdmin.from("profiles").select("credits,plan").eq("id", user.id).single();
    res.json({ ok: true, credits: profile?.credits, plan: profile?.plan });
  } catch(e) { next(e); }
});

app.post("/api/paystack/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const raw = req.rawBody || req.body; const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
    if (!signature || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) return res.sendStatus(401);
    const event = typeof req.body === "object" ? req.body : JSON.parse(String(req.body));
    if (event.event === "charge.success") {
      const reference = event.data.reference;
      const { data: payment } = await supabaseAdmin.from("payments").select("*").eq("reference", reference).single();
      if (payment && payment.status !== "success") {
        await supabaseAdmin.from("payments").update({
          status: "success", paid_at: new Date().toISOString()
        }).eq("reference", reference);
        await supabaseAdmin.rpc("add_credits", { p_user_id: payment.user_id, p_amount: payment.credits });
      }
    }
    return res.sendStatus(200);
  } catch(e) { console.error("Webhook error", e); return res.sendStatus(500); }
});


function requireAdmin(user) {
  const allowed = (process.env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes((user.email || "").toLowerCase())) {
    const e = new Error("Admin access required.");
    e.status = 403;
    throw e;
  }
}

app.get("/api/admin/overview", async (req, res, next) => {
  try {
    const user = await authUser(req);
    requireAdmin(user);

    const [{ data: profiles, error: pe }, { data: generations, error: ge }, { data: payments, error: paye }] =
      await Promise.all([
        supabaseAdmin.from("profiles").select("id,email,credits,plan,created_at").order("created_at", { ascending: false }),
        supabaseAdmin.from("generations").select("id,user_id,type,cost,status,video_url,created_at,error").order("created_at", { ascending: false }).limit(500),
        supabaseAdmin.from("payments").select("reference,user_id,plan,amount_kobo,credits,status,paid_at,created_at").order("created_at", { ascending: false }).limit(500)
      ]);
    if (pe || ge || paye) throw (pe || ge || paye);

    const revenue = (payments || []).filter(p => p.status === "success")
      .reduce((sum,p) => sum + Number(p.amount_kobo || 0), 0) / 100;
    const successful = (generations || []).filter(g => g.status === "COMPLETED").length;
    const failed = (generations || []).filter(g => g.status === "FAILED").length;

    res.json({
      stats: {
        users: profiles?.length || 0,
        generations: generations?.length || 0,
        successful,
        failed,
        revenueNGN: revenue,
        creditsOutstanding: (profiles || []).reduce((s,p) => s + Number(p.credits || 0), 0)
      },
      users: profiles || [],
      generations: generations || [],
      payments: payments || []
    });
  } catch(e) { next(e); }
});

app.post("/api/admin/credits", async (req, res, next) => {
  try {
    const admin = await authUser(req); requireAdmin(admin);
    const userId = req.body?.userId;
    const amount = Number(req.body?.amount);
    if (!userId || !Number.isInteger(amount) || amount === 0) return res.status(400).json({error:"Enter a valid user and credit amount."});
    const balance = await supabaseAdmin.rpc("add_credits", { p_user_id: userId, p_amount: amount });
    if (balance.error) throw balance.error;
    res.json({ok:true, credits:balance.data});
  } catch(e){ next(e); }
});

app.post("/api/admin/user-plan", async (req,res,next)=>{
  try{
    const admin=await authUser(req); requireAdmin(admin);
    const {userId, plan}=req.body||{};
    if(!userId || !plan) return res.status(400).json({error:"User and plan are required."});
    const {error}=await supabaseAdmin.from("profiles").update({plan}).eq("id",userId);
    if(error) throw error;
    res.json({ok:true});
  }catch(e){next(e);}
});

app.use(express.static(path.join(process.cwd(), "public")));

app.use((err, _req, res, _next) => {
  console.error(err);
  const code = err.status || 500;
  res.status(code).json({ error: err.message || "Server error." });
});

app.listen(PORT, () => console.log(`CineAI backend running on http://localhost:${PORT}`));
