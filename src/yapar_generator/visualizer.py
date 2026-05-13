"""Visualization helpers for grammar automata.

Provides a helper to render an automaton to Graphviz DOT format
so it can be exported as PNG/SVG during project deliverables.
"""
from typing import Any
from .lr0 import LR0Automaton


def render_automaton_dot(automaton: LR0Automaton) -> str:
    """Return a Graphviz DOT string representing the LR(0) automaton.

    The output can be rendered with: dot -Tpng output.dot -o output.png
    """
    lines = ["digraph lr0_automaton {"]
    lines.append("  rankdir=LR;")
    lines.append('  node [shape=circle, style=filled, fillcolor=lightblue];')
    lines.append(f'  0 [fillcolor=lightgreen];  // Initial state')

    # Nodes for each state
    for i, state in enumerate(automaton.states):
        # Create label with items in the state
        items_str = "\\n".join([f"{item.lhs} -> {' '.join(item.rhs[:item.dot])} . {' '.join(item.rhs[item.dot:])}" 
                               for item in sorted(state.items, key=lambda x: (x.lhs, x.rhs, x.dot))])
        # Truncate long labels
        if len(items_str) > 200:
            items_str = items_str[:200] + "..."
        label = f"S{i}\\n{items_str}"
        lines.append(f'  {i} [label="{label}"];')

    # Edges for transitions
    for i, state in enumerate(automaton.states):
        for symbol, next_state_idx in sorted(state.transitions.items()):
            lines.append(f'  {i} -> {next_state_idx} [label="{symbol}"];')

    lines.append("}")
    return "\n".join(lines)
