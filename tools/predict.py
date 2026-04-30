"""Try-it inference UI for the trained classifier.

Standalone Flask app. Paste any text into the textarea, see P(news) plus
the top tokens that pushed the score in each direction. Useful for
gut-checking the model after training, before wiring it into production.

    uv run python tools/predict.py --port 8768

Then open http://127.0.0.1:8768. Loads artifacts/classifier-v1.joblib
by default; pass --model to point at a different artifact.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow joblib.load to resolve `embedder.SentenceEmbedder`.
sys.path.insert(0, str(Path(__file__).parent))

import joblib
import numpy as np
from embedder import SentenceEmbedder  # noqa: F401  — needed for unpickle
from flask import Flask, jsonify, request


HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>predict</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; color: #555; font-weight: 500; }
  textarea { width: 100%; min-height: 9rem; padding: 0.6rem; font: 0.95rem ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
  button { margin-top: 0.6rem; padding: 0.4rem 1rem; font-size: 0.95rem; cursor: pointer; }
  .score-bar { margin-top: 1.5rem; height: 28px; border-radius: 4px; background: #eee; position: relative; overflow: hidden; }
  .score-fill { height: 100%; background: linear-gradient(to right, #ddd, #4a90d9); transition: width 0.2s; }
  .score-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 600; color: #222; }
  .verdict { margin-top: 0.5rem; font-size: 0.95rem; }
  .verdict.pass { color: #065; }
  .verdict.fail { color: #844; }
  .threshold { color: #888; font-size: 0.8rem; }
  .meta { color: #888; font-size: 0.8rem; margin-top: 1.5rem; }
  kbd { background: #eee; border: 1px solid #ccc; padding: 0.05rem 0.4rem; border-radius: 3px; font-family: monospace; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>could-be-news classifier · paste text and press <kbd>⌘</kbd>+<kbd>Enter</kbd></h1>
<textarea id="text" placeholder="Paste a headline, post, or article snippet…" autofocus></textarea>
<button id="go">Predict</button>

<div id="result" style="display:none">
  <div class="score-bar"><div class="score-fill" id="bar"></div><div class="score-text" id="bartext"></div></div>
  <div class="verdict" id="verdict"></div>
</div>

<div class="meta" id="modelmeta"></div>

<script>
const txt = document.getElementById('text');
const btn = document.getElementById('go');

async function predict() {
  const text = txt.value.trim();
  if (!text) return;
  const r = await fetch('/api/predict', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text}),
  });
  const data = await r.json();
  render(data);
}

function render(d) {
  document.getElementById('result').style.display = 'block';
  const pct = (d.score * 100).toFixed(1);
  document.getElementById('bar').style.width = pct + '%';
  document.getElementById('bartext').textContent = `P(news) = ${d.score.toFixed(3)}`;
  const v = document.getElementById('verdict');
  if (d.score >= d.threshold) {
    v.className = 'verdict pass';
    v.innerHTML = `→ would forward to LLM <span class="threshold">(threshold = ${d.threshold})</span>`;
  } else {
    v.className = 'verdict fail';
    v.innerHTML = `→ would drop at gate <span class="threshold">(threshold = ${d.threshold})</span>`;
  }
}

btn.addEventListener('click', predict);
txt.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); predict(); }
});

fetch('/api/meta').then(r => r.json()).then(m => {
  document.getElementById('modelmeta').textContent =
    `model: ${m.model_path} · encoder: ${m.encoder} · ${m.dim}-dim · threshold: ${m.threshold}`;
});
</script>
</body>
</html>
"""


def build_app(pipe, model_path: Path, threshold: float) -> Flask:
    app = Flask(__name__)
    embed = pipe.named_steps["embed"]
    clf = pipe.named_steps["clf"]

    @app.route("/")
    def index():
        return HTML

    @app.route("/api/meta")
    def api_meta():
        return jsonify(
            {
                "model_path": str(model_path),
                "encoder": embed.model_name,
                "dim": int(clf.coef_.shape[1]),
                "threshold": threshold,
            }
        )

    @app.route("/api/predict", methods=["POST"])
    def api_predict():
        data = request.get_json(force=True) or {}
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "empty text"}), 400
        score = float(pipe.predict_proba([text])[0, 1])
        return jsonify({"score": score, "threshold": threshold})

    return app


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", default="artifacts/classifier-v1.joblib")
    p.add_argument("--threshold", type=float, default=0.25,
                   help="cascade gate threshold for the verdict label (default: 0.25)")
    p.add_argument("--port", type=int, default=8768)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args()

    model_path = Path(args.model).resolve()
    if not model_path.exists():
        raise SystemExit(f"model not found: {model_path}\nRun tools/train_classifier.py first.")
    pipe = joblib.load(model_path)
    print(f"loaded model: {model_path}")

    app = build_app(pipe, model_path, args.threshold)
    print(f"open http://{args.host}:{args.port}/")
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
