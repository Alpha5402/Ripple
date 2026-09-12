"""Small local/cloud HTTP adapter for the pinned official WeMM implementation.

No filesystem paths or remote media URLs are accepted in inference requests.
Document encoding uses the model's official chat-template + final-token pooling.
"""
import argparse
import base64
import hmac
import io
import json
import math
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError

MODEL = "tencent/WeMM-Embedding-2B"
REVISION = "bbd6cd4bf52cfc6716f752a2df80b2706720bd95"
runtime = {}
lock = threading.Lock()
args = None


def load_model():
    import torch
    from transformers import AutoModel, AutoProcessor

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    if device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS is unavailable on this runtime")
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable on this runtime")
    dtype = torch.bfloat16 if device != "cpu" else torch.float32
    print(f"Loading {MODEL}@{REVISION} on {device}, {dtype}", flush=True)
    processor = AutoProcessor.from_pretrained(args.model_dir, trust_remote_code=True, local_files_only=True, use_fast=True)
    processor.image_processor.size = {"shortest_edge": min(65536, args.image_pixels), "longest_edge": args.image_pixels}
    model = AutoModel.from_pretrained(
        args.model_dir, trust_remote_code=True, local_files_only=True,
        dtype=dtype, device_map=device, attn_implementation="eager",
    ).eval()
    representation = f"wemm-embedding-token-v1/transformers-5.2.0/{str(dtype).split('.')[-1]}/fast-image-pixels-{args.image_pixels}"
    runtime.update({"torch": torch, "processor": processor, "model": model, "device": device, "descriptor": {
        "model": MODEL, "revision": REVISION, "dimensions": 2048, "normalized": True,
        "modalities": ["text", "image"], "maxInputTokens": args.max_tokens,
        "representation": representation, "tokenizer": f"wemm-tokenizer:{REVISION}",
    }})
    print(json.dumps({"status": "ready", "device": device, "model": MODEL, "dimensions": 2048}), flush=True)


@asynccontextmanager
async def lifespan(app):
    load_model()
    yield
    runtime.clear()


app = FastAPI(title="Ripple WeMM Embedding", lifespan=lifespan)


@app.middleware("http")
async def guard(request: Request, call_next):
    key = os.environ.get("RIPPLE_EMBEDDING_API_KEY")
    if key and not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {key}"):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > 16 * 1024 * 1024):
        return JSONResponse({"error": "request-too-large"}, status_code=413)
    return await call_next(request)


# Explicit UI origins only; do not expose a local inference service to arbitrary websites.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.environ.get(
        "RIPPLE_EMBEDDING_ALLOWED_ORIGINS",
        "http://127.0.0.1:4320,http://127.0.0.1:4321,http://localhost:4320,http://localhost:4321,https://alpha5402.github.io",
    ).split(",") if origin.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


def batch(body):
    if not isinstance(body, dict) or body.get("model") != MODEL:
        raise HTTPException(400, "model-mismatch")
    inputs = body.get("input")
    if isinstance(inputs, str):
        inputs = [inputs]
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 8:
        raise HTTPException(400, "invalid-batch-size")
    result = []
    for item in inputs:
        if isinstance(item, str):
            item = {"text": item, "images": []}
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or len(item["text"]) > 500_000:
            raise HTTPException(400, "invalid-text")
        if not isinstance(item.get("images", []), list) or len(item.get("images", [])) > 4:
            raise HTTPException(400, "invalid-images")
        result.append(item)
    return result


def decode_image(item):
    uri = item.get("dataUrl", "") if isinstance(item, dict) else ""
    allowed = ("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,")
    if not isinstance(uri, str) or not uri.startswith(allowed) or len(uri) > 12 * 1024 * 1024:
        raise HTTPException(400, "invalid-image-data")
    try:
        image = Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1], validate=True)))
        if image.width * image.height > 40_000_000:
            raise HTTPException(413, "image-too-large")
        image.seek(0)
        image = image.convert("RGB")
        ratio = min(1, math.sqrt(args.image_pixels / (image.width * image.height)))
        if ratio < 1:
            image = image.resize((max(1, int(image.width * ratio)), max(1, int(image.height * ratio))))
        return image
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError):
        raise HTTPException(400, "invalid-image-data") from None


def prepare(item):
    images = [decode_image(image) for image in item.get("images", [])]
    content = [{"type": "image", "image": image} for image in images]
    content.append({"type": "text", "text": item["text"]})
    processor = runtime["processor"]
    text = processor.apply_chat_template([{"role": "user", "content": content}], tokenize=False, add_generation_prompt=False)
    inputs = processor(text=[text], images=images or None, return_tensors="pt", padding=False, truncation=False)
    # The official tokenizer post-processor appends <embedding>; do not append it a second time.
    if int(inputs["input_ids"][0, -1]) != processor.tokenizer.convert_tokens_to_ids("<embedding>"):
        raise HTTPException(500, "embedding-template-mismatch")
    return inputs


@app.get("/health")
def health():
    return {"status": "ready", "device": runtime["device"], "model": MODEL, "revision": REVISION}


@app.get("/v1/model-info")
def model_info():
    return runtime["descriptor"]


@app.post("/v1/tokenize")
def tokenize(body: dict):
    with lock:
        counts = [int(prepare(item)["attention_mask"].sum()) for item in batch(body)]
    return {"counts": counts, "revision": REVISION}


@app.post("/v1/embeddings")
def embeddings(body: dict):
    items = batch(body)
    data = []
    tokens = 0
    # Encode separately: the official final-token pooling assumes right padding.
    # This also keeps multimodal batches within laptop memory limits.
    with lock:
        for index, item in enumerate(items):
            inputs = prepare(item)
            count = int(inputs["attention_mask"].sum())
            if count > args.max_tokens:
                raise HTTPException(413, "token-budget-exceeded; input was not truncated")
            tokens += count
            try:
                inputs = inputs.to(runtime["device"])
                with runtime["torch"].inference_mode():
                    vector = runtime["model"].embedding(**inputs, use_cache=False)[0].float().cpu()
                if not runtime["torch"].isfinite(vector).all() or vector.numel() != 2048:
                    raise RuntimeError("non-finite-or-invalid-vector")
                # Renormalize in FP32 to make the API's normalization guarantee explicit.
                vector = runtime["torch"].nn.functional.normalize(vector, dim=0)
                data.append({"index": index, "embedding": vector.tolist()})
            except RuntimeError as error:
                print(f"Inference failed: {type(error).__name__}: {error}", flush=True)
                raise HTTPException(500, "inference-failed; inspect local server logs") from None
    return {"object": "list", "model": MODEL, "revision": REVISION,
            "representation": runtime["descriptor"]["representation"], "data": data,
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", choices=["auto", "mps", "cuda", "cpu"], default="auto")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--image-pixels", type=int, default=65536)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1") and not os.environ.get("RIPPLE_EMBEDDING_API_KEY"):
        parser.error("Set RIPPLE_EMBEDDING_API_KEY before binding a non-loopback address")
    if not 32 <= args.max_tokens <= 32768 or not 4096 <= args.image_pixels <= 1048576:
        parser.error("Invalid token or image-pixel budget")
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
