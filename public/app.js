const MAX_IMAGES = 10;
const MAX_EDGE = 2000; // downscale huge screenshots to keep uploads fast
const HISTORY_KEY = "hacktivate-solver-history";
const HISTORY_LIMIT = 30;

const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const thumbs = $("thumbs");
const note = $("note");
const effort = $("effort");
const autoSolve = $("autoSolve");
const solveBtn = $("solveBtn");
const clearBtn = $("clearBtn");
const answerCard = $("answerCard");
const answerEl = $("answer");
const copyBtn = $("copyBtn");
const stopBtn = $("stopBtn");
const timerEl = $("timer");
const statusEl = $("status");
const historyList = $("historyList");
const historyEmpty = $("historyEmpty");

/** @type {{mediaType: string, data: string, url: string}[]} */
let images = [];
let controller = null;
let answerText = "";

// Escape raw HTML in model output so nothing in a screenshot can inject markup.
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
marked.use({
  renderer: {
    html: (token) => escapeHtml(token.text ?? ""),
    link({ href, tokens }) {
      const safe = /^https?:\/\//i.test(href) ? href : "#";
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${this.parser.parseInline(tokens)}</a>`;
    },
  },
});
const renderMarkdown = (md) => marked.parse(md);

// ---------- server status ----------
fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    if (h.keyConfigured) {
      statusEl.textContent = `● ready · ${h.model}`;
      statusEl.className = "status ok";
    } else {
      statusEl.textContent = "● ANTHROPIC_API_KEY not set";
      statusEl.className = "status bad";
    }
  })
  .catch(() => {
    statusEl.textContent = "● server offline";
    statusEl.className = "status bad";
  });

// ---------- adding images ----------
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function fileToImage(file) {
  let dataUrl = await readAsDataURL(file);
  let mediaType = file.type;
  const img = await loadImage(dataUrl);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest > MAX_EDGE || mediaType === "image/gif") {
    const scale = Math.min(1, MAX_EDGE / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    dataUrl = canvas.toDataURL("image/png");
    mediaType = "image/png";
  }
  return { mediaType, data: dataUrl.split(",")[1], url: dataUrl };
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
  if (!files.length) return false;
  const room = MAX_IMAGES - images.length;
  for (const file of files.slice(0, room)) {
    try {
      images.push(await fileToImage(file));
    } catch (e) {
      console.error("Could not read image", e);
    }
  }
  renderThumbs();
  return true;
}

function renderThumbs() {
  thumbs.innerHTML = "";
  const tpl = $("thumbTpl");
  images.forEach((img, i) => {
    const node = tpl.content.cloneNode(true);
    node.querySelector("img").src = img.url;
    node.querySelector(".remove").addEventListener("click", () => {
      images.splice(i, 1);
      renderThumbs();
    });
    thumbs.appendChild(node);
  });
  solveBtn.disabled = images.length === 0 || controller !== null;
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", async () => {
  const added = await addFiles(fileInput.files);
  fileInput.value = "";
  if (added && autoSolve.checked) solve();
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, () => dropzone.classList.remove("drag")),
);
dropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  if ((await addFiles(e.dataTransfer.files)) && autoSolve.checked) solve();
});

document.addEventListener("paste", async (e) => {
  const files = [...(e.clipboardData?.items ?? [])]
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return; // let normal text paste through
  e.preventDefault();
  if ((await addFiles(files)) && autoSolve.checked) solve();
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !solveBtn.disabled) solve();
});

clearBtn.addEventListener("click", () => {
  images = [];
  note.value = "";
  renderThumbs();
});

// ---------- solving ----------
async function solve() {
  if (!images.length || controller) return;

  const sent = images.slice();
  controller = new AbortController();
  solveBtn.disabled = true;
  stopBtn.classList.remove("hidden");
  answerCard.classList.remove("hidden");
  answerEl.className = "answer markdown loading";
  answerEl.innerHTML = "";
  answerText = "";
  markActiveHistory(null);

  const started = performance.now();
  const tick = setInterval(() => {
    timerEl.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
  }, 100);

  let failed = false;
  try {
    const res = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: sent.map(({ mediaType, data }) => ({ mediaType, data })),
        note: note.value,
        effort: effort.value,
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? "{}");
        if (event === "delta") {
          answerText += data.text;
          answerEl.innerHTML = renderMarkdown(answerText);
        } else if (event === "error") {
          throw new Error(data.error);
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      failed = true;
      answerEl.classList.add("error");
      answerEl.textContent = err.message;
    }
  } finally {
    clearInterval(tick);
    answerEl.classList.remove("loading");
    stopBtn.classList.add("hidden");
    controller = null;
    renderThumbs();
  }

  if (!failed && answerText.trim()) {
    await saveHistory(sent[0].url, answerText);
    images = [];
    note.value = "";
    renderThumbs();
  }
}

solveBtn.addEventListener("click", solve);
stopBtn.addEventListener("click", () => controller?.abort());
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(answerText);
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
  } catch {
    /* clipboard blocked */
  }
});

// ---------- history (browser-local) ----------
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
  } catch {
    return [];
  }
}

function storeHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    /* storage full or blocked — history is a convenience only */
  }
}

async function makeThumb(url) {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  const scale = 160 / Math.max(img.naturalWidth, img.naturalHeight);
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}

async function saveHistory(imageUrl, text) {
  const items = loadHistory();
  const id = Date.now();
  items.unshift({ id, thumb: await makeThumb(imageUrl), answer: text, at: new Date().toISOString() });
  storeHistory(items.slice(0, HISTORY_LIMIT));
  renderHistory();
  markActiveHistory(id);
}

function headline(text) {
  const m = /\*\*Answer:\*\*\s*(.+)/.exec(text);
  return (m ? m[1] : text).replace(/[*_`#]/g, "").trim();
}

function renderHistory() {
  const items = loadHistory();
  historyList.innerHTML = "";
  historyEmpty.classList.toggle("hidden", items.length > 0);
  for (const item of items) {
    const li = document.createElement("li");
    li.dataset.id = item.id;
    const img = document.createElement("img");
    img.src = item.thumb;
    img.alt = "";
    const text = document.createElement("div");
    text.className = "h-text";
    const ans = document.createElement("div");
    ans.className = "h-answer";
    ans.textContent = headline(item.answer);
    const time = document.createElement("div");
    time.className = "h-time";
    time.textContent = new Date(item.at).toLocaleString();
    text.append(ans, time);
    li.append(img, text);
    li.addEventListener("click", () => {
      if (controller) return;
      answerText = item.answer;
      answerCard.classList.remove("hidden");
      answerEl.className = "answer markdown";
      answerEl.innerHTML = renderMarkdown(item.answer);
      timerEl.textContent = "";
      markActiveHistory(item.id);
    });
    historyList.appendChild(li);
  }
}

function markActiveHistory(id) {
  for (const li of historyList.children) li.classList.toggle("active", String(id) === li.dataset.id);
}

$("clearHistory").addEventListener("click", () => {
  storeHistory([]);
  renderHistory();
});

renderHistory();
