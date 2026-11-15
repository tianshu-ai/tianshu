#!/usr/bin/env python3
"""Clef-flash decision sidecar — HTTP server exposing /v1/systemone.

Loads the model once at startup, then serves Jev/SystemOne-compatible
requests. Designed to be started as a sidecar process by tianshu.

Usage:
  python3 clef-server.py [--port 8710] [--device mps|cuda|cpu]

Env:
  CLEF_MODEL_DIR  — path to clef-flash model directory
  CLEF_PORT       — server port (default 8710)
  CLEF_DEVICE     — torch device (default: auto-detect mps > cuda > cpu)
"""

import argparse
import json
import os
import sys
import time
import glob
from http.server import HTTPServer, BaseHTTPRequestHandler

import torch


def find_model_path():
    """Find the clef-flash model in common locations."""
    candidates = [
        os.environ.get("CLEF_MODEL_DIR", ""),
        os.path.join(os.path.dirname(__file__), "models", "models", "Cloudflare--clef-flash", "snapshots", "master"),
        os.path.expanduser("~/.cache/huggingface/hub/models--Cloudflare--clef-flash/snapshots"),
    ]
    for c in candidates:
        if not c:
            continue
        if os.path.isfile(os.path.join(c, "config.json")):
            return c
        # HuggingFace cache has hash-named snapshot dirs
        if os.path.isdir(c):
            snaps = sorted(glob.glob(os.path.join(c, "*")), key=os.path.getmtime, reverse=True)
            for s in snaps:
                if os.path.isfile(os.path.join(s, "config.json")):
                    return s
    return None


def main():
    parser = argparse.ArgumentParser(description="Clef-flash decision sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("CLEF_PORT", "8710")))
    parser.add_argument("--device", type=str, default=os.environ.get("CLEF_DEVICE", ""))
    args = parser.parse_args()

    # Detect device
    if args.device:
        device = args.device
    elif torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"

    print(f"[clef-server] device: {device}")

    # Find model
    model_path = find_model_path()
    if not model_path:
        print("[clef-server] ERROR: clef-flash model not found. Set CLEF_MODEL_DIR or download it first.")
        sys.exit(1)
    print(f"[clef-server] model: {model_path}")

    # Load model
    print("[clef-server] loading model...")
    t0 = time.time()
    sys.path.insert(0, model_path)
    from joint_schema_model import systemone, load_release_model
    model, processor = load_release_model(model_path, device=device)
    print(f"[clef-server] model loaded in {time.time()-t0:.1f}s")

    # Warm up with a dummy request
    print("[clef-server] warming up...")
    t0 = time.time()
    systemone(model, processor, {
        "model": "clef-flash",
        "state": "warmup",
        "questions": {"q": {"type": "noul", "instructions": "Is this a test?"}},
    })
    print(f"[clef-server] warmup done in {time.time()-t0:.1f}s")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/v1/systemone":
                self.send_error(404, "Not found")
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length)) if length > 0 else {}
                # Log request
                state_preview = str(body.get("state", ""))[:80]
                q_keys = list(body.get("questions", {}).keys())
                criteria_keys = []
                for q in body.get("questions", {}).values():
                    criteria_keys.extend(list((q.get("criteria") or {}).keys()))
                print(f"[clef] REQ state=\"{state_preview}\" questions={q_keys} criteria={criteria_keys}", flush=True)
                t0 = time.time()
                result = systemone(model, processor, body)
                ms = (time.time() - t0) * 1000
                result["_latencyMs"] = round(ms, 1)
                # Log response
                for qid, ans in result.get("answers", {}).items():
                    if ans.get("type") == "choice":
                        probs = ", ".join(f"{k}={v*100:.1f}%" for k, v in ans.get("probabilities", {}).items())
                        print(f"[clef] RES {qid}={ans['choice']} conf={ans.get('confidence',0)*100:.1f}% [{probs}] {ms:.0f}ms", flush=True)
                    elif ans.get("type") == "noul":
                        print(f"[clef] RES {qid}={ans.get('probability',0)*100:.1f}% {ms:.0f}ms", flush=True)
                    else:
                        print(f"[clef] RES {qid}={ans} {ms:.0f}ms", flush=True)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result, ensure_ascii=False).encode())
            except Exception as e:
                print(f"[clef] ERR {e}", flush=True)
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())

        def do_GET(self):
            if self.path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok", "device": device, "model": "clef-flash"}).encode())
            else:
                self.send_error(404)

        def log_message(self, format, *args):
            super().log_message(format, *args)

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[clef-server] listening on http://127.0.0.1:{args.port}")
    print(f"[clef-server] POST /v1/systemone — Jev/SystemOne compatible")
    print(f"[clef-server] GET  /health — health check")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[clef-server] shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
