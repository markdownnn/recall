#!/usr/bin/env python3
# scripts/quantize-granite.py
# SAFE first-party artifact builder for the bundled granite embedding model.
#
# Exports IBM's OFFICIAL fp32 model to ONNX, then dynamic-int8-quantizes it into a
# transformers.js-standard onnx/model_quantized.onnx. Run by a maintainer or CI; the outputs
# (config.json, tokenizer_config.json, tokenizer.json, onnx/model_quantized.onnx) are then
# COMMITTED into the repo under public/models/granite/ and VERIFIED at build by
# scripts/fetch-model.mjs (SHA-256, no network) - NOT published to an external host.
#
#   pip install "optimum[onnxruntime]" "transformers"
#   python scripts/quantize-granite.py
#
# Pinned source: IBM official repo at a fixed revision (NOT a community quant).
import hashlib
import os
from optimum.onnxruntime import ORTModelForFeatureExtraction, ORTQuantizer
from optimum.onnxruntime.configuration import AutoQuantizationConfig
from transformers import AutoTokenizer

MODEL_ID = "ibm-granite/granite-embedding-107m-multilingual"
REVISION = os.environ.get("GRANITE_REVISION", "main")  # PIN to a commit SHA before publishing.
OUT = os.environ.get("GRANITE_OUT", "dist-model/granite")
ONNX_DIR = os.path.join(OUT, "onnx")
os.makedirs(ONNX_DIR, exist_ok=True)

# 1. Export the official fp32 model to ONNX (this downloads IBM's weights, not a quant).
print(f"[quantize-granite] exporting {MODEL_ID}@{REVISION} fp32 -> ONNX ...", flush=True)
model = ORTModelForFeatureExtraction.from_pretrained(MODEL_ID, revision=REVISION, export=True)
model.save_pretrained(OUT)

# 1b. (I5) Save a FAST tokenizer so save_pretrained emits tokenizer.json (transformers.js
#     loads ONLY tokenizer.json; a slow/SentencePiece-only save would have no tokenizer.json
#     and the model would fail to tokenize in the browser).
print("[quantize-granite] saving FAST tokenizer ...", flush=True)
AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, use_fast=True).save_pretrained(OUT)
tok_json = os.path.join(OUT, "tokenizer.json")
assert os.path.exists(tok_json), (
    "tokenizer.json was NOT written - the fast tokenizer is required for transformers.js. "
    "Check use_fast=True and that a fast tokenizer is available for this model."
)

# 2. Dynamic int8 quantization (avx2 dynamic = CPU-portable int8, the q8 transformers.js loads).
print("[quantize-granite] dynamic int8 quantization ...", flush=True)
quantizer = ORTQuantizer.from_pretrained(OUT, file_name="model.onnx")
qconfig = AutoQuantizationConfig.avx2(is_static=False, per_channel=False)
quantizer.quantize(save_dir=OUT, quantization_config=qconfig)

# 3. Normalize the quantized file name to the transformers.js convention.
produced = os.path.join(OUT, "model_quantized.onnx")
target = os.path.join(ONNX_DIR, "model_quantized.onnx")
if os.path.exists(produced):
    os.replace(produced, target)
assert os.path.exists(target), "model_quantized.onnx was not produced - check the quantize step."

# 4. Print SHA-256 of every file Task 6 bundles, to paste into EXPECTED_HASHES.
print("[quantize-granite] outputs (paste into EXPECTED_HASHES):", flush=True)
for rel in ["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quantized.onnx"]:
    path = os.path.join(OUT, rel)
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    size_mb = os.path.getsize(path) / 1e6
    print(f"{rel:34s} {digest}  ({size_mb:.1f} MB)", flush=True)
