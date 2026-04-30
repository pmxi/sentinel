"""Train the could-be-news binary classifier from hand labels.

Reads sentinel-labels.db's labeling_examples table, encodes each text with
the frozen sentence encoder (see tools/embedder.py — currently
EmbeddingGemma-300M with the Classification prompt), and fits a
logistic-regression head on top. Reports leave-one-out CV (honest at
small N) and pickles the pipeline.

    uv run python tools/train_classifier.py

Re-run any time after labeling more data.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

# Allow `from embedder import ...` when this script is run directly.
sys.path.insert(0, str(Path(__file__).parent))

import joblib
import numpy as np
from embedder import SentenceEmbedder
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import LeaveOneOut, cross_val_predict
from sklearn.pipeline import Pipeline


def load_examples(db_path: Path) -> tuple[list[str], list[int]]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT title, body, label FROM labeling_examples
        WHERE label IN ('news', 'not_news')
        ORDER BY labeled_at ASC
        """
    ).fetchall()
    conn.close()
    texts = [(r["title"] or "") + ("\n" + r["body"] if r["body"] else "") for r in rows]
    y = [1 if r["label"] == "news" else 0 for r in rows]
    return texts, y


def build_pipeline() -> Pipeline:
    return Pipeline(
        [
            ("embed", SentenceEmbedder()),
            (
                "clf",
                LogisticRegression(
                    C=1.0,
                    max_iter=1000,
                    solver="lbfgs",  # dense features → lbfgs is the right choice
                ),
            ),
        ]
    )


def threshold_sweep(y_true: np.ndarray, scores: np.ndarray) -> None:
    print("\n  threshold | precision | recall | passes through")
    print("  ----------+-----------+--------+---------------")
    for t in [0.10, 0.20, 0.30, 0.50, 0.70]:
        pred = (scores >= t).astype(int)
        tp = int(((pred == 1) & (y_true == 1)).sum())
        fp = int(((pred == 1) & (y_true == 0)).sum())
        fn = int(((pred == 0) & (y_true == 1)).sum())
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        through = (pred == 1).sum() / len(pred)
        print(f"   t={t:>4.2f}  |   {precision:>5.2f}   |  {recall:>5.2f} |    {through:>5.1%}")


def show_examples(pipe: Pipeline, texts: list[str], y: np.ndarray, n: int = 5) -> None:
    """With dense embeddings we can't list interpretable per-token features.
    Instead show the most-confident hits and misses on the training set."""
    scores = pipe.predict_proba(texts)[:, 1]
    order = np.argsort(scores)
    print(f"\n  most-confident NOT NEWS predictions (lowest scores):")
    for i in order[:n]:
        snip = texts[i].replace("\n", " ")[:100]
        print(f"    [{scores[i]:.3f}] (label={'news' if y[i] else 'not_news'}) {snip}")
    print(f"\n  most-confident NEWS predictions (highest scores):")
    for i in order[-n:][::-1]:
        snip = texts[i].replace("\n", " ")[:100]
        print(f"    [{scores[i]:.3f}] (label={'news' if y[i] else 'not_news'}) {snip}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", default="sentinel-labels.db")
    p.add_argument("--out", default="artifacts/classifier-v1.joblib")
    args = p.parse_args()

    db_path = Path(args.db).resolve()
    if not db_path.exists():
        raise SystemExit(f"db not found: {db_path}")

    texts, y = load_examples(db_path)
    n = len(texts)
    pos = sum(y)
    neg = n - pos
    print(f"loaded {n} labeled example(s):  news={pos}  not_news={neg}")
    if n < 4 or pos < 2 or neg < 2:
        raise SystemExit("need at least ~4 examples with both classes present")

    y_arr = np.array(y)

    # Encode once, reuse the matrix for both CV and final fit. Avoids
    # paying for ~150 LOO * encoding redundantly.
    print("\nencoding texts (first run downloads the encoder to HF cache)…")
    t0 = time.time()
    embedder = SentenceEmbedder()
    X = embedder.transform(texts)
    print(f"  encoded {len(texts)} texts → shape {X.shape} in {time.time()-t0:.1f}s")

    print("\nrunning leave-one-out cross-val on the head…")
    head = LogisticRegression(C=1.0, max_iter=1000, solver="lbfgs")
    loo_scores = cross_val_predict(
        head, X, y_arr, cv=LeaveOneOut(), method="predict_proba"
    )[:, 1]
    print(f"\nLOO threshold sweep (this is the honest number):")
    threshold_sweep(y_arr, loo_scores)

    print("\nfitting final pipeline on all data…")
    pipe = build_pipeline()
    pipe.fit(texts, y_arr)
    train_scores = pipe.predict_proba(texts)[:, 1]
    print(f"\ntraining threshold sweep (optimistic — model has seen these):")
    threshold_sweep(y_arr, train_scores)

    show_examples(pipe, texts, y_arr, n=5)

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(pipe, out_path)
    print(f"\nsaved model: {out_path}  ({out_path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
