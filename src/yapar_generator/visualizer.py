"""Visualization helpers for grammar automata.

Provides a small helper to render an automaton to Graphviz DOT format
so it can be exported as PNG/SVG during project deliverables.
"""
from typing import Any


def render_automaton_dot(automaton: Any) -> str:
    """Return a Graphviz DOT string representing `automaton`.

    This is a best-effort skeleton: the exact automaton shape will be
    adapted when the LR(0) states and transitions are implemented.
    """
    lines = ["digraph lr0 {", "  rankdir=LR;"]
    # If automaton has 'states' iterate them
    states = getattr(automaton, "states", automaton.get("states", []))
    for i, st in enumerate(states):
        label = f"S{i}"
        lines.append(f"  {i} [label=\"{label}\"];")
        # transitions if available
        trans = getattr(st, "transitions", None) or st.get("transitions", {})
        for sym, tgt in (trans.items() if trans else []):
            lines.append(f"  {i} -> {tgt} [label=\"{sym}\"];")
    lines.append("}")
    return "\n".join(lines)
