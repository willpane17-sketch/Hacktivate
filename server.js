import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const DEFAULT_EFFORT = process.env.CLAUDE_EFFORT || "medium";
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const client = new Anthropic();
const app = express();

app.use(express.json({ limit: "40mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor", express.static(path.join(__dirname, "node_modules/marked/lib")));

const SYSTEM_PROMPT = `You are a cybersecurity tutor helping a student work through questions from the Hacktivate cybersecurity course (hacktivate.io/cybersecurity). The student sends screenshots of questions.

For each screenshot:
1. Read the question carefully, including every answer option, code snippet, log line, packet capture, or diagram shown.
2. Start your reply with a line in exactly this form:
   **Answer:** <the answer — the option letter and its text for multiple choice, or the exact value/flag/command for free-text>
3. Follow with a short "Why" section (2–5 bullet points) explaining the reasoning, so the student learns the concept.
4. If there are multiple questions in the screenshot, answer each one in order with its own **Answer:** line.
5. If part of the screenshot is cut off or unreadable, say what is missing and give your best answer based on what is visible.

Keep it concise and use Markdown.`;

app.post("/api/solve", async (req, res) => {
  const { images, note, effort } = req.body ?? {};

  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Add at least one screenshot." });
  }
  if (images.length > 10) {
    return res.status(400).json({ error: "Up to 10 screenshots per question." });
  }
  for (const img of images) {
    if (!img || !ALLOWED_TYPES.has(img.mediaType) || typeof img.data !== "string") {
      return res.status(400).json({ error: "Screenshots must be PNG, JPEG, GIF or WebP." });
    }
  }

  const content = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  content.push({
    type: "text",
    text: note?.trim()
      ? `Answer the question in the screenshot(s). Extra context from the student: ${note.trim()}`
      : "Answer the question in the screenshot(s).",
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { effort: EFFORTS.has(effort) ? effort : DEFAULT_EFFORT },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content }],
  });

  res.on("close", () => {
    if (!res.writableEnded) stream.abort();
  });

  stream.on("text", (text) => send("delta", { text }));

  try {
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      send("error", { error: "The model declined to answer this one. Try a clearer or cropped screenshot." });
    } else {
      send("done", { model: message.model, stopReason: message.stop_reason, usage: message.usage });
    }
  } catch (err) {
    if (!res.writableEnded && !res.destroyed) {
      let msg = "Something went wrong talking to Claude.";
      if (err instanceof Anthropic.AuthenticationError) msg = "Invalid or missing ANTHROPIC_API_KEY on the server.";
      else if (err instanceof Anthropic.RateLimitError) msg = "Rate limited — wait a moment and try again.";
      else if (err instanceof Anthropic.BadRequestError) msg = `Request rejected: ${err.message}`;
      else if (err instanceof Anthropic.APIConnectionError) msg = "Could not reach the Claude API.";
      else if (err instanceof Anthropic.APIError) msg = `Claude API error (${err.status ?? "?"}): ${err.message}`;
      console.error(err);
      send("error", { error: msg });
    }
  }
  res.end();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.listen(PORT, () => {
  console.log(`Hacktivate AI dashboard running at http://localhost:${PORT}`);
});
