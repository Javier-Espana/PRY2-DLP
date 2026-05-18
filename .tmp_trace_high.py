from pathlib import Path
import sys
p = Path(__file__).parent
sys.path.insert(0, str(p))

try:
    from src.bridge_cli import _build_pipeline_from_source
    from src.yalex_parser.simulator import tokenize_with_trace
    from src.yalex_parser.dfa import dfa_to_table
except Exception as e:
    print('IMPORT_ERROR', e)
    raise

spec_path = p / 'examples' / 'high' / 'lang_oop.yal'
input_path = p / 'examples' / 'high' / 'input.txt'

spec_text = spec_path.read_text(encoding='utf-8')
input_text = input_path.read_text(encoding='utf-8')

print('Building pipeline from', spec_path)
try:
    spec_obj, direct, dfa = _build_pipeline_from_source(spec_text)
except Exception as e:
    print('BUILD_ERROR', e)
    raise

print('Converting DFA to table')
try:
    tableobj = dfa_to_table(dfa)
    start = dfa.start_state
    accept = tableobj['accept']
    table = tableobj['table']
except Exception as e:
    print('DFA_TABLE_ERROR', e)
    raise

print('Running tokenize_with_trace on', input_path)
try:
    tokens, errors, trace = tokenize_with_trace(input_text, start, accept, table, include_trace=True)
except TypeError:
    # fallback if tokenize_with_trace signature differs
    from inspect import signature
    sig = signature(tokenize_with_trace)
    print('tokenize_with_trace signature:', sig)
    # try common alternate signature
    try:
        tokens, errors, trace = tokenize_with_trace(input_text, dfa, include_trace=True)
    except Exception as e:
        print('TOKENIZE_ERROR', e)
        raise

print('\n=== ERRORS ===')
print(errors)
print('\n=== TOKENS (first 200) ===')
for t in tokens[:200]:
    print(t)
print('\n=== TRACE (first 500 lines) ===')
for i, line in enumerate(trace):
    if i>500: break
    print(line)

# Save full trace to file
out = p / 'artifacts' / 'high_token_trace.txt'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text('\n'.join(map(str, trace)), encoding='utf-8')
print('Full trace saved to', out)
