"""Common utilities shared across lexer and parser generators.

Place for lightweight shared types and helpers used by both generators.
Keep this module small to avoid coupling generator implementations.
"""
from dataclasses import dataclass


@dataclass
class Token:
    type: str
    lexeme: str
    line: int
    col: int

__all__ = ["Token"]
