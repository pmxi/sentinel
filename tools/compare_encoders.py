"""Side-by-side comparison: train the LogReg head on different encoders.

For each encoder, encode the labeled corpus, run LOO cross-val on the head,
and report the threshold sweep + encoding throughput. Caches the encoded
matrices to artifacts/ so re-runs are fast.

    uv run python tools/compare_encoders.py

Add encoders by editing ENCODERS at the bottom.
"""

from __future__ import annotations

import argparse
import hashlib
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
from embedder import SentenceEmbedder
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import LeaveOneOut, cross_val_predict


@dataclass
class EncoderSpec:
    name: str
    model_id: str
    batch_size: int = 32
    # Some models require trust_remote_code / a specific prompt — kept
    # explicit so the comparison is honest about config differences.


def load_examples(db_path: Path) -> tuple[list[str], np.ndarray]:
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
    y = np.array([1 if r["label"] == "news" else 0 for r in rows])
    return texts, y


def cache_path(model_id: str, texts: list[str]) -> Path:
    h = hashlib.sha1(("\x1f".join(texts)).encode("utf-8")).hexdigest()[:10]
    safe = model_id.replace("/", "__")
    return Path("artifacts") / f"emb_cache__{safe}__{h}.npy"


def encode_with_cache(spec: EncoderSpec, texts: list[str]) -> tuple[np.ndarray, float]:
    cp = cache_path(spec.model_id, texts)
    if cp.exists():
        X = np.load(cp)
        print(f"  loaded cached embeddings: {cp.name}  shape={X.shape}")
        return X, 0.0
    print(f"  encoding {len(texts)} texts with {spec.model_id} (batch_size={spec.batch_size})…")
    embedder = SentenceEmbedder(model_name=spec.model_id, batch_size=spec.batch_size)
    t0 = time.time()
    X = embedder.transform(texts)
    elapsed = time.time() - t0
    cp.parent.mkdir(parents=True, exist_ok=True)
    np.save(cp, X)
    print(f"  encoded in {elapsed:.1f}s  ({len(texts)/elapsed:.1f} texts/s)  shape={X.shape}")
    return X, elapsed


def threshold_sweep(y_true: np.ndarray, scores: np.ndarray) -> dict:
    out = {}
    print("    threshold | precision | recall | passes through")
    print("    ----------+-----------+--------+---------------")
    for t in [0.10, 0.20, 0.30, 0.50, 0.70]:
        pred = (scores >= t).astype(int)
        tp = int(((pred == 1) & (y_true == 1)).sum())
        fp = int(((pred == 1) & (y_true == 0)).sum())
        fn = int(((pred == 0) & (y_true == 1)).sum())
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        through = (pred == 1).sum() / len(pred)
        print(f"     t={t:>4.2f}  |   {precision:>5.2f}   |  {recall:>5.2f} |    {through:>5.1%}")
        out[t] = (precision, recall, through)
    return out


def evaluate(spec: EncoderSpec, texts: list[str], y: np.ndarray) -> dict:
    print(f"\n=== {spec.name}  ({spec.model_id}) ===")
    X, encode_time = encode_with_cache(spec, texts)

    print("  running LOO cross-val on logistic-regression head…")
    head = LogisticRegression(C=1.0, max_iter=1000, solver="lbfgs")
    t0 = time.time()
    loo_scores = cross_val_predict(
        head, X, y, cv=LeaveOneOut(), method="predict_proba"
    )[:, 1]
    cv_time = time.time() - t0
    print(f"  LOO took {cv_time:.1f}s")

    print(f"\n  LOO threshold sweep:")
    sweeps = threshold_sweep(y, loo_scores)
    return {
        "name": spec.name,
        "model_id": spec.model_id,
        "dim": int(X.shape[1]),
        "encode_time": encode_time,
        "throughput": (len(texts) / encode_time) if encode_time > 0 else None,
        "sweeps": sweeps,
    }


def summary(results: list[dict]) -> None:
    print("\n" + "=" * 72)
    print("SUMMARY  (LOO precision/recall at chosen threshold; throughput on this CPU)")
    print("=" * 72)
    print(f"  {'name':<28} {'dim':>5}  {'P@.20':>6}  {'R@.20':>6}  {'P@.30':>6}  {'R@.30':>6}  {'enc/s':>7}")
    for r in results:
        p20, r20, _ = r["sweeps"][0.20]
        p30, r30, _ = r["sweeps"][0.30]
        thr = f"{r['throughput']:.1f}" if r["throughput"] else " cached"
        print(f"  {r['name']:<28} {r['dim']:>5}  {p20:>6.2f}  {r20:>6.2f}  {p30:>6.2f}  {r30:>6.2f}  {thr:>7}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", default="sentinel-labels.db")
    p.add_argument(
        "--only",
        default=None,
        help="comma-separated subset of encoder names to run",
    )
    args = p.parse_args()

    encoders = [
        EncoderSpec(name="qwen3-0.6b",       model_id="Qwen/Qwen3-Embedding-0.6B", batch_size=32),
        EncoderSpec(name="embeddinggemma",   model_id="google/embeddinggemma-300m", batch_size=64),
    ]
    if args.only:
        keep = {s.strip() for s in args.only.split(",")}
        encoders = [e for e in encoders if e.name in keep]

    db_path = Path(args.db).resolve()
    texts, y = load_examples(db_path)
    print(f"loaded {len(texts)} labels: news={int(y.sum())}  not_news={int((1-y).sum())}")

    results = [evaluate(spec, texts, y) for spec in encoders]
    summary(results)


if __name__ == "__main__":
    main()
