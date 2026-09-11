"""Download only the pinned official artifacts used by the WeMM runner."""
import argparse
from huggingface_hub import snapshot_download

MODEL = "tencent/WeMM-Embedding-2B"
REVISION = "bbd6cd4bf52cfc6716f752a2df80b2706720bd95"

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    path = snapshot_download(
        repo_id=MODEL,
        revision=REVISION,
        local_dir=args.directory,
        allow_patterns=["*.json", "*.jinja", "*.safetensors", "modeling_wemm_embedding.py", "LICENSE"],
        max_workers=2,
    )
    print(f"WeMM ready on disk: {path}", flush=True)
