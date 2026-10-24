---
"@tasweerix/codemod": patch
---

`readProp` no longer evaluates source code with `new Function()`: literal options are read straight from the AST, so computed keys can't run code and `as` / `satisfies` assertions no longer crash it. Expression keys like `{ [k]: ... }` are treated as computed, while static ones like `{ ['at']: ... }` still match.
