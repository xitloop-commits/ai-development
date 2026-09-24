"""TCS2 — Tick Collection Service, second generation.

Spec: docs/systems/14_tcs2.md  (decisions D1-D34)

One process per instrument (D9), one Dhan WS connection each (D13), sharing
nothing with the others (D14), and importing nothing from the research packages
(D27).
"""
