import asyncio
import json
import sys

import edge_tts


async def main():
    payload_path = sys.argv[1] if len(sys.argv) > 1 else None
    if payload_path:
        with open(payload_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = json.load(sys.stdin)
    text = payload.get("text") or ""
    voice = payload.get("voice") or "zh-CN-XiaoxiaoNeural"
    rate = str(payload.get("rate", "+0%"))
    pitch = str(payload.get("pitch", "+0Hz"))
    output = payload.get("output") or ""
    if not text.strip() or not output:
        raise RuntimeError("missing text or output")
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await communicate.save(output)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:  # pragma: no cover
        print(f"EDGE_TTS_ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
