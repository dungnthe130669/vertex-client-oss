-- In-app provider keys (Settings > Providers). One row per (base, provider): AES-256-GCM ciphertext + iv (base64), never plaintext.
-- `base` is the BaseScope (who), never a space-qualified string. Needs the Worker secret KEY_ENC_SECRET to write or read; without it
-- the Worker-secret path (PROVIDER_KEY_<NAME>) keeps working unchanged. Additive.
CREATE TABLE IF NOT EXISTS provider_user_keys (
  base TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  origin TEXT NOT NULL, -- scheme://host[:port] of the provider baseUrl the key was saved for (also in the AAD): a key is never sent anywhere else
  ct TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (base, provider_id)
);
