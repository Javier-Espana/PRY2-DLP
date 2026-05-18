#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "output"))
sys.path.insert(0, str(Path(__file__).parent / "src"))

from lexer_medium import tokenize
from parser_medium import SLRParser

input_file = Path("examples/medium/input.txt")
source = input_file.read_text(encoding='utf-8')

print(f"Input file: {input_file}")
print(f"Source:\n{source}\n")

print("=" * 70)
print("LEXER OUTPUT")
print("=" * 70)

tokens, errors = tokenize(source)
for i, tok in enumerate(tokens):
    print(f"{i:2d}: {tok.type:10s} = {tok.lexeme!r:15s} @ L{tok.line}:C{tok.col}")

if errors:
    print("\nErrors:")
    for err in errors:
        print(f"  {err}")

print("\n" + "=" * 70)
print("PARSER")
print("=" * 70)

parser = SLRParser()
try:
    result = parser.parse(tokens)
    print(f"✓ Parse succeeded!")
    print(f"Result: {result}")
except Exception as e:
    print(f"✗ Parse failed: {e}")
    import traceback
    traceback.print_exc()
