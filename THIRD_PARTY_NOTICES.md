# Third-Party Notices

VSC AgentBridge incorporates portions derived from [Microsoft Visual Studio Code](https://github.com/microsoft/vscode). Those portions are provided under the following MIT License:

## Microsoft Visual Studio Code

MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Photon (@silvia-odwyer/photon-node)

The `read_image_file` tool uses [Photon](https://github.com/silvia-odwyer/photon) by Silvia O'Dwyer to decode, resize, and re-encode images. `dist/image-worker.js` contains Photon's JavaScript bindings and `dist/photon_rs_bg.wasm` is Photon's WebAssembly module. Photon is licensed under the Apache License, Version 2.0; the full license text ships as `dist/photon-node-LICENSE.md` and is available at https://www.apache.org/licenses/LICENSE-2.0.

## MCP configuration file locking

The configuration writer includes `proper-lockfile` and its dependencies. The following packages use the MIT License reproduced above:

- `proper-lockfile`: Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
- `retry`: Copyright (c) 2011 Tim Koschützki (tim@debuggable.com), Felix Geisendörfer (felix@debuggable.com)

`graceful-fs` and `signal-exit` use the ISC License:

Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors (`graceful-fs`)

Copyright (c) 2015, Contributors (`signal-exit`)

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
