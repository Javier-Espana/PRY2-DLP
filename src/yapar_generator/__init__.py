"""YAPar generator package.

Contains LR(0) builder, parser skeleton and visualizer helpers. This is
the starting point for the parser-generator implementation required by
Project 2.
"""
from .lr0 import build_lr0_automaton, LR0Automaton, LR0Item  # noqa: F401
from .parser import LR0Parser, ParseResult  # noqa: F401
from .visualizer import render_automaton_dot  # noqa: F401
from .yapar_parser import parse_yapar, GrammarSpec, Production  # noqa: F401
from .table import LRTable  # noqa: F401
from .codegen import generate_parser  # noqa: F401

__all__ = [
    "build_lr0_automaton",
    "LR0Automaton",
    "LR0Item",
    "LR0Parser",
    "ParseResult",
    "render_automaton_dot",
    "parse_yapar",
    "GrammarSpec",
    "Production",
    "LRTable",
    "generate_parser",
]
