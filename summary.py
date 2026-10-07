"""Read a human summary (model, LoRAs, prompt, settings, size) out of an API-format prompt."""
import re

MODEL_CLASSES = {"UNETLoader", "UnetLoaderGGUF", "UnetLoaderGGUFAdvanced", "CheckpointLoaderSimple", "CheckpointLoader", "ImageOnlyCheckpointLoader"}
SAMPLER_CLASSES = {"KSampler", "KSamplerAdvanced"}
TEXT_KEYS = ("text", "prompt", "value", "text_g")
TEXT_CLASSES = {"CLIPTextEncode", "CLIPTextEncodeSDXL", "TextEncodeQwenImage21", "TextEncodeQwenImageEdit", "PrimitiveStringMultiline"}


def _base(name):
    name = str(name).replace("\\", "/").split("/")[-1]
    return re.sub(r"\.(safetensors|gguf|ckpt|pt|pth|bin)$", "", name, flags=re.I)


def _text(node):
    inputs = (node or {}).get("inputs", {})
    for key in TEXT_KEYS:
        val = inputs.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _linked(prompt, node, key):
    link = (node or {}).get("inputs", {}).get(key)
    return prompt.get(str(link[0])) if isinstance(link, list) and link else None


def _linked_text(prompt, node, key):
    """Text behind a sampler's positive/negative input. Encoders that output both (e.g. TextEncodeQwenImage21)
    keep the negative in their own widget, so pick it by the output slot the link comes from."""
    link = (node or {}).get("inputs", {}).get(key)
    src = _linked(prompt, node, key)
    if src and isinstance(link, list) and len(link) > 1 and link[1] == 1 and "negative_prompt" in src.get("inputs", {}):
        val = src["inputs"]["negative_prompt"]
        return val.strip() if isinstance(val, str) else ""
    return _text(src)


def _value(node, key):
    """A widget value, or None when the input is wired to another node (e.g. a Quality Preset)."""
    val = (node or {}).get("inputs", {}).get(key)
    return None if isinstance(val, list) else val


def _quality(prompt):
    for node in prompt.values():
        if str(node.get("class_type", "")).startswith("QualityPreset"):
            return node.get("inputs", {}).get("quality")
    return None


def summarize(prompt, extra=None):
    prompt = prompt or {}
    nodes = list(prompt.values())
    out = {"workflow_name": str((extra or {}).get("qcm_workflow_name") or ""), "model": "", "loras": [],
           "positive": "", "negative": "", "settings": "", "size": ""}

    for n in nodes:
        if n.get("class_type") in MODEL_CLASSES:
            name = n.get("inputs", {}).get("unet_name") or n.get("inputs", {}).get("ckpt_name")
            if isinstance(name, str):
                out["model"] = _base(name)
                break

    for n in nodes:
        ct, inputs = str(n.get("class_type", "")), n.get("inputs", {})
        if ct.startswith("Power Lora Loader"):
            for key, v in inputs.items():
                if key.lower().startswith("lora_") and isinstance(v, dict) and v.get("on") and v.get("lora"):
                    out["loras"].append({"name": _base(v["lora"]), "strength": v.get("strength")})
        elif ct.startswith("LoraLoader") and isinstance(inputs.get("lora_name"), str):
            out["loras"].append({"name": _base(inputs["lora_name"]), "strength": inputs.get("strength_model", inputs.get("strength"))})

    samplers = [n for n in nodes if n.get("class_type") in SAMPLER_CLASSES]
    k = samplers[0] if samplers else None
    if k:
        out["positive"] = _linked_text(prompt, k, "positive")
        out["negative"] = _linked_text(prompt, k, "negative")
    if not out["positive"]:
        for n in nodes:
            title = str(n.get("_meta", {}).get("title", "")).lower()
            if n.get("class_type") in TEXT_CLASSES and "negative" not in title and _text(n):
                out["positive"] = _text(n)
                break

    parts = []
    quality = _quality(prompt)
    if quality:
        parts.append(f"Quality: {quality}")
    if k:
        steps, cfg = _value(k, "steps"), _value(k, "cfg")
        if steps is not None:
            parts.append(f"{steps} steps")
        if cfg is not None:
            parts.append(f"CFG {cfg}")
        if isinstance(k["inputs"].get("sampler_name"), str):
            parts.append(k["inputs"]["sampler_name"])
        seed = k["inputs"].get("seed", k["inputs"].get("noise_seed"))
        if isinstance(seed, int):
            parts.append(f"seed {seed}")
    if len(samplers) > 1:
        parts.append("+hires pass")
    out["settings"] = " · ".join(parts)

    size = []
    for n in nodes:
        ct, inputs = n.get("class_type"), n.get("inputs", {})
        if ct == "ResolutionSelector":
            size.append(str(inputs.get("aspect_ratio", "")).split(" ")[0])
            if not isinstance(inputs.get("megapixels"), list):
                size.append(f"{inputs.get('megapixels')} MP")
        elif ct in ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyHunyuanImageLatent") and isinstance(inputs.get("width"), int):
            size.append(f"{inputs['width']}×{inputs['height']}")
        if ct and ct.startswith("EmptyLatent") and isinstance(inputs.get("batch_size"), int) and inputs["batch_size"] > 1:
            size.append(f"×{inputs['batch_size']} images")
    out["size"] = " · ".join(dict.fromkeys(s for s in size if s))
    return out
