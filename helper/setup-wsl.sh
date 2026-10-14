#!/usr/bin/env bash
# Sets up the Songbook helper with GPU analysis in WSL2 Ubuntu (helper/README.md).
# Run inside Ubuntu, from the repo:  bash helper/setup-wsl.sh
# It installs ffmpeg and build tools (asks for your Ubuntu password once), uv,
# a Python 3.12 venv in ~/.venvs/songbook, PyTorch for CUDA 12.8, the models'
# libraries, and ChordMini's code and checkpoints in ~/src/ChordMini-model.
# The models themselves (Demucs, beat_this, Whisper: about 4 GB) download on
# the first analysis. Safe to run again.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHORDMINI_COMMIT=aa6e3a8d7b017f082fd2aaff9329d5c26af49c03

if ! command -v ffmpeg >/dev/null; then
  sudo apt-get update -q
  sudo apt-get install -yq ffmpeg python3-venv python3-dev build-essential git curl libsndfile1
fi
if ! command -v uv >/dev/null && [ ! -x ~/.local/bin/uv ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

[ -d ~/.venvs/songbook ] || uv venv -p 3.12 ~/.venvs/songbook
# shellcheck disable=SC1090
source ~/.venvs/songbook/bin/activate
uv pip install torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128
uv pip install -r "$HERE/requirements-gpu.txt"

mkdir -p ~/src
if [ ! -d ~/src/ChordMini-model ]; then
  git clone https://github.com/ptnghia-j/ChordMini.git ~/src/ChordMini-model
fi
git -C ~/src/ChordMini-model fetch -q origin "$CHORDMINI_COMMIT" || true
git -C ~/src/ChordMini-model checkout -q "$CHORDMINI_COMMIT"

python - <<'PY'
import torch
print("PyTorch", torch.__version__, "| GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none (analysis will be slow)")
PY
echo "Done. Start the helper with:  bash helper/run-wsl.sh"
