"""LR parsing table generation.

Generates ACTION and GOTO tables for SLR parsing from an LR(0) automaton.
"""
from typing import Dict, List, Tuple, Set
from .lr0 import LR0Automaton, LR0Item
from .yapar_parser import GrammarSpec, Production


class LRTable:
    """SLR parsing table: ACTION and GOTO tables."""

    def __init__(self, automaton: LR0Automaton, grammar: GrammarSpec):
        self.automaton = automaton
        self.grammar = grammar
        self.action: List[Dict[str, Tuple[str, int]]] = []
        self.goto: List[Dict[str, int]] = []
        self._build_tables()

    def _build_tables(self) -> None:
        """Build ACTION and GOTO tables from the automaton."""
        # Compute FOLLOW sets for SLR lookahead
        follow = self._compute_follow_sets()
        
        # Build a set of terminals and nonterminals
        terminals = set(self.grammar.tokens)
        nonterminals = set(prod.lhs for prod in self.grammar.productions)

        # For each state
        for state_idx, state in enumerate(self.automaton.states):
            action_row: Dict[str, Tuple[str, int]] = {}
            goto_row: Dict[str, int] = {}

            # Shift actions from GOTO transitions
            for symbol, next_state_idx in state.transitions.items():
                if symbol in terminals:  # Terminal
                    action_row[symbol] = ("shift", next_state_idx)
                elif symbol in nonterminals:  # Nonterminal
                    goto_row[symbol] = next_state_idx

            # Reduce actions from reduce items
            for item in state.items:
                if item.is_reduce():
                    # Find which production this corresponds to
                    prod_idx = self._find_production_index(item)
                    if prod_idx is not None:
                        # Special case: accept on augmented production
                        if item.lhs == "_START_":
                            action_row["$"] = ("accept", 0)
                        else:
                            # For each terminal in FOLLOW(item.lhs), add reduce action
                            for terminal in follow.get(item.lhs, set()):
                                if terminal not in action_row:
                                    action_row[terminal] = ("reduce", prod_idx)
                                else:
                                    # Conflict resolution: prefer shift over reduce
                                    if action_row[terminal][0] != "shift":
                                        action_row[terminal] = ("reduce", prod_idx)

            self.action.append(action_row)
            self.goto.append(goto_row)

    def _find_production_index(self, item: LR0Item) -> int:
        """Find the index of the production corresponding to the item."""
        # Skip the augmented production
        for i, prod in enumerate(self.grammar.productions):
            if (prod.lhs == item.lhs and 
                tuple(prod.rhs) == item.rhs):
                return i + 1  # +1 because index 0 is for augmented production
        return None

    def _compute_follow_sets(self) -> Dict[str, Set[str]]:
        """Compute FOLLOW sets for each nonterminal using fixed-point iteration."""
        # Build a set of terminals for quick lookup
        terminals = set(self.grammar.tokens)
        nonterminals = set(prod.lhs for prod in self.grammar.productions)
        
        follow: Dict[str, Set[str]] = {}
        
        # Initialize FOLLOW sets
        for nt in nonterminals:
            follow[nt] = set()
        
        # FOLLOW(start) = {$}
        follow[self.grammar.start_symbol] = {"$"}
        
        # Fixed-point iteration
        changed = True
        while changed:
            changed = False
            for prod in self.grammar.productions:
                for i, symbol in enumerate(prod.rhs):
                    if symbol in nonterminals:  # This is a nonterminal
                        # Add terminals that follow this symbol
                        for j in range(i + 1, len(prod.rhs)):
                            next_sym = prod.rhs[j]
                            if next_sym in terminals:
                                before = len(follow[symbol])
                                follow[symbol].add(next_sym)
                                if len(follow[symbol]) > before:
                                    changed = True
                                break
                            elif next_sym in nonterminals:
                                # Add FIRST of next_sym (for now, assume all nonterminals have epsilon production)
                                # In a full implementation, we'd compute FIRST sets
                                pass
                        else:
                            # All following symbols are nonterminals
                            # Add FOLLOW(prod.lhs)
                            before = len(follow[symbol])
                            follow[symbol].update(follow[prod.lhs])
                            if len(follow[symbol]) > before:
                                changed = True
        
        return follow

    def get_action(self, state: int, lookahead: str) -> Tuple[str, int]:
        """Get action for (state, lookahead)."""
        return self.action[state].get(lookahead, ("error", -1))

    def get_goto(self, state: int, nonterminal: str) -> int:
        """Get GOTO(state, nonterminal)."""
        return self.goto[state].get(nonterminal, -1)
