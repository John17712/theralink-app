#!/usr/bin/env bash
set -o errexit

# Install ffmpeg for pydub
apt-get update
apt-get install -y ffmpeg

# Install Python dependencies
pip install -r requirements.txt
