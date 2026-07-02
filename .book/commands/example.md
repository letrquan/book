---
description: Example custom command demonstrating all features
argument-hint: [name]
arguments:
  - greeting
  - name
allowed-tools:
  - Read
  - Grep
model: mmf/mimo-auto
---
Hello, $ARGUMENTS!

Today is ${BOOK_DATE}.
Workspace: ${BOOK_WORKSPACE}.
Model: ${BOOK_MODEL}.

Named args: greeting=$greeting, name=$name
Positional: $1 and $2

Current branch: !`git branch --show-current`

This is a demo of all the command resolution features:
- $ARGUMENTS substitution
- $1/$2 positional args
- $greeting/$name named args (from `arguments` frontmatter)
- ${BOOK_DATE} / ${BOOK_WORKSPACE} / ${BOOK_MODEL} env vars
- !`cmd` shell injection
- allowed-tools restriction (Read and Grep only)
- model override (mmf/mimo-auto)
