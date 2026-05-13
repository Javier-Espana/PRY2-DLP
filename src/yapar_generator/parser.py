"""LR(0) parser skeleton.

Provides a class `LR0Parser` that will be the entry point for the
generated parser. For now it implements a minimal API and a placeholder
`parse` method to be implemented.
"""
from dataclasses import dataclass
from typing import Any, List, Optional


@dataclass
class ParseResult:
    success: bool
    ast: Optional[Any]
    errors: List[str]


class LR0Parser:
    def __init__(self, automaton: Any, start_symbol: str):
        self.automaton = automaton
        self.start_symbol = start_symbol

    def parse(self, token_stream: Iterable[tuple]) -> ParseResult:  # pragma: no cover - skeleton
        """Parse tokens produced by the lexer.

        `token_stream` should yield (type, lexeme, line, col) tuples.
        """
        # TODO: implement real LR parse loop using automaton.
        return ParseResult(success=False, ast=None, errors=["Not implemented"])
