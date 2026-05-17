from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from yapar_generator import (
    parse_yapar,
    build_lr0_automaton,
    LRTable,
    generate_parser,
    render_automaton_dot,
)

from yalex_parser import (
    build_direct_artifacts,
    direct_artifacts_to_dict,
    dfa_to_dict,
    dfa_to_table,
    minimize_dfa,
    parse_regex,
    parse_yalex,
    regex_node_to_dict,
)
from yalex_parser.codegen import generate_lexer
from yalex_parser.simulator import tokenize_with_trace


def _build_pipeline_from_source(source: str):
    spec = parse_yalex(source)
    let_asts = {definition.name: parse_regex(definition.regex) for definition in spec.lets}

    combined_entries: list[tuple[str, object]] = []
    if spec.rule is not None:
        for index, alternative in enumerate(spec.rule.alternatives):
            label = alternative.action.strip() if alternative.action else f"ALT_{index}"
            combined_entries.append((label, parse_regex(alternative.regex)))

    direct = build_direct_artifacts(combined_entries, let_asts)
    raw_dfa = direct.dfa
    dfa = minimize_dfa(raw_dfa)
    return spec, direct, dfa


def _to_json_ready_token(token):
    return {
        "type": token.type,
        "lexeme": token.lexeme,
        "line": token.line,
        "col": token.col,
    }


def _to_json_ready_error(error):
    return {
        "char": error.char,
        "line": error.line,
        "col": error.col,
        "message": error.message,
    }


def _to_json_ready_trace(step):
    return {
        "stage": step.stage,
        "position": step.position,
        "line": step.line,
        "col": step.col,
        "state": step.state,
        "char": step.char,
        "next_state": step.next_state,
        "note": step.note,
    }


def _normalize_path(raw: str) -> Path:
    r"""Normalize a path string coming from the Tauri/Windows layer.

    Handles two Windows-specific issues:
    1. Double-escaped separators (C:\\\\Users\\\\...) caused by the path
       being JSON-serialized more than once in the Rust/JS pipeline.
    2. Extended-length prefix (\\?\) added by Windows canonicalize().
    """
    s = raw.strip()
    # Detect double-escaped Windows paths: consecutive \\ where \ is the
    # intended separator. Only applies when there are no forward slashes.
    if "\\\\" in s and "/" not in s:
        s = s.replace("\\\\", "\\")
    # Strip Windows extended-length prefix \\?\ (after unescaping)
    if s.startswith("\\\\?\\"):
        s = s[4:]
    return Path(s)


def _read_text_from_payload_path(raw: str, *, label: str) -> str:
    path = _normalize_path(raw)
    if path.exists():
        return path.read_text(encoding="utf-8")

    # Fallback: Windows also accepts forward slashes.
    alt = Path(str(path).replace("\\", "/"))
    if alt.exists():
        return alt.read_text(encoding="utf-8")

    raise FileNotFoundError(
        f"{label} no encontrado. "
        f"normalized={path!r}, exists={path.exists()}, "
        f"alt={alt!r}, alt_exists={alt.exists()}, cwd={Path.cwd()}"
    )


def _run_action(payload: dict) -> dict:
    action = payload.get("action")
    yal_path_raw = payload.get("yalPath")
    yal_source_raw = payload.get("yalSource")

    if action is None:
        raise ValueError("Falta campo 'action' en request")

    if action == "executeGeneratedLexer":
        lexer_path_raw = payload.get("lexerPath")
        input_path_raw = payload.get("inputPath")

        if not lexer_path_raw:
            raise ValueError("Para ejecutar lexer generado debe enviar 'lexerPath'")
        if not input_path_raw:
            raise ValueError("Para ejecutar lexer generado debe enviar 'inputPath'")

        lexer_path = _normalize_path(str(lexer_path_raw))
        input_path = _normalize_path(str(input_path_raw))

        if not lexer_path.exists():
            raise FileNotFoundError(f"Lexer generado no encontrado: {lexer_path}")
        if not input_path.exists():
            raise FileNotFoundError(f"Input no encontrado: {input_path}")

        result = subprocess.run(
            [sys.executable, str(lexer_path), str(input_path)],
            capture_output=True,
            text=True,
        )

        stdout_lines = [line for line in result.stdout.splitlines() if line.strip()]
        token_lines = [line for line in stdout_lines if line.startswith("Token(")]
        error_lines = [line for line in stdout_lines if line.startswith("Error léxico")]

        return {
            "success": result.returncode == 0,
            "exitCode": result.returncode,
            "tokenCount": len(token_lines),
            "lexicalErrorCount": len(error_lines),
            "stdout": result.stdout,
            "stderr": result.stderr,
            "lexerPath": str(lexer_path),
            "inputPath": str(input_path),
        }

    if yal_source_raw is not None:
        source = str(yal_source_raw)
    elif yal_path_raw:
        source = _read_text_from_payload_path(yal_path_raw, label="yalPath")
    else:
        raise ValueError("Debe enviar 'yalPath' o 'yalSource'")

    spec, direct, dfa = _build_pipeline_from_source(source)

    if action == "spec":
        return {"spec": asdict(spec)}

    if action == "ast":
        lets_ast = [
            {
                "name": definition.name,
                "ast": regex_node_to_dict(parse_regex(definition.regex)),
            }
            for definition in spec.lets
        ]
        rule_alternatives_ast = []
        if spec.rule is not None:
            for index, alternative in enumerate(spec.rule.alternatives):
                rule_alternatives_ast.append(
                    {
                        "index": index,
                        "regex": alternative.regex,
                        "ast": regex_node_to_dict(parse_regex(alternative.regex)),
                    }
                )
        return {"regex_ast": {"lets": lets_ast, "rule_alternatives": rule_alternatives_ast}}

    if action == "nfa":
        return {
            "direct_method": {
                "message": "No se genera AFN en el método directo.",
                "omitted_stage": "thompson_nfa",
            }
        }

    if action == "combinedNfa":
        return {"direct_construction": direct_artifacts_to_dict(direct)}

    if action == "dfa":
        return {
            "dfa": dfa_to_dict(dfa),
            "dfa_stats": {"states": len(dfa.states), "transitions": len(dfa.transitions)},
        }

    if action == "tokenize":
        input_path_raw = payload.get("inputPath")
        input_text_raw = payload.get("inputText")
        include_trace = bool(payload.get("includeTrace", False))
        trace_limit = int(payload.get("traceLimit", 500))

        if input_text_raw is not None:
            text = str(input_text_raw)
        elif input_path_raw:
            text = _read_text_from_payload_path(input_path_raw, label="inputPath")
        else:
            raise ValueError("Para tokenizar debe enviar 'inputPath' o 'inputText'")

        table = dfa_to_table(dfa)
        tokens, errors, trace = tokenize_with_trace(
            text,
            table["start"],
            table["accept"],
            table["table"],
            include_trace=include_trace,
        )

        trace_payload = []
        if include_trace:
            trace_payload = [_to_json_ready_trace(step) for step in trace[:trace_limit]]

        return {
            "tokens": [_to_json_ready_token(token) for token in tokens],
            "errors": [_to_json_ready_error(error) for error in errors],
            "trace": trace_payload,
        }

    if action == "generate":
        output_path_raw = payload.get("outputPath")
        if not output_path_raw:
            raise ValueError("Para generar lexer debe enviar 'outputPath'")
        output_path = _normalize_path(output_path_raw)
        code = generate_lexer(dfa, spec.header, spec.trailer, output_path=output_path)
        return {
            "outputPath": str(output_path),
            "bytes": len(code.encode("utf-8")),
        }

    if action == "yaparSpec":
        yapar_path_raw = payload.get("yaparPath")
        yapar_source_raw = payload.get("yaparSource")

        if yapar_source_raw is not None:
            source = str(yapar_source_raw)
        elif yapar_path_raw:
            source = _read_text_from_payload_path(yapar_path_raw, label="yaparPath")
        else:
            raise ValueError("Debe enviar 'yaparPath' o 'yaparSource'")

        spec = parse_yapar(source)
        return {
            "tokens": spec.tokens,
            "start_symbol": spec.start_symbol,
            "productions": [{"lhs": p.lhs, "rhs": p.rhs, "action": p.action} for p in spec.productions],
        }

    if action == "yaparAutomaton":
        yapar_path_raw = payload.get("yaparPath")
        yapar_source_raw = payload.get("yaparSource")

        if yapar_source_raw is not None:
            source = str(yapar_source_raw)
        elif yapar_path_raw:
            source = _read_text_from_payload_path(yapar_path_raw, label="yaparPath")
        else:
            raise ValueError("Debe enviar 'yaparPath' o 'yaparSource'")

        spec = parse_yapar(source)
        automaton = build_lr0_automaton(spec)
        dot = render_automaton_dot(automaton)

        states_data = []
        for idx, state in enumerate(automaton.states):
            items_list = []
            for item in sorted(state.items, key=lambda x: (x.lhs, x.rhs, x.dot)):
                items_list.append(f"{item.lhs} -> {' '.join(item.rhs[:item.dot])} . {' '.join(item.rhs[item.dot:])}")
            states_data.append({
                "id": idx,
                "items": items_list,
                "transitions": state.transitions,
            })

        return {
            "states": states_data,
            "dot": dot,
        }

    if action == "yaparTable":
        yapar_path_raw = payload.get("yaparPath")
        yapar_source_raw = payload.get("yaparSource")

        if yapar_source_raw is not None:
            source = str(yapar_source_raw)
        elif yapar_path_raw:
            source = _read_text_from_payload_path(yapar_path_raw, label="yaparPath")
        else:
            raise ValueError("Debe enviar 'yaparPath' o 'yaparSource'")

        spec = parse_yapar(source)
        automaton = build_lr0_automaton(spec)
        table = LRTable(automaton, spec)

        action_headers = sorted(list(set(spec.tokens) | {"$"}))
        goto_headers = sorted(list(set(prod.lhs for prod in spec.productions)))

        rows = []
        for state_idx in range(len(automaton.states)):
            action_row = {}
            for col in action_headers:
                act_type, act_arg = table.get_action(state_idx, col)
                if act_type != "error":
                    action_row[col] = [act_type, act_arg]

            goto_row = {}
            for col in goto_headers:
                next_state = table.get_goto(state_idx, col)
                if next_state != -1:
                    goto_row[col] = next_state

            rows.append({
                "state": state_idx,
                "action": action_row,
                "goto": goto_row,
            })

        follow_data = {}
        for nt, follow_set in getattr(table, "follow", {}).items():
            follow_data[nt] = sorted(list(follow_set))

        return {
            "action_headers": action_headers,
            "goto_headers": goto_headers,
            "rows": rows,
            "follow": follow_data,
        }

    if action == "yaparGenerate":
        yapar_path_raw = payload.get("yaparPath")
        yapar_source_raw = payload.get("yaparSource")
        output_path_raw = payload.get("outputPath")

        if not output_path_raw:
            raise ValueError("Para generar parser debe enviar 'outputPath'")

        if yapar_source_raw is not None:
            source = str(yapar_source_raw)
        elif yapar_path_raw:
            source = _read_text_from_payload_path(yapar_path_raw, label="yaparPath")
        else:
            raise ValueError("Debe enviar 'yaparPath' o 'yaparSource'")

        spec = parse_yapar(source)
        automaton = build_lr0_automaton(spec)
        table = LRTable(automaton, spec)

        output_path = _normalize_path(output_path_raw)
        code = generate_parser(table, spec, output_path=output_path)
        return {
            "outputPath": str(output_path),
            "bytes": len(code.encode("utf-8")),
        }

    if action == "yaparParse":
        yapar_path_raw = payload.get("yaparPath")
        yapar_source_raw = payload.get("yaparSource")
        input_text_raw = payload.get("inputText")
        input_path_raw = payload.get("inputPath")

        if input_text_raw is not None:
            input_text = str(input_text_raw)
        elif input_path_raw:
            input_text = _read_text_from_payload_path(input_path_raw, label="inputPath")
        else:
            raise ValueError("Debe enviar 'inputPath' o 'inputText' para parsear")

        # 1. Parse grammar
        if yapar_source_raw is not None:
            yapar_source = str(yapar_source_raw)
        elif yapar_path_raw:
            yapar_source = _read_text_from_payload_path(yapar_path_raw, label="yaparPath")
        else:
            raise ValueError("Debe enviar 'yaparPath' o 'yaparSource'")

        grammar = parse_yapar(yapar_source)
        automaton = build_lr0_automaton(grammar)
        table = LRTable(automaton, grammar)

        # 2. Tokenize input text using YALex spec
        yal_path_raw = payload.get("yalPath")
        yal_source_raw = payload.get("yalSource")

        if yal_source_raw is not None:
            yal_source = str(yal_source_raw)
        elif yal_path_raw:
            yal_source = _read_text_from_payload_path(yal_path_raw, label="yalPath")
        else:
            raise ValueError("Debe enviar 'yalPath' o 'yalSource' para tokenizar")

        spec_yal, direct_yal, dfa_yal = _build_pipeline_from_source(yal_source)
        table_yal = dfa_to_table(dfa_yal)

        tokens, errors_yal, _ = tokenize_with_trace(
            input_text,
            table_yal["start"],
            table_yal["accept"],
            table_yal["table"],
            include_trace=False,
        )

        if errors_yal:
            lexical_errors = [f"Error léxico: {err.message} en L{err.line}:C{err.col}" for err in errors_yal]
            return {
                "success": False,
                "tokens": [_to_json_ready_token(t) for t in tokens],
                "errors": lexical_errors,
                "trace": [],
            }

        # 3. Simulate SLR parsing step by step
        @dataclass
        class SimToken:
            type: str
            lexeme: str
            line: int
            col: int

            def __post_init__(self):
                self.type = str(self.type)
                self.lexeme = str(self.lexeme)
                self.line = int(self.line)
                self.col = int(self.col)

        sim_tokens = [SimToken(t.type, t.lexeme, t.line, t.col) for t in tokens]
        sim_tokens.append(SimToken("$", "", 0, 0)) # Add EOF marker

        stack = [0]
        value_stack = [] # Symbol stack
        token_idx = 0
        trace = []
        errors = []
        success = False

        while True:
            state = stack[-1]
            token = sim_tokens[token_idx]
            lookahead = token.type

            action_type, action_arg = table.get_action(state, lookahead)

            # Capture trace step
            step_trace = {
                "step": len(trace) + 1,
                "state_stack": list(stack),
                "symbol_stack": list(value_stack),
                "lookahead": {
                    "type": token.type,
                    "lexeme": token.lexeme,
                    "line": token.line,
                    "col": token.col,
                },
                "action": action_type,
                "action_arg": "",
            }

            if action_type == "shift":
                step_trace["action_arg"] = f"Shift s{action_arg}"
                trace.append(step_trace)
                stack.append(action_arg)
                value_stack.append(token.type)
                token_idx += 1

            elif action_type == "reduce":
                prod = grammar.productions[action_arg - 1]
                prod_str = f"{prod.lhs} -> {' '.join(prod.rhs) if prod.rhs else 'ε'}"
                step_trace["action_arg"] = f"Reduce {prod_str}"
                trace.append(step_trace)

                rhs_len = len(prod.rhs)
                if rhs_len > 0:
                    stack = stack[:-rhs_len]
                    value_stack = value_stack[:-rhs_len]

                state = stack[-1]
                next_state = table.get_goto(state, prod.lhs)
                if next_state == -1:
                    errors.append(f"Error de análisis sintáctico: GOTO indefinido para estado {state} y símbolo {prod.lhs}")
                    break

                stack.append(next_state)
                value_stack.append(prod.lhs)

            elif action_type == "accept":
                step_trace["action_arg"] = "Aceptar (Accept)"
                trace.append(step_trace)
                success = True
                break

            elif action_type == "error":
                step_trace["action_arg"] = "Error"
                trace.append(step_trace)
                errors.append(f"Error sintáctico al leer token '{token.type}' ({repr(token.lexeme)}) en L{token.line}:C{token.col}")
                break

            else:
                step_trace["action_arg"] = f"Acción desconocida: {action_type}"
                trace.append(step_trace)
                errors.append(f"Acción desconocida en tabla SLR: {action_type}")
                break

        return {
            "success": success,
            "tokens": [_to_json_ready_token(t) for t in tokens],
            "trace": trace,
            "errors": errors,
        }

    raise ValueError(f"Acción no soportada: {action}")


def main() -> int:
    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
        if not raw.strip():
            raise ValueError("Request vacío en stdin")
        payload = json.loads(raw)
        # Extract inputPath for diagnosis if present
        input_path_raw = payload.get("inputPath")
        if input_path_raw is not None:
            print(f"[DEBUG inputPath repr]: {repr(input_path_raw)}", file=sys.stderr)
        result = _run_action(payload)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
