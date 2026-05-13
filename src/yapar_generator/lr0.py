"""LR(0) automaton construction.

Implements the canonical LR(0) item set construction algorithm with
closure and GOTO operations. This is the foundation of the LR parser
table generation.
"""
from dataclasses import dataclass, field
from typing import List, Set, Dict, Tuple, Optional, FrozenSet
from .yapar_parser import Production, GrammarSpec


@dataclass(frozen=True)
class LR0Item:
    """An LR(0) item: A -> α . β, where the dot is at position `dot` in the RHS."""
    lhs: str
    rhs: Tuple[str, ...]
    dot: int

    def advance(self) -> Optional['LR0Item']:
        """Return item with dot advanced one position, or None if at end."""
        if self.dot >= len(self.rhs):
            return None
        return LR0Item(self.lhs, self.rhs, self.dot + 1)

    def symbol_after_dot(self) -> Optional[str]:
        """Return the symbol immediately after the dot, or None."""
        if self.dot < len(self.rhs):
            return self.rhs[self.dot]
        return None

    def is_reduce(self) -> bool:
        """Return True if dot is at end (ready to reduce)."""
        return self.dot >= len(self.rhs)


@dataclass
class LR0State:
    """A set of LR(0) items representing a state in the canonical collection."""
    items: FrozenSet[LR0Item]
    transitions: Dict[str, int] = field(default_factory=dict)

    def __hash__(self) -> int:
        return hash(self.items)

    def __eq__(self, other) -> bool:
        if not isinstance(other, LR0State):
            return False
        return self.items == other.items


class LR0Automaton:
    """The canonical LR(0) automaton: collection of item sets and transitions."""

    def __init__(self, grammar: GrammarSpec):
        self.grammar = grammar
        self.states: List[LR0State] = []
        self.start_state: int = 0
        self._build()

    def _build(self) -> None:
        """Build the canonical LR(0) collection."""
        # Add augmented production: S' -> S (where S is the start symbol)
        augmented = Production(
            lhs="_START_",
            rhs=(self.grammar.start_symbol,),
            action=None
        )
        all_productions = [augmented] + self.grammar.productions

        # Initial state: closure of {S' -> . S}
        initial_item = LR0Item(
            lhs=augmented.lhs,
            rhs=tuple(augmented.rhs),
            dot=0
        )
        initial_state_items = self._closure({initial_item}, all_productions)
        initial_state = LR0State(frozenset(initial_state_items))

        # Canonical collection using BFS
        state_map: Dict[FrozenSet[LR0Item], int] = {}
        queue = [initial_state_items]
        state_map[initial_state.items] = 0
        self.states.append(initial_state)

        while queue:
            current_items = queue.pop(0)
            current_state_idx = state_map[frozenset(current_items)]
            current_state = self.states[current_state_idx]

            # Group items by symbol after dot
            symbol_groups: Dict[str, Set[LR0Item]] = {}
            for item in current_items:
                sym = item.symbol_after_dot()
                if sym is not None:
                    if sym not in symbol_groups:
                        symbol_groups[sym] = set()
                    symbol_groups[sym].add(item)

            # For each symbol, compute GOTO
            for sym, items_with_sym in symbol_groups.items():
                next_items = self._goto(items_with_sym, sym, all_productions)
                next_state_items = frozenset(next_items)

                if next_state_items not in state_map:
                    # New state
                    state_idx = len(self.states)
                    state_map[next_state_items] = state_idx
                    self.states.append(LR0State(next_state_items))
                    queue.append(set(next_state_items))

                # Add transition
                next_idx = state_map[next_state_items]
                current_state.transitions[sym] = next_idx

    def _closure(
        self,
        items: Set[LR0Item],
        productions: List[Production]
    ) -> Set[LR0Item]:
        """Compute closure of a set of items.

        For each item A -> α . B β in the set, add all B -> . γ productions.
        """
        result = set(items)
        added = set(items)
        queue = list(items)

        while queue:
            item = queue.pop(0)
            b = item.symbol_after_dot()
            if b is not None:
                # Find all productions B -> γ
                for prod in productions:
                    if prod.lhs == b:
                        new_item = LR0Item(prod.lhs, tuple(prod.rhs), 0)
                        if new_item not in added:
                            result.add(new_item)
                            added.add(new_item)
                            queue.append(new_item)

        return result

    def _goto(
        self,
        items: Set[LR0Item],
        symbol: str,
        productions: List[Production]
    ) -> Set[LR0Item]:
        """Compute GOTO(items, symbol).

        For each item A -> α . s β, advance the dot past s and compute closure.
        """
        advanced = set()
        for item in items:
            if item.symbol_after_dot() == symbol:
                adv = item.advance()
                if adv is not None:
                    advanced.add(adv)

        return self._closure(advanced, productions)


def build_lr0_automaton(grammar: GrammarSpec) -> LR0Automaton:
    """Build a canonical LR(0) automaton from a grammar specification."""
    return LR0Automaton(grammar)
