"""Tests for YAPar parser generator."""
import unittest
from pathlib import Path
from src.yapar_generator import parse_yapar, build_lr0_automaton, LRTable


class TestYAParParser(unittest.TestCase):
    """Test YAPar specification parsing."""

    def test_parse_simple_grammar(self):
        """Test parsing a simple grammar."""
        spec_text = """
%{
/* Header comment */
%}

%token NUMBER ID
%token PLUS MINUS

%start expr

%%

expr
    : term
    | expr PLUS term
    | expr MINUS term
    ;

term
    : NUMBER
    | ID
    ;

%%
"""
        spec = parse_yapar(spec_text)

        self.assertEqual(spec.start_symbol, "expr")
        self.assertIn("NUMBER", spec.tokens)
        self.assertIn("ID", spec.tokens)
        # Debug: print productions
        print(f"\nParsed {len(spec.productions)} productions:")
        for i, prod in enumerate(spec.productions):
            print(f"  {i}: {prod.lhs} -> {' '.join(prod.rhs)}")
        self.assertGreaterEqual(len(spec.productions), 4, f"Expected at least 4 productions, got {len(spec.productions)}")

    def test_lr0_automaton_basic(self):
        """Test LR(0) automaton construction on simple grammar."""
        spec_text = """
%token A B
%start s

%%

s : A B ;

%%
"""
        spec = parse_yapar(spec_text)
        automaton = build_lr0_automaton(spec)

        # Should have at least initial state
        self.assertGreater(len(automaton.states), 0)
        self.assertEqual(automaton.start_state, 0)

    def test_lr0_table_generation(self):
        """Test LR table generation."""
        spec_text = """
%token A
%start s

%%

s : A ;

%%
"""
        spec = parse_yapar(spec_text)
        automaton = build_lr0_automaton(spec)
        table = LRTable(automaton, spec)

        # Should have action and goto tables for each state
        self.assertEqual(len(table.action), len(automaton.states))
        self.assertEqual(len(table.goto), len(automaton.states))


if __name__ == "__main__":
    unittest.main()
