# Third-party notices

The PDF Worker bundles the JavaScript wrapper and WebAssembly artifact from
`@hyzyla/pdfium` 2.1.13. The wrapper is MIT-licensed; its exact upstream
license is distributed by that package. The WebAssembly artifact contains
PDFium, the open-source PDF engine used by Chromium, and its transitive
third-party components. Their notices and source references are maintained by
the upstream PDFium and `hyzyla/pdfium` projects.

`@hyzyla/pdfium` wrapper license notice:

Copyright (c) 2012-2023 Scott Chacon and others

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

The dependency version and registry integrity are locked in
`package-lock.json`. No runtime asset is loaded from a CDN.

The rwml and rwml-fonts dependencies under `poc/` are build-only proof-of-
concept sources and are not included in the published `dist`. rwml is MIT;
rwml-fonts contains OFL-licensed fixed font subsets.
