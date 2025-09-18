#!/usr/bin/env bash
set -o errexit  # stop on first error

echo "🚀 Starting Render build..."

# Install Python dependencies
pip install --upgrade pip
pip install -r requirements.txt

echo "✅ Build complete!"
