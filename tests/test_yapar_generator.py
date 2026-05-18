"""Tests for YAPar parser generator."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from yapar_generator import parse_yapar, build_lr0_automaton, LRTable


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
    def test_yapar_token_validation_yalex(self):
        """Test that validation fails if a YAPar token is not defined in YALex."""
        from bridge_cli import _run_action
        
        payload = {
            "action": "yaparParse",
            "yaparSource": "%token ID NUMBER MISSING_TOKEN\n%start s\n%%\ns : ID ;\n%%",
            "yalSource": "let digit = ['0'-'9']\nrule tokens =\n  digit+ { return 'NUMBER' }\n  | ['a'-'z']+ { return 'ID' }",
            "inputText": "hello"
        }
        
        result = _run_action(payload)
        self.assertFalse(result["success"])
        self.assertTrue(any("MISSING_TOKEN" in err for err in result["errors"]))


if __name__ == "__main__":
    unittest.main()
