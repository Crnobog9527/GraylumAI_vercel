---
name: license-header-adder
description: Add the corporate license header to new first-party source files that support comments, preserving file-format requirements and existing licenses.
---

# License Header Adder

Read `resources/HEADER.txt` relative to this skill directory and preserve its
license text. Apply it once to new first-party source files that support comments.
Use the appropriate comment syntax (for example, `/* */` for TypeScript and `#`
for Python or shell). Preserve required shebang and encoding declarations before
the header.

Do not insert comments into formats that prohibit them, such as JSON. Exclude
binary, generated, and third-party files. Preserve existing license notices and
do not bulk-edit existing files unless that work is explicitly requested.
