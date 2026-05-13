"""YAPar generator package (skeleton).

Contains LR(0) builder, parser skeleton and visualizer helpers. This is
the starting point for the parser-generator implementation required by
Project 2.
"""
from .lr0 import build_lr0_automaton  # noqa: F401
from .parser import LR0Parser  # noqa: F401
from .visualizer import render_automaton_dot  # noqa: F401

__all__ = ["build_lr0_automaton", "LR0Parser", "render_automaton_dot"]
