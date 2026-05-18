#!/usr/bin/env python3
"""Bridge CLI for YALex + YAPar workflow.

Allows users to:
1. Generate a lexer from a .yal file
2. Generate a parser from a .yalp file
3. Run the generated lexer+parser on an input file
"""
import argparse
import sys
import json
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent))

from yalex_parser import parse_yalex, build_direct_artifacts, minimize_dfa, parse_regex
from yalex_parser.dfa import dfa_to_table
from yalex_parser.simulator import tokenize_with_trace
from yalex_parser.codegen import generate_lexer

from yapar_generator import parse_yapar, build_lr0_automaton, LRTable, generate_parser, render_automaton_dot


def action_analyze_yal(yal_path: Path) -> None:
    """Analyze and display information about a .yal specification."""
    print(f"\n{'='*70}")
    print(f"  YALex Analysis: {yal_path}")
    print(f"{'='*70}")

    source = yal_path.read_text()
    spec = parse_yalex(source)

    print(f"\nHeader:\n{spec.header[:200] if spec.header else '(empty)'}")
    print(f"\nLet definitions: {len(spec.lets)}")
    for let_def in spec.lets:
        print(f"  - {let_def.name} = {let_def.regex}")

    if spec.rule:
        print(f"\nTokenization rules: {len(spec.rule.alternatives)}")
        for i, alt in enumerate(spec.rule.alternatives):
            print(f"  {i}: {alt.regex} -> {alt.action}")


def action_generate_lexer(yal_path: Path, output_path: Path) -> None:
    """Generate standalone lexer from .yal specification."""
    print(f"\nGenerating lexer from {yal_path}...")
    
    source = yal_path.read_text()
    spec = parse_yalex(source)
    let_asts = {d.name: parse_regex(d.regex) for d in spec.lets}

    combined = []
    if spec.rule:
        for idx, alt in enumerate(spec.rule.alternatives):
            label = alt.action.strip() if alt.action else f"ALT_{idx}"
            combined.append((label, parse_regex(alt.regex)))

    direct = build_direct_artifacts(combined, let_asts)
    dfa = minimize_dfa(direct.dfa)

    code = generate_lexer(dfa, spec.header, spec.trailer, output_path=output_path)
    print(f"✓ Lexer written to {output_path} ({len(code)} bytes)")


def action_analyze_yapar(yapar_path: Path) -> None:
    """Analyze and display information about a .yalp specification."""
    print(f"\n{'='*70}")
    print(f"  YAPar Analysis: {yapar_path}")
    print(f"{'='*70}")

    source = yapar_path.read_text()
    spec = parse_yapar(source)

    print(f"\nStart symbol: {spec.start_symbol}")
    print(f"Tokens: {', '.join(spec.tokens[:10])}" + 
          (f" (+{len(spec.tokens)-10} more)" if len(spec.tokens) > 10 else ""))
    print(f"\nProductions: {len(spec.productions)}")
    for i, prod in enumerate(spec.productions[:10]):
        rhs_str = ' '.join(prod.rhs) if prod.rhs else "ε"
        print(f"  {i}: {prod.lhs} -> {rhs_str}")
    if len(spec.productions) > 10:
        print(f"  ... and {len(spec.productions) - 10} more")


def action_generate_parser(yapar_path: Path, output_path: Path) -> None:
    """Generate standalone parser from .yalp specification."""
    print(f"\nGenerating parser from {yapar_path}...")

    source = yapar_path.read_text()
    grammar = parse_yapar(source)

    automaton = build_lr0_automaton(grammar)
    table = LRTable(automaton, grammar)

    code = generate_parser(table, grammar, output_path=output_path)
    print(f"✓ Parser written to {output_path} ({len(code)} bytes)")
    print(f"  States: {len(automaton.states)}")


def action_visualize_automaton(yapar_path: Path, output_path: Path) -> None:
    """Generate Graphviz DOT representation of LR(0) automaton."""
    print(f"\nGenerating LR(0) automaton visualization...")

    source = yapar_path.read_text()
    grammar = parse_yapar(source)
    automaton = build_lr0_automaton(grammar)

    dot = render_automaton_dot(automaton)
    output_path.write_text(dot)
    print(f"✓ DOT file written to {output_path}")
    print(f"  To visualize: dot -Tpng {output_path} -o {output_path.stem}.png")


def main():
    parser = argparse.ArgumentParser(
        description="YALex + YAPar CLI: Generate lexers and parsers from specifications"
    )
    subparsers = parser.add_subparsers(dest="action", help="Action to perform")

    # Analyze YALex
    analyze_yal = subparsers.add_parser("analyze-yal", help="Analyze .yal specification")
    analyze_yal.add_argument("yal_file", type=Path, help=".yal file to analyze")

    # Generate Lexer
    gen_lexer = subparsers.add_parser("gen-lexer", help="Generate lexer from .yal")
    gen_lexer.add_argument("yal_file", type=Path, help=".yal file")
    gen_lexer.add_argument("-o", "--output", type=Path, required=True, help="Output .py file")

    # Analyze YAPar
    analyze_yapar = subparsers.add_parser("analyze-yapar", help="Analyze .yalp specification")
    analyze_yapar.add_argument("yapar_file", type=Path, help=".yalp file to analyze")

    # Generate Parser
    gen_parser = subparsers.add_parser("gen-parser", help="Generate parser from .yalp")
    gen_parser.add_argument("yapar_file", type=Path, help=".yalp file")
    gen_parser.add_argument("-o", "--output", type=Path, required=True, help="Output .py file")

    # Visualize Automaton
    visualize = subparsers.add_parser("visualize", help="Generate LR(0) automaton visualization")
    visualize.add_argument("yapar_file", type=Path, help=".yalp file")
    visualize.add_argument("-o", "--output", type=Path, default=Path("automaton.dot"), 
                          help="Output .dot file (default: automaton.dot)")

    args = parser.parse_args()

    try:
        if args.action == "analyze-yal":
            action_analyze_yal(args.yal_file)
        elif args.action == "gen-lexer":
            action_generate_lexer(args.yal_file, args.output)
        elif args.action == "analyze-yapar":
            action_analyze_yapar(args.yapar_file)
        elif args.action == "gen-parser":
            action_generate_parser(args.yapar_file, args.output)
        elif args.action == "visualize":
            action_visualize_automaton(args.yapar_file, args.output)
        else:
            parser.print_help()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
