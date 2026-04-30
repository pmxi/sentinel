"""Sklearn-compatible wrapper around a sentence-transformer encoder.

Used by tools/train_classifier.py and tools/predict.py. The wrapper is
lazy: the (large) encoder is only loaded on first .transform() call,
and __getstate__ explicitly drops it so the joblib pickle stays small —
the encoder is reloaded from the HuggingFace cache after deserialization.
"""

from __future__ import annotations

from typing import Iterable, Optional

import numpy as np
from sklearn.base import BaseEstimator, TransformerMixin


# EmbeddingGemma-300M in bf16 with the Classification prompt template:
# ~3× faster than Qwen3-Embedding-0.6B on MPS *and* better LOO P/R on our
# label set (see tools/compare_encoders.py). The prompt prepends a short
# "task: classification | query: " prefix so the model emits a vector
# tuned for downstream classification rather than retrieval.
DEFAULT_MODEL = "google/embeddinggemma-300m"
DEFAULT_DTYPE = "bfloat16"
DEFAULT_PROMPT_NAME = "Classification"


class SentenceEmbedder(BaseEstimator, TransformerMixin):
    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        batch_size: int = 32,
        normalize: bool = True,
        dtype: Optional[str] = DEFAULT_DTYPE,
        prompt_name: Optional[str] = DEFAULT_PROMPT_NAME,
    ):
        self.model_name = model_name
        self.batch_size = batch_size
        self.normalize = normalize
        self.dtype = dtype
        self.prompt_name = prompt_name

    def _ensure_model(self):
        if not hasattr(self, "_model") or self._model is None:
            import torch
            from sentence_transformers import SentenceTransformer
            kwargs = {}
            if self.dtype:
                kwargs["model_kwargs"] = {"torch_dtype": getattr(torch, self.dtype)}
            self._model = SentenceTransformer(self.model_name, **kwargs)
        return self._model

    def fit(self, X, y=None):
        # No-op: encoder is frozen.
        return self

    def transform(self, X: Iterable[str]) -> np.ndarray:
        model = self._ensure_model()
        return model.encode(
            list(X),
            batch_size=self.batch_size,
            normalize_embeddings=self.normalize,
            prompt_name=self.prompt_name,
            show_progress_bar=False,
            convert_to_numpy=True,
        )

    def __getstate__(self):
        state = self.__dict__.copy()
        state.pop("_model", None)  # never pickle the encoder; reload on demand
        return state
