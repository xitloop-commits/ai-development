---
name: feedback-questions-inline
description: User prefers inline chat questions over the AskUserQuestion modal popup. Default to markdown prose with numbered/lettered options in chat.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cb6a3369-fbcd-4914-ab7c-44c312f28f37
---

When asking design-choice or clarification questions, default to **inline markdown prose** with clearly numbered/lettered options. Do NOT use the AskUserQuestion tool's modal popup.

**Why:** User explicitly redirected on 2026-05-17 with "ask here, not adaptive question window" after I used AskUserQuestion mid-session on a design question. The modal popup appears to create friction in their workflow — likely because it forces a context switch, displays poorly, or breaks the conversational flow.

**How to apply:**
- For options-pick questions, format as:
  ```
  **Question text.**

  A. Option label — description / tradeoff
  B. Option label — description / tradeoff
  C. Option label — description / tradeoff

  My recommendation: A (one-line reason).
  ```
- For multi-select, say so explicitly: "pick any combination."
- For yes/no with caveats, just ask in prose.
- Reserve AskUserQuestion ONLY for cases where the user explicitly says "give me a picker" or when there are 4+ visually-similar options that benefit from side-by-side comparison.

Cross-refs: [[user-role]] (Partha works fast and prefers direct).
