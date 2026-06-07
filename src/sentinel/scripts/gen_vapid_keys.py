"""Generate a VAPID keypair for Web Push and print the three .env values.

    python -m sentinel.scripts.gen_vapid_keys

Copy the printed lines into your .env. The keypair is the server's identity to
the browser push services; generate it once and keep the private key secret.
Rotating it invalidates every existing subscription (users must re-enable).
"""

from __future__ import annotations

import base64

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid01


def main() -> None:
    vapid = Vapid01()
    vapid.generate_keys()

    # Browser-side applicationServerKey: the raw uncompressed EC point, base64url
    # without padding (what pushManager.subscribe expects).
    public_raw = vapid.public_key.public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    public_key = base64.urlsafe_b64encode(public_raw).rstrip(b"=").decode()

    # Server-side private key: PKCS8 PEM, base64-wrapped so it fits on one .env
    # line. The notifier reverses this with base64.b64decode + Vapid01.from_pem.
    private_pem = vapid.private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    private_key = base64.b64encode(private_pem).decode()

    print("# Add these to your .env (VAPID_SUBJECT must be a mailto: or https: you control):")
    print(f"VAPID_PUBLIC_KEY={public_key}")
    print(f"VAPID_PRIVATE_KEY={private_key}")
    print("VAPID_SUBJECT=mailto:you@example.com")


if __name__ == "__main__":
    main()
