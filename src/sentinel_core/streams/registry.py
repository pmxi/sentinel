"""Stream-type registry.

Maps the `stream_type` string stored in the `streams` table to the
(Stream class, config class) pair that knows how to build and validate
accounts of that type. New stream types register themselves here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Dict, Type

from pydantic import BaseModel

from sentinel_core.streams.base import Stream

if TYPE_CHECKING:
    from sentinel_core.database import EmailDatabase


@dataclass(frozen=True)
class StreamSpec:
    """Describes how to instantiate and configure one stream type."""

    stream_type: str
    label: str                       # human-readable (for the web UI)
    config_cls: Type[BaseModel]
    stream_cls: Type[Stream]


_REGISTRY: Dict[str, StreamSpec] = {}


def register(spec: StreamSpec) -> None:
    if spec.stream_type in _REGISTRY:
        raise ValueError(f"Stream type {spec.stream_type!r} already registered")
    _REGISTRY[spec.stream_type] = spec


def get(stream_type: str) -> StreamSpec:
    if stream_type not in _REGISTRY:
        raise KeyError(f"Unknown stream type: {stream_type!r}")
    return _REGISTRY[stream_type]


def all_specs() -> Dict[str, StreamSpec]:
    return dict(_REGISTRY)


def build_stream(
    stream_type: str,
    name: str,
    config_json: str,
    *,
    db: "EmailDatabase",
    user_id: int,
    extra: Dict[str, Any] | None = None,
) -> Stream:
    """Instantiate a stream from a db row."""
    spec = get(stream_type)
    config = spec.config_cls.model_validate_json(config_json)
    return spec.stream_cls(
        name=name,
        config=config,
        db=db,
        user_id=user_id,
        **(extra or {}),
    )


def _register_builtins() -> None:
    """Register the shipped stream types. Import-order-safe: we delay the
    imports until first call to avoid circular refs at module load."""
    if _REGISTRY:
        return
    from sentinel_core.streams.email.stream import EmailStream
    from sentinel_core.streams.email.mail_config import MailAccountConfig
    from sentinel_core.streams.rss.stream import RSSStream
    from sentinel_core.streams.rss.config import RSSStreamConfig

    register(
        StreamSpec(
            stream_type="email",
            label="Email",
            config_cls=MailAccountConfig,
            stream_cls=EmailStream,
        )
    )
    register(
        StreamSpec(
            stream_type="rss",
            label="RSS / Atom feed",
            config_cls=RSSStreamConfig,
            stream_cls=RSSStream,
        )
    )


def ensure_loaded() -> None:
    """Call before looking up specs; idempotent."""
    _register_builtins()
