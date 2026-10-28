#!/usr/bin/env python3
"""入站语音转写：把一段 wav 转成中文文本，只把文本打到 stdout。

由 `src/voice-asr.js` 调用（也能手动跑）：

    ASR_BACKEND=sensevoice ASR_MODEL_DIR=~/apps/asr/models/sense-voice \
      venv/bin/python scripts/asr-transcribe.py /tmp/voice.wav

两个后端，按可用性挑：

- **sensevoice**（默认优先）：sherpa-onnx + SenseVoice-small。中文准确率高、CPU 实时，
  模型约 230 MB。输入 wav 必须是 16k 单声道（调用方已用服务端转码 + 本地重采样保证）。
- **whisper**：faster-whisper（CTranslate2，int8）。模型目录是整个 faster-whisper 模型
  （`model.bin` + `tokenizer.json` + `vocabulary.txt`）。中文比 SenseVoice 弱，胜在通用。

约定：
- stdout 只有转写文本（可能为空），诊断走 stderr；
- 退出码 0 = 跑完了（文本为空不算失败）；出错非 0，调用方降级成 `[语音]`。
"""
import os
import re
import sys
import time

TAG_RE = re.compile(r"<\|[^|]*\|>")


def sensevoice_transcribe(wav: str, model_dir: str) -> str:
    import sherpa_onnx

    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=os.path.join(model_dir, "model.onnx"),
        tokens=os.path.join(model_dir, "tokens.txt"),
        use_itn=True,
        language="zh",
        num_threads=max(1, min(4, (os.cpu_count() or 2) // 2)),
    )
    samples, sample_rate = sherpa_onnx.read_wave(wav)
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    recognizer.decode_stream(stream)
    text = getattr(stream.result, "text", "") or ""
    return TAG_RE.sub("", text).strip()


def whisper_transcribe(wav: str) -> str:
    from faster_whisper import WhisperModel

    model_path = os.environ.get("ASR_MODEL") or "small"
    model_dir = os.environ.get("ASR_MODEL_DIR") or None
    compute_type = os.environ.get("ASR_COMPUTE", "int8")
    language = os.environ.get("ASR_LANGUAGE", "zh")
    model = WhisperModel(model_path, device="cpu", compute_type=compute_type, download_root=model_dir)
    segments, _info = model.transcribe(
        wav,
        language=language,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return "".join(seg.text for seg in segments).strip()


def main() -> int:
    if len(sys.argv) < 2:
        print("asr: usage: asr-transcribe.py <wav-path>", file=sys.stderr)
        return 2
    wav = sys.argv[1]
    if not os.path.isfile(wav):
        print(f"asr: no such file: {wav}", file=sys.stderr)
        return 2

    backend = (os.environ.get("ASR_BACKEND") or "").strip().lower()
    model_dir = os.environ.get("ASR_MODEL_DIR") or ""
    if not backend:
        backend = "sensevoice" if model_dir and os.path.isfile(os.path.join(model_dir, "model.onnx")) else "whisper"

    started = time.time()
    try:
        if backend == "sensevoice":
            text = sensevoice_transcribe(wav, model_dir)
        else:
            text = whisper_transcribe(wav)
    except Exception as exc:  # noqa: BLE001 - 任何后端错误都降级
        print(f"asr: {backend} 转写失败: {exc}", file=sys.stderr)
        return 4

    print(text)
    print(f"asr: backend={backend} {time.time() - started:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
