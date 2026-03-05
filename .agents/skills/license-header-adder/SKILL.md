---
name: license-header-adder
description: Adds the standard corporate license header to new source files.
---

# License Header Adder

This skill ensures that all new source files have the correct copyright header.

## Instructions
1. **Read the Template**: Read the content of `resources/HEADER.txt`.
2. **Apply to File**: When creating a new file, prepend this exact content.
3. **Adapt Syntax**: 
   - For C-style languages (Java, TS), keep the `/* */` block.
   - For Python/Shell, convert to `#` comments.
