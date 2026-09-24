# Hacktivate AI Solver

A small web dashboard for the [Hacktivate cybersecurity course](https://www.hacktivate.io/cybersecurity).
Paste, drop, or upload a screenshot of a question and Claude streams back the answer and a short explanation of why.

## Features

- **Paste to solve**: press Ctrl/⌘ + V anywhere on the page and the answer starts streaming right away. You can turn off auto-solve.
- Drag and drop or pick files. Each question can have up to 10 screenshots, for questions that span several screens.
- Optional context box, for example "module 3, Linux permissions".
- **Fast / Balanced / Thorough** modes, which map to Claude's effort levels.
- Every reply starts with a bold **Answer:** line, followed by a "Why" section.
- History of past answers, stored in your browser's localStorage.
- Copy button, a live timer, and a Stop button.

## Setup

Requires Node.js 22+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
cp .env.example .env      # then put your key in .env
npm start
```

Open http://localhost:3000.

### Configuration (`.env`)

| Variable            | Default         | Description                                |
| ------------------- | --------------- | ------------------------------------------ |
| `ANTHROPIC_API_KEY` | —               | Required. Your Anthropic API key.          |
| `CLAUDE_MODEL`      | `claude-opus-5` | Model used to read the screenshots.        |
| `CLAUDE_EFFORT`     | `medium`        | Default effort if the UI doesn't send one. |
| `PORT`              | `3000`          | Port the server listens on.                |

## How it works

- `public/`: the dashboard (plain HTML, CSS and JS). It downscales very large screenshots before upload.
- `server.js`: an Express server. `POST /api/solve` sends the images to the Claude Messages API with vision and streams the text back to the browser over Server-Sent Events. Server-side refusal fallbacks are turned on, so a declined request is retried on a fallback model automatically.
- The API key stays on the server and is never sent to the browser.
