#!/bin/sh
set -eu
revision=47fbd8f0f6ee632dc91500ece877a40b64014941
mkdir -p work/open-terminal-src
curl -4 -fsSL "https://codeload.github.com/open-webui/open-terminal/tar.gz/$revision" -o work/open-terminal.tar.gz
tar -xzf work/open-terminal.tar.gz --strip-components=1 -C work/open-terminal-src
docker build -f work/open-terminal-src/Dockerfile.slim -t runoza/open-terminal:stage0-47fbd8f work/open-terminal-src
